import type { CallPolicy, ErrorKind, Fault, LlmParams, LoopParams, RetryPolicy } from '@sim/model';
import { EventHeap } from './heap.ts';
import type { Rng } from './rng.ts';
import type { Sampler } from './dist.ts';

/** Simulated time is in integer microseconds. */
export const usFromMs = (msv: number): number => Math.max(0, Math.round(msv * 1000));

export type Result = { ok: true } | { ok: false; kind: ErrorKind };
const OK: Result = { ok: true };
const fail = (kind: ErrorKind): Result => ({ ok: false, kind });

export interface Attrs {
  input_tokens: number;
  output_tokens: number;
}

export interface Root {
  cls: ClassRt;
  start: number;
  cost: number;
}

export interface Job {
  root: Root;
  attrs: Attrs;
  arrived: number;
  reply: (r: Result) => void;
}

// ---------------------------------------------------------------- scheduler

export class Sim {
  now = 0;
  events = 0;
  private seq = 0;
  private readonly heap = new EventHeap();

  at(t: number, fn: () => void): void {
    this.heap.push({ t, seq: this.seq++, fn });
  }

  after(dt: number, fn: () => void): void {
    this.at(this.now + dt, fn);
  }

  /** Run events up to and including time `end`. Returns true if the event budget cut the run short. */
  run(end: number, budget: number): boolean {
    while (this.heap.peekTime() <= end) {
      if (this.events >= budget) return true;
      const e = this.heap.pop()!;
      this.now = e.t;
      this.events++;
      e.fn();
    }
    return false;
  }
}

// ---------------------------------------------------------------- metrics

const round6 = (x: number) => Math.round(x * 1e6) / 1e6;

export class Counters<K extends string> {
  readonly cur = {} as Record<K, number>;
  readonly series = {} as Record<K, number[]>;

  constructor(readonly keys: readonly K[]) {
    for (const k of keys) {
      this.cur[k] = 0;
      this.series[k] = [];
    }
  }

  add(k: K, v = 1): void {
    this.cur[k] += v;
  }

  max(k: K, v: number): void {
    if (v > this.cur[k]) this.cur[k] = v;
  }

  set(k: K, v: number): void {
    this.cur[k] = v;
  }

  flush(): void {
    for (const k of this.keys) {
      this.series[k].push(round6(this.cur[k]));
      this.cur[k] = 0;
    }
  }
}

export class LatencyWindow {
  private cur: number[] = [];
  readonly p50: (number | null)[] = [];
  readonly p95: (number | null)[] = [];
  readonly p99: (number | null)[] = [];
  sum = 0;
  count = 0;

  add(msv: number): void {
    this.cur.push(msv);
    this.sum += msv;
    this.count++;
  }

  flush(): void {
    if (!this.cur.length) {
      this.p50.push(null);
      this.p95.push(null);
      this.p99.push(null);
      return;
    }
    const s = this.cur.sort((a, b) => a - b);
    const q = (p: number) => round6(s[Math.max(0, Math.ceil(p * s.length) - 1)]!);
    this.p50.push(q(0.5));
    this.p95.push(q(0.95));
    this.p99.push(q(0.99));
    this.cur = [];
  }
}

// ---------------------------------------------------------------- faults

export class Faults {
  private readonly byTarget = new Map<string, Fault[]>();

  constructor(faults: Fault[]) {
    for (const f of faults) this.byTarget.set(f.target, [...(this.byTarget.get(f.target) ?? []), f]);
  }

  private active(id: string, tS: number): Fault[] {
    const fs = this.byTarget.get(id);
    return fs ? fs.filter((f) => tS >= f.from_s && tS < f.to_s) : [];
  }

  errorRate(id: string, base: number, tS: number): number {
    let r = base;
    for (const f of this.active(id, tS)) if (f.kind === 'error_rate') r = Math.max(r, f.value);
    return r;
  }

  slowdown(id: string, tS: number): number {
    let s = 1;
    for (const f of this.active(id, tS)) if (f.kind === 'slowdown') s *= f.factor;
    return s;
  }

  limitScale(id: string, tS: number): number {
    let s = 1;
    for (const f of this.active(id, tS)) if (f.kind === 'limit_scale') s *= f.factor;
    return s;
  }
}

export interface Ctx {
  sim: Sim;
  faults: Faults;
  /** Total LLM spend so far, in USD. */
  cost: { total: number };
}

const nowS = (ctx: Ctx) => ctx.sim.now / 1e6;

// ---------------------------------------------------------------- calls

