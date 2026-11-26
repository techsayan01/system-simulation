import type { Design, Primitive, Registry } from '@sim/model';
import { resolveComponent } from '@sim/model';
import { buildModel, type Model } from './run.ts';
import { Faults, LlmRt, LoopRt, Sim, StationRt, type Ctx, type FaultOverride } from './runtime.ts';

export type { FaultOverride } from './runtime.ts';

export interface LiveNodeState {
  id: string;
  type: string;
  primitive: Primitive;
  /** Worker slots, or null when unlimited. */
  concurrency: number | null;
  /** Values over the last completed 1 s window. */
  utilization: number;
  arrivals: number;
  ok: number;
  errors: number;
  rejected: number;
  rate_limited: number;
  p99_ms: number | null;
  cost: number;
  /** Instantaneous. */
  queue: number;
  busy: number;
  agent?: { active: number; runaway: number; max_steps: number; threshold: number };
  history: { utilization: number[]; arrivals: number[]; failures: number[]; queue: number[] };
}

export interface LiveEdgeState {
  id: string;
  from: string;
  to: string;
  client: boolean;
  attempts: number;
  first: number;
  retries: number;
  timeouts: number;
  failed: number;
  ok: number;
}

export interface LiveClassState {
  id: string;
  offered: number;
  ok: number;
  failed: number;
  p99_ms: number | null;
  history: { offered: number[]; ok: number[] };
}

export interface LiveSnapshot {
  time_s: number;
  load: number;
  /** True when the simulation could not keep up with the requested speed. */
  lagging: boolean;
  nodes: Record<string, LiveNodeState>;
  edges: Record<string, LiveEdgeState>;
  classes: Record<string, LiveClassState>;
  totals: { offered: number; ok: number; failed: number; p99_ms: number | null; cost_per_min: number; cost_total: number };
}

const last = (xs: number[]) => (xs.length ? xs[xs.length - 1]! : 0);
const lastN = (xs: readonly (number | null)[], n: number) => xs.slice(Math.max(0, xs.length - n));

/**
 * A simulation that advances in small steps and accepts changes while it runs: traffic
 * multiplier and per-component faults. Changing the design itself means building a new one.
 */
export class LiveSim {
  private readonly sim = new Sim();
  private readonly ctx: Ctx;
  private readonly model: Model;
  private readonly primitives = new Map<string, Primitive>();
  private load = 1;
  private lagging = false;
  private target = 0;

  constructor(
    readonly design: Design,
    registry: Registry,
    seed = 1,
  ) {
    this.ctx = { sim: this.sim, faults: new Faults([]), cost: { total: 0 } };
    this.model = buildModel(design, registry, this.ctx, seed);
    for (const c of design.components) this.primitives.set(c.id, resolveComponent(c, registry).primitive);
    const tick = () => {
      for (const n of this.model.nodes.values()) n.flush(1_000_000);
      for (const e of this.model.edges.values()) e.m.flush();
      for (const c of this.model.classes) c.flush();
      this.sim.after(1_000_000, tick);
    };
    this.sim.at(1_000_000, tick);
    this.setLoad(1);
  }

  get timeS(): number {
    return this.sim.now / 1e6;
  }

  setLoad(mult: number): void {
    this.load = mult;
    for (const c of this.model.classes) c.setLiveRate(mult);
  }

  setOverride(componentId: string, o: FaultOverride | null): void {
    this.ctx.faults.setOverride(componentId, o);
  }

  /** Advance simulated time by `dtS` seconds, spending at most `maxEvents` events. */
  advance(dtS: number, maxEvents = 400_000): void {
    // If we fell behind, do not let the backlog grow without bound.
    this.target = Math.max(this.target, this.sim.now) + Math.round(dtS * 1e6);
    if (this.target - this.sim.now > 2_000_000) this.target = this.sim.now + 2_000_000;
    this.lagging = this.sim.run(this.target, this.sim.events + maxEvents);
  }

  snapshot(historyLen = 90): LiveSnapshot {
    const nodes: Record<string, LiveNodeState> = {};
    let costPerS = 0;
    for (const [id, n] of this.model.nodes) {
      const s = n.m.series;
      const failures = s.errors.map((e, i) => e + s.rejected[i]! + s.rate_limited[i]!);
      const state: LiveNodeState = {
        id,
        type: n.typeId,
        primitive: this.primitives.get(id)!,
        concurrency: n instanceof StationRt ? n.concurrency : null,
        utilization: last(s.utilization),
        arrivals: last(s.arrivals),
        ok: last(s.ok),
        errors: last(s.errors),
        rejected: last(s.rejected),
        rate_limited: last(s.rate_limited),
        p99_ms: n.lat.p99.length ? n.lat.p99[n.lat.p99.length - 1]! : null,
        cost: last(s.cost),
        queue: n instanceof StationRt ? n.queueLength : 0,
        busy: n instanceof StationRt ? n.busyNow : 0,
        history: {
          utilization: lastN(s.utilization, historyLen) as number[],
          arrivals: lastN(s.arrivals, historyLen) as number[],
          failures: lastN(failures, historyLen) as number[],
          queue: lastN(s.queue, historyLen) as number[],
        },
      };
      if (n instanceof LoopRt) {
        const a = n.agent.series;
        state.agent = { active: last(a.active), runaway: last(a.runaway_active), max_steps: last(a.max_active_steps), threshold: n.threshold };
      }
      if (n instanceof LlmRt) costPerS += state.cost;
      nodes[id] = state;
    }
    const edges: Record<string, LiveEdgeState> = {};
    for (const [id, e] of this.model.edges) {
      const s = e.m.series;
      edges[id] = {
        id,
        from: e.from,
        to: e.to.id,
        client: this.model.edgeIsClient.get(id)!,
        attempts: last(s.attempts),
        first: last(s.first),
        retries: last(s.retries),
        timeouts: last(s.timeouts),
        failed: last(s.failed),
        ok: last(s.ok),
      };
    }
    const classes: Record<string, LiveClassState> = {};
    let offered = 0;
    let ok = 0;
    let failed = 0;
    let p99: number | null = null;
    for (const c of this.model.classes) {
      const s = c.m.series;
      const cp99 = c.lat.p99.length ? c.lat.p99[c.lat.p99.length - 1]! : null;
      classes[c.id] = {
        id: c.id,
        offered: last(s.offered),
        ok: last(s.ok),
        failed: last(s.failed),
        p99_ms: cp99,
        history: { offered: lastN(s.offered, historyLen) as number[], ok: lastN(s.ok, historyLen) as number[] },
      };
      offered += last(s.offered);
      ok += last(s.ok);
      failed += last(s.failed);
      if (cp99 !== null) p99 = Math.max(p99 ?? 0, cp99);
    }
    return {
      time_s: this.timeS,
      load: this.load,
      lagging: this.lagging,
      nodes,
      edges,
      classes,
      totals: { offered, ok, failed, p99_ms: p99, cost_per_min: costPerS * 60, cost_total: this.ctx.cost.total },
    };
  }
}
