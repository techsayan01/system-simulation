import {
  resolveComponent,
  type Design,
  type Primitive,
  type Registry,
  type Scenario,
} from '@sim/model';
import { compileDist } from './dist.ts';
import { canonicalJson, hash64 } from './hash.ts';
import { loadMultiplier, maxMultiplier } from './load.ts';
import { Rng } from './rng.ts';
import {
  ClassRt,
  EdgeRt,
  Faults,
  LlmRt,
  LoopRt,
  RouterRt,
  Sim,
  StationRt,
  type AgentKey,
  type Ctx,
  type EdgeKey,
  type LimitDim,
  type NodeKey,
  type NodeRt,
} from './runtime.ts';

export const ENGINE_VERSION = '0.1.0';

export interface RunOptions {
  seed: number;
  /** Stop the run (and mark it truncated) after this many events. */
  eventBudget?: number;
}

type Series = number[];
type LatencySeries = (number | null)[];

export interface NodeResult {
  type: string;
  primitive: Primitive;
  series: Record<NodeKey, Series> & { p50: LatencySeries; p95: LatencySeries; p99: LatencySeries };
  rate_limited_by_dim?: Record<LimitDim, Series>;
  /** Requests and tokens that arrived at an LLM provider per window, including retries and rejected ones. */
  demand_by_dim?: Record<LimitDim, Series>;
  limits?: Record<LimitDim, number | null>;
  agent?: Record<AgentKey, Series> & { runaway_threshold: number };
  totals: { arrivals: number; ok: number; latency_mean_ms: number | null };
}

export interface EdgeResult {
  from: string;
  to: string;
  /** True for the edge from a traffic class's client to its entry component. */
  client: boolean;
  has_retry: boolean;
  max_retries: number;
  series: Record<EdgeKey, Series>;
}

export interface ClassResult {
  base_rps: number;
  offered: Series;
  ok: Series;
  failed: Series;
  cost: Series;
  p50: LatencySeries;
  p95: LatencySeries;
  p99: LatencySeries;
}

export interface RunResult {
  meta: {
    run_id: string;
    engine_version: string;
    design_id: string;
    scenario_id: string;
    seed: number;
    duration_s: number;
    window_s: number;
    windows: number;
    events: number;
    truncated: boolean;
    base_rps: number;
  };
  /** Load multiplier at the middle of each window. */
  load: Series;
  classes: Record<string, ClassResult>;
  nodes: Record<string, NodeResult>;
  edges: Record<string, EdgeResult>;
  totals: {
    requests: number;
    ok: number;
    failed: number;
    cost_usd: number;
    cost_per_success_usd: number | null;
  };
}

/** Identity of a run: same inputs, same id, same results. */
export function runId(design: Design, registry: Registry, scenario: Scenario, seed: number): string {
  return hash64(
    canonicalJson({ engine: ENGINE_VERSION, types: registry.fingerprint(), design, scenario, seed }),
  );
}