export const EDGE_KEYS = ['first', 'attempts', 'retries', 'timeouts', 'ok', 'failed', 'late'] as const;
export type EdgeKey = (typeof EDGE_KEYS)[number];

export class EdgeRt {
  readonly m = new Counters(EDGE_KEYS);
  readonly timeoutUs: number | null;
  readonly retry: RetryPolicy | null;
  readonly retryOn: Set<ErrorKind>;

  constructor(
    readonly id: string,
    readonly from: string,
    readonly to: NodeRt,
    readonly onError: 'fail' | 'replan' | 'ignore',
    readonly weight: number,
    policy: CallPolicy | undefined,
    private readonly rng: Rng,
  ) {
    this.timeoutUs = policy?.timeout_ms !== undefined ? usFromMs(policy.timeout_ms) : null;
    this.retry = policy?.retry && policy.retry.max > 0 ? policy.retry : null;
    this.retryOn = new Set(policy?.retry?.on ?? ['rejected', 'rate_limited', 'error', 'timeout', 'dependency']);
  }

  backoffUs(attempt: number): number {
    const r = this.retry!;
    let d = 0;
    if (r.backoff === 'constant') d = r.base_ms;
    else if (r.backoff === 'exponential') d = Math.min(r.max_ms, r.base_ms * 2 ** (attempt - 1));
    if (r.jitter) d *= this.rng.next();
    return usFromMs(d);
  }
}

/**
 * Call `edge.to` with the edge's timeout and retry policy. A timed-out attempt is abandoned
 * by the caller but keeps consuming capacity at the callee, as in most real systems.
 */
export function invoke(ctx: Ctx, edge: EdgeRt, root: Root, attrs: Attrs, done: (r: Result) => void): void {
  const sim = ctx.sim;
  let attempt = 0;
  edge.m.add('first');
  const onResult = (r: Result) => {
    if (r.ok) {
      edge.m.add('ok');
      done(r);
      return;
    }
    if (edge.retry && attempt <= edge.retry.max && edge.retryOn.has(r.kind)) {
      sim.after(edge.backoffUs(attempt), tryOnce);
      return;
    }
    edge.m.add('failed');
    done(r);
  };
  const tryOnce = () => {
    attempt++;
    edge.m.add('attempts');
    if (attempt > 1) edge.m.add('retries');
    let settled = false;
    const job: Job = {
      root,
      attrs,
      arrived: sim.now,
      reply: (r) => {
        if (settled) {
          edge.m.add('late');
          return;
        }
        settled = true;
        onResult(r);
      },
    };
    if (edge.timeoutUs !== null) {
      sim.after(edge.timeoutUs, () => {
        if (settled) return;
        settled = true;
        edge.m.add('timeouts');
        onResult(fail('timeout'));
      });
    }
    edge.to.accept(job);
  };
  tryOnce();
}

/** Run calls one after another. A failing `fail` call stops the sequence with a dependency error. */
function runSequence(
  ctx: Ctx,
  edges: EdgeRt[],
  root: Root,
  attrs: Attrs,
  cb: (r: Result, replanned: boolean) => void,
): void {
  let i = 0;
  let replanned = false;
  const next = () => {
    const e = edges[i++];
    if (!e) {
      cb(OK, replanned);
      return;
    }
    invoke(ctx, e, root, attrs, (r) => {
      if (!r.ok) {
        if (e.onError === 'fail') {
          cb(fail('dependency'), replanned);
          return;
        }
        if (e.onError === 'replan') replanned = true;
      }
      next();
    });
  };
  next();
}

// ---------------------------------------------------------------- components

export const NODE_KEYS = [
  'arrivals',
  'ok',
  'errors',
  'rejected',
  'rate_limited',
  'queue',
  'inflight',
  'utilization',
  'cost',
  'tokens_in',
  'tokens_out',
] as const;
export type NodeKey = (typeof NODE_KEYS)[number];

export abstract class NodeRt {
  readonly m = new Counters(NODE_KEYS);
  readonly lat = new LatencyWindow();
  /** Calls made once per job. */
  readonly out: EdgeRt[] = [];
  /** Calls made once per agent-loop step. */
  readonly stepOut: EdgeRt[] = [];

  constructor(
    readonly id: string,
    readonly typeId: string,
    protected readonly ctx: Ctx,
    protected readonly rng: Rng,
  ) {}

  abstract accept(job: Job): void;

  protected reply(job: Job, r: Result): void {
    this.ctx.sim.after(0, () => job.reply(r));
  }

  /** Called at each window boundary before counters are flushed. */
  sample(_windowUs: number): void {}

  flush(windowUs: number): void {
    this.sample(windowUs);
    this.m.flush();
    this.lat.flush();
  }
}

export interface StationConfig {
  concurrency: number | null;
  queue_limit: number | null;
  error_rate: number;
}

export class StationRt extends NodeRt {
  protected busy = 0;
  private q: Job[] = [];
  private qh = 0;
  private area = 0;
  private lastT = 0;
  protected readonly conc: number;

  constructor(
    id: string,
    typeId: string,
    ctx: Ctx,
    rng: Rng,
    protected readonly cfg: StationConfig,
    private readonly svc: Sampler | null,
  ) {
    super(id, typeId, ctx, rng);
    this.conc = cfg.concurrency ?? Infinity;
  }

  get queueLength(): number {
    return this.q.length - this.qh;
  }

  accept(job: Job): void {
    this.m.add('arrivals');
    job.arrived = this.ctx.sim.now;
    if (this.busy < this.conc) this.begin(job);
    else if (this.cfg.queue_limit !== null && this.queueLength >= this.cfg.queue_limit) {
      this.m.add('rejected');
      this.reply(job, fail('rejected'));
    } else this.q.push(job);
  }

  private setBusy(delta: number): void {
    const now = this.ctx.sim.now;
    this.area += this.busy * (now - this.lastT);
    this.lastT = now;
    this.busy += delta;
  }

  private begin(job: Job): void {
    this.setBusy(1);
    this.work(job);
  }

  protected errorRate(): number {
    return this.ctx.faults.errorRate(this.id, this.cfg.error_rate, nowS(this.ctx));
  }

  protected slowdown(): number {
    return this.ctx.faults.slowdown(this.id, nowS(this.ctx));
  }

  /** Service time, then the downstream calls in order. The worker slot is held throughout. */
  protected work(job: Job): void {
    const dt = usFromMs(this.serviceMs(job) * this.slowdown());
    this.ctx.sim.after(dt, () => {
      if (this.rng.next() < this.errorRate()) {
        this.finish(job, fail('error'));
        return;
      }
      runSequence(this.ctx, this.out, job.root, job.attrs, (r) => this.finish(job, r));
    });
  }

  protected serviceMs(_job: Job): number {
    return this.svc!(this.rng);
  }

  protected onFinish(_job: Job, _r: Result): void {}

  protected finish(job: Job, r: Result): void {
    this.setBusy(-1);
    if (r.ok) {
      this.m.add('ok');
      this.lat.add((this.ctx.sim.now - job.arrived) / 1000);
    } else this.m.add('errors');
    this.onFinish(job, r);
    this.reply(job, r);
    if (this.queueLength > 0 && this.busy < this.conc) {
      const next = this.q[this.qh++]!;
      if (this.qh > 4096 && this.qh * 2 > this.q.length) {
        this.q = this.q.slice(this.qh);
        this.qh = 0;
      }
      this.begin(next);
    }
  }

  override sample(windowUs: number): void {
    this.setBusy(0);
    const inflight = this.area / windowUs;
    this.m.set('queue', this.queueLength);
    this.m.set('inflight', inflight);
    this.m.set('utilization', Number.isFinite(this.conc) ? inflight / this.conc : 0);
    this.area = 0;
  }
}

export class RouterRt extends NodeRt {
  private next = 0;

  constructor(
    id: string,
    typeId: string,
    ctx: Ctx,
    rng: Rng,
    private readonly strategy: 'round_robin' | 'random',
  ) {
    super(id, typeId, ctx, rng);
  }

  private pick(): EdgeRt {
    if (this.strategy === 'round_robin') return this.out[this.next++ % this.out.length]!;
    const total = this.out.reduce((s, e) => s + e.weight, 0);
    let x = this.rng.next() * total;
    for (const e of this.out) {
      x -= e.weight;
      if (x <= 0) return e;
    }
    return this.out[this.out.length - 1]!;
  }

  accept(job: Job): void {
    this.m.add('arrivals');
    const arrived = this.ctx.sim.now;
    if (this.rng.next() < this.ctx.faults.errorRate(this.id, 0, nowS(this.ctx))) {
      this.m.add('errors');
      this.reply(job, fail('error'));
      return;
    }
    invoke(this.ctx, this.pick(), job.root, job.attrs, (r) => {
      if (r.ok) {
        this.m.add('ok');
        this.lat.add((this.ctx.sim.now - arrived) / 1000);
      } else this.m.add('errors');
      this.reply(job, r);
    });
  }
}