/** Simulate one scenario against a design. Pure and deterministic for a given seed. */
export function runScenario(design: Design, registry: Registry, scenario: Scenario, opts: RunOptions): RunResult {
  const { seed } = opts;
  const budget = opts.eventBudget ?? 40_000_000;
  const sim = new Sim();
  const ctx: Ctx = { sim, faults: new Faults(scenario.faults), cost: { total: 0 } };

  const nodes = new Map<string, NodeRt>();
  for (const c of design.components) {
    const r = resolveComponent(c, registry);
    const rng = new Rng(seed, `node:${c.id}`);
    let node: NodeRt;
    switch (r.primitive) {
      case 'station':
        node = new StationRt(c.id, c.type, ctx, rng, r.params, compileDist(r.params.service_time_ms));
        break;
      case 'router':
        node = new RouterRt(c.id, c.type, ctx, rng, r.params.strategy);
        break;
      case 'llm':
        node = new LlmRt(c.id, c.type, ctx, rng, r.params, compileDist(r.params.ttft_ms));
        break;
      case 'loop':
        node = new LoopRt(
          c.id,
          c.type,
          ctx,
          rng,
          r.params,
          compileDist(r.params.step_overhead_ms),
          compileDist(r.params.step_output_tokens),
        );
        break;
    }
    nodes.set(c.id, node);
  }

  const edges = new Map<string, EdgeRt>();
  const edgeIsClient = new Map<string, boolean>();
  for (const call of design.calls) {
    let id = `${call.from}->${call.to}`;
    for (let n = 2; edges.has(id); n++) id = `${call.from}->${call.to}#${n}`;
    const edge = new EdgeRt(id, call.from, nodes.get(call.to)!, call.on_error, call.weight, call.policy, new Rng(seed, `edge:${id}`));
    edges.set(id, edge);
    edgeIsClient.set(id, false);
    const from = nodes.get(call.from)!;
    (call.per === 'step' ? from.stepOut : from.out).push(edge);
  }

  const classes: ClassRt[] = [];
  for (const cls of design.traffic.classes) {
    const id = `client(${cls.id})->${cls.entry}`;
    const edge = new EdgeRt(id, `client(${cls.id})`, nodes.get(cls.entry)!, 'fail', 1, cls.client, new Rng(seed, `edge:${id}`));
    edges.set(id, edge);
    edgeIsClient.set(id, true);
    classes.push(
      new ClassRt(
        cls.id,
        cls.arrival.rate_rps,
        edge,
        ctx,
        new Rng(seed, `class:${cls.id}`),
        compileDist(cls.attrs.input_tokens ?? 0),
        compileDist(cls.attrs.output_tokens ?? 0),
      ),
    );
  }

  const windowUs = 1_000_000;
  const windows = Math.ceil(scenario.duration_s);
  const endUs = windows * windowUs;
  const load: number[] = [];
  const mult = (tS: number) => loadMultiplier(scenario.load, tS);
  for (const cls of classes) cls.start(mult, maxMultiplier(scenario.load), endUs);
  for (let w = 0; w < windows; w++) {
    sim.at((w + 1) * windowUs, () => {
      load.push(Math.round(mult(w + 0.5) * 1e6) / 1e6);
      for (const n of nodes.values()) n.flush(windowUs);
      for (const e of edges.values()) e.m.flush();
      for (const c of classes) c.flush();
    });
  }
  const truncated = sim.run(endUs, budget);

  const nodeResults: Record<string, NodeResult> = {};
  for (const [id, n] of nodes) {
    const r = resolveComponent(design.components.find((c) => c.id === id)!, registry);
    const res: NodeResult = {
      type: n.typeId,
      primitive: r.primitive,
      series: { ...n.m.series, p50: n.lat.p50, p95: n.lat.p95, p99: n.lat.p99 },
      totals: {
        arrivals: n.m.series.arrivals.reduce((a, b) => a + b, 0),
        ok: n.lat.count,
        latency_mean_ms: n.lat.count ? Math.round((n.lat.sum / n.lat.count) * 1e6) / 1e6 : null,
      },
    };
    if (n instanceof LlmRt) {
      res.rate_limited_by_dim = n.rateLimited.series;
      res.demand_by_dim = n.demand.series;
      res.limits = n.limits;
    }
    if (n instanceof LoopRt) res.agent = { ...n.agent.series, runaway_threshold: n.threshold };
    nodeResults[id] = res;
  }

  const edgeResults: Record<string, EdgeResult> = {};
  for (const [id, e] of edges) {
    edgeResults[id] = {
      from: e.from,
      to: e.to.id,
      client: edgeIsClient.get(id)!,
      has_retry: e.retry !== null,
      max_retries: e.retry?.max ?? 0,
      series: e.m.series,
    };
  }

  const classResults: Record<string, ClassResult> = {};
  let requests = 0;
  let ok = 0;
  let failed = 0;
  for (const c of classes) {
    classResults[c.id] = {
      base_rps: c.baseRps,
      offered: c.m.series.offered,
      ok: c.m.series.ok,
      failed: c.m.series.failed,
      cost: c.m.series.cost,
      p50: c.lat.p50,
      p95: c.lat.p95,
      p99: c.lat.p99,
    };
    requests += c.created;
    ok += c.succeeded;
    failed += c.failedTotal;
  }

  const cost = Math.round(ctx.cost.total * 1e6) / 1e6;
  return {
    meta: {
      run_id: runId(design, registry, scenario, seed),
      engine_version: ENGINE_VERSION,
      design_id: design.design.id,
      scenario_id: scenario.id,
      seed,
      duration_s: scenario.duration_s,
      window_s: 1,
      windows: load.length,
      events: sim.events,
      truncated,
      base_rps: design.traffic.classes.reduce((s, c) => s + c.arrival.rate_rps, 0),
    },
    load,
    classes: classResults,
    nodes: nodeResults,
    edges: edgeResults,
    totals: {
      requests,
      ok,
      failed,
      cost_usd: cost,
      cost_per_success_usd: ok ? Math.round((cost / ok) * 1e6) / 1e6 : null,
    },
  };
}