export const LIMIT_DIMS = ['requests_per_min', 'input_tokens_per_min', 'output_tokens_per_min'] as const;
export type LimitDim = (typeof LIMIT_DIMS)[number];

interface Bucket {
  dim: LimitDim;
  limit: number | null;
  tokens: number;
  need: (job: Job) => number;
}

export class LlmRt extends StationRt {
  readonly rateLimited = new Counters(LIMIT_DIMS);
  /** Everything that arrived (accepted or not), per limit dimension: the load the limits must absorb. */
  readonly demand = new Counters(LIMIT_DIMS);
  private readonly buckets: Bucket[];
  private lastRefill = 0;

  constructor(
    id: string,
    typeId: string,
    ctx: Ctx,
    rng: Rng,
    private readonly p: LlmParams,
    private readonly ttft: Sampler,
  ) {
    super(id, typeId, ctx, rng, { concurrency: p.max_concurrency, queue_limit: null, error_rate: p.error_rate }, null);
    this.buckets = [
      { dim: 'requests_per_min', limit: p.rpm, tokens: p.rpm ?? 0, need: () => 1 },
      { dim: 'input_tokens_per_min', limit: p.itpm, tokens: p.itpm ?? 0, need: (j) => j.attrs.input_tokens },
      // Providers reserve the expected output when the request is admitted.
      { dim: 'output_tokens_per_min', limit: p.otpm, tokens: p.otpm ?? 0, need: (j) => j.attrs.output_tokens },
    ];
  }

  private refill(): void {
    const now = this.ctx.sim.now;
    const scale = this.ctx.faults.limitScale(this.id, nowS(this.ctx));
    const dt = now - this.lastRefill;
    this.lastRefill = now;
    for (const b of this.buckets) {
      if (b.limit === null) continue;
      const cap = b.limit * scale;
      b.tokens = Math.min(cap, b.tokens + (cap / 60e6) * dt);
    }
  }

  get limits(): Record<LimitDim, number | null> {
    return { requests_per_min: this.p.rpm, input_tokens_per_min: this.p.itpm, output_tokens_per_min: this.p.otpm };
  }

  override accept(job: Job): void {
    this.refill();
    for (const b of this.buckets) this.demand.add(b.dim, b.need(job));
    const blocked = this.buckets.find((b) => b.limit !== null && b.tokens < b.need(job));
    if (blocked) {
      this.m.add('arrivals');
      this.m.add('rate_limited');
      this.rateLimited.add(blocked.dim);
      const rpm = this.buckets[0]!;
      if (this.p.count_rejected_toward_rpm && rpm.limit !== null && rpm.tokens >= 1) rpm.tokens -= 1;
      this.reply(job, fail('rate_limited'));
      return;
    }
    for (const b of this.buckets) if (b.limit !== null) b.tokens -= b.need(job);
    super.accept(job);
  }

  protected override serviceMs(job: Job): number {
    return this.ttft(this.rng) + (job.attrs.output_tokens / this.p.output_tps) * 1000;
  }

  /** The provider bills completed generations, even when the caller has already given up. */
  protected override onFinish(job: Job, r: Result): void {
    if (!r.ok) return;
    const cost =
      (job.attrs.input_tokens * this.p.price_input_per_mtok + job.attrs.output_tokens * this.p.price_output_per_mtok) / 1e6;
    job.root.cost += cost;
    job.root.cls.m.add('cost', cost);
    this.ctx.cost.total += cost;
    this.m.add('cost', cost);
    this.m.add('tokens_in', job.attrs.input_tokens);
    this.m.add('tokens_out', job.attrs.output_tokens);
  }

  override flush(windowUs: number): void {
    super.flush(windowUs);
    this.rateLimited.flush();
    this.demand.flush();
  }
}

export const AGENT_KEYS = [
  'active',
  'runaway_active',
  'max_active_steps',
  'completed',
  'steps_sum',
  'max_completed_steps',
  'capped',
  'budget_stopped',
] as const;
export type AgentKey = (typeof AGENT_KEYS)[number];

/** Steps above which a running agent invocation counts as runaway. */
export function runawayThreshold(stepsMean: number): number {
  return Math.max(25, Math.ceil(8 * stepsMean));
}

interface Invocation {
  steps: number;
  startCost: number;
}

export class LoopRt extends StationRt {
  readonly agent = new Counters(AGENT_KEYS);
  private readonly active = new Set<Invocation>();
  readonly threshold: number;

  constructor(
    id: string,
    typeId: string,
    ctx: Ctx,
    rng: Rng,
    private readonly p: LoopParams,
    private readonly overhead: Sampler,
    private readonly stepOutput: Sampler,
  ) {
    super(id, typeId, ctx, rng, { concurrency: p.concurrency, queue_limit: p.queue_limit, error_rate: p.error_rate }, null);
    this.threshold = runawayThreshold(p.steps_mean);
  }

  protected override work(job: Job): void {
    const inv: Invocation = { steps: 0, startCost: job.root.cost };
    this.active.add(inv);
    const done = (r: Result, reason?: 'capped' | 'budget_stopped') => {
      this.active.delete(inv);
      this.agent.add('completed');
      this.agent.add('steps_sum', inv.steps);
      this.agent.max('max_completed_steps', inv.steps);
      if (reason) this.agent.add(reason);
      this.finish(job, r);
    };
    const step = () => {
      inv.steps++;
      this.ctx.sim.after(usFromMs(this.overhead(this.rng) * this.slowdown()), () => {
        if (this.rng.next() < this.errorRate()) {
          done(fail('error'));
          return;
        }
        const attrs: Attrs = {
          input_tokens: job.attrs.input_tokens + (inv.steps - 1) * this.p.context_growth_tokens_per_step,
          output_tokens: Math.max(1, Math.round(this.stepOutput(this.rng))),
        };
        runSequence(this.ctx, this.stepOut, job.root, attrs, (r, replanned) => {
          if (!r.ok) return done(r);
          if (!replanned && this.rng.next() < 1 / this.p.steps_mean) return done(OK);
          if (this.p.loop_cap !== null && inv.steps >= this.p.loop_cap) return done(OK, 'capped');
          if (this.p.budget_cap_usd !== null && job.root.cost - inv.startCost >= this.p.budget_cap_usd) {
            return done(OK, 'budget_stopped');
          }
          step();
        });
      });
    };
    if (this.out.length) {
      runSequence(this.ctx, this.out, job.root, job.attrs, (r) => (r.ok ? step() : done(r)));
    } else step();
  }

  override sample(windowUs: number): void {
    super.sample(windowUs);
    let runaway = 0;
    let maxSteps = 0;
    for (const inv of this.active) {
      if (inv.steps > this.threshold) runaway++;
      if (inv.steps > maxSteps) maxSteps = inv.steps;
    }
    this.agent.set('active', this.active.size);
    this.agent.set('runaway_active', runaway);
    this.agent.set('max_active_steps', maxSteps);
  }

  override flush(windowUs: number): void {
    super.flush(windowUs);
    this.agent.flush();
  }
}

// ---------------------------------------------------------------- traffic

export const CLASS_KEYS = ['offered', 'ok', 'failed', 'cost'] as const;

export class ClassRt {
  readonly m = new Counters(CLASS_KEYS);
  readonly lat = new LatencyWindow();
  created = 0;
  succeeded = 0;
  failedTotal = 0;

  constructor(
    readonly id: string,
    readonly baseRps: number,
    readonly edge: EdgeRt,
    private readonly ctx: Ctx,
    private readonly rng: Rng,
    private readonly inputTokens: Sampler,
    private readonly outputTokens: Sampler,
  ) {}

  /** Non-homogeneous Poisson arrivals by thinning against the peak rate. */
  start(mult: (tS: number) => number, maxMult: number, endUs: number): void {
    const sim = this.ctx.sim;
    const peak = this.baseRps * maxMult;
    const meanGapUs = 1e6 / peak;
    const schedule = () => {
      const t = sim.now + Math.max(1, Math.round(this.rng.exponential(meanGapUs)));
      if (t >= endUs) return;
      sim.at(t, () => {
        if (this.rng.next() * maxMult < mult(sim.now / 1e6)) this.arrive();
        schedule();
      });
    };
    schedule();
  }

  private arrive(): void {
    const sim = this.ctx.sim;
    const root: Root = { cls: this, start: sim.now, cost: 0 };
    this.created++;
    this.m.add('offered');
    const attrs: Attrs = {
      input_tokens: Math.round(this.inputTokens(this.rng)),
      output_tokens: Math.round(this.outputTokens(this.rng)),
    };
    invoke(this.ctx, this.edge, root, attrs, (r) => {
      if (r.ok) {
        this.succeeded++;
        this.m.add('ok');
        this.lat.add((sim.now - root.start) / 1000);
      } else {
        this.failedTotal++;
        this.m.add('failed');
      }
    });
  }

  flush(): void {
    this.m.flush();
    this.lat.flush();
  }
}
