import { LIMIT_DIMS, type LimitDim } from '@sim/engine';
import { resolveComponent } from '@sim/model';
import {
  firstEpisode,
  goodputRatio,
  mean,
  meanOf,
  minOf,
  pct,
  r2,
  sum,
  triggerAt,
} from './series.ts';
import type { Detector, DetectorContext, RawFinding } from './types.ts';

/** Thresholds. Phase 0 values, tuned on the benchmark suite (ADR-06). */
export const THRESHOLDS = {
  minEpisode: 5,
  retryRatio: 2.5,
  minFirstAttempts: 3,
  metastablePre: 0.9,
  metastableDrop: 0.8,
  metastableSettle_s: 60,
  rateLimitedShare: 0.3,
  cascadeRetryShare: 0.4,
  runawayShare: 0.2,
  cappedShare: 0.2,
  lowHeadroom: 2,
} as const;

const DIM_LABEL: Record<LimitDim, string> = {
  requests_per_min: 'requests per minute',
  input_tokens_per_min: 'input tokens per minute',
  output_tokens_per_min: 'output tokens per minute',
};

function policyFor(ctx: DetectorContext, edgeId: string): string {
  const e = ctx.run.edges[edgeId]!;
  const policy = e.client
    ? ctx.design.traffic.classes.find((c) => `client(${c.id})` === e.from)?.client
    : ctx.design.calls.find((c) => c.from === e.from && c.to === e.to)?.policy;
  const r = policy?.retry;
  if (!r) return 'no retries';
  return `${r.max} retries, backoff ${r.backoff}${r.jitter ? ' with jitter' : ''}, timeout ${policy?.timeout_ms ?? 'none'} ms`;
}

/** Retries multiply the load on a call while the system is already struggling. */
export const retryAmplification: Detector = (ctx) => {
  const { run, scenario } = ctx;
  const g = goodputRatio(run);
  const out: RawFinding[] = [];
  for (const [id, e] of Object.entries(run.edges)) {
    if (!e.has_retry || e.max_retries + 1 < THRESHOLDS.retryRatio) continue;
    const s = e.series;
    const ratio = s.first.map((f, w) => (f > 0 ? s.attempts[w]! / f : 0));
    const cond = s.first.map((f, w) => f >= THRESHOLDS.minFirstAttempts && ratio[w]! >= THRESHOLDS.retryRatio);
    const ep = firstEpisode(cond, THRESHOLDS.minEpisode, scenario.warmup_s);
    if (!ep) continue;
    // Retries land in later windows than their first attempt, so report ratios over
    // 10 s spans and never above the policy's own maximum.
    const cap = e.max_retries + 1;
    let peak = 0;
    for (let w = ep.start; w < ep.end; w++) {
      const lo = Math.max(ep.start, w - 9);
      const f = sum(s.first.slice(lo, w + 1));
      if (f > 0) peak = Math.max(peak, sum(s.attempts.slice(lo, w + 1)) / f);
    }
    peak = Math.min(cap, peak);
    const meanRatio = Math.min(cap, sum(s.attempts.slice(ep.start, ep.end)) / Math.max(1, sum(s.first.slice(ep.start, ep.end))));
    const gMin = minOf(g.slice(ep.start, ep.end));
    const extra = sum(s.retries.slice(ep.start, ep.end));
    const episode = ep.end - ep.start;
    const policy = e.client
      ? ctx.design.traffic.classes.find((c) => `client(${c.id})` === e.from)?.client
      : ctx.design.calls.find((c) => c.from === e.from && c.to === e.to)?.policy;
    const noBackoff = (policy?.retry?.backoff ?? 'none') === 'none';
    // Immediate retries are what turns overload into collapse; spaced, jittered retries
    // still multiply load but rarely sustain it.
    const severity = noBackoff
      ? gMin !== null && gMin < 0.5
        ? 'high'
        : 'medium'
      : episode >= 30
        ? 'medium'
        : 'low';
    out.push({
      type: 'retry_amplification',
      severity,
      title: `Retries multiply load on ${id}`,
      component: id,
      trigger: triggerAt(run, ep.start),
      metrics: {
        peak_attempts_per_call: r2(peak),
        mean_attempts_per_call: r2(meanRatio),
        extra_calls_from_retries: extra,
        episode_s: episode,
        goodput_min_pct: pct(gMin),
        retry_policy: policyFor(ctx, id),
      },
      series: [`edges.${id}.attempts`, `edges.${id}.first`, `edges.${id}.retries`, 'classes.*.ok'],
      summary:
        `Each call on ${id} turned into up to ${r2(peak)} attempts ` +
        `(${extra} extra calls over ${episode} s) while goodput fell to ${pct(gMin)}% of offered requests. ` +
        `Policy: ${policyFor(ctx, id)}.`,
    });
  }
  return out;
};

/** The system stays broken after a short spike has passed. */
export const metastableFailure: Detector = (ctx) => {
  const { run, scenario } = ctx;
  if (scenario.load.kind !== 'spike') return [];
  const { start_s, end_s, peak } = scenario.load;
  const g = goodputRatio(run);
  const n = run.load.length;
  const settle = Math.min(n - 10, end_s + THRESHOLDS.metastableSettle_s);
  const pre = meanOf(g.slice(Math.max(scenario.warmup_s, start_s - 30), start_s));
  const post = meanOf(g.slice(settle, n));
  if (pre === null || post === null) return [];
  if (pre < THRESHOLDS.metastablePre || post >= THRESHOLDS.metastableDrop * pre) return [];

  let bottleneck = '';
  let worst = -1;
  for (const [id, node] of Object.entries(run.nodes)) {
    const q = mean(node.series.queue.slice(settle, n)) ?? 0;
    const u = mean(node.series.utilization.slice(settle, n)) ?? 0;
    const score = q * 1000 + u;
    if (score > worst) {
      worst = score;
      bottleneck = id;
    }
  }
  const b = run.nodes[bottleneck]!;
  const firstBad = g.findIndex((x, w) => w >= start_s && x !== null && x < 0.5 * pre);
  return [
    {
      type: 'metastable_failure',
      severity: 'high',
      title: 'System does not recover after a load spike',
      component: bottleneck,
      trigger: triggerAt(run, firstBad >= 0 ? firstBad : start_s),
      metrics: {
        spike_multiplier: peak,
        spike_duration_s: end_s - start_s,
        goodput_before_pct: pct(pre),
        goodput_after_pct: pct(post),
        observed_until_s: n,
        bottleneck_queue_mean: r2(mean(b.series.queue.slice(settle, n)) ?? 0),
        bottleneck_utilization_mean: r2(mean(b.series.utilization.slice(settle, n)) ?? 0),
      },
      series: ['classes.*.ok', 'classes.*.offered', `nodes.${bottleneck}.queue`, `nodes.${bottleneck}.utilization`],
      summary:
        `A ${peak}x spike lasting ${end_s - start_s} s left the system failing after load returned to normal: ` +
        `goodput was ${pct(pre)}% before the spike and ${pct(post)}% from ${settle} s to ${n} s. ` +
        `${bottleneck} stays saturated (mean queue ${Math.round(mean(b.series.queue.slice(settle, n)) ?? 0)}), ` +
        `typically because retries and abandoned work keep it overloaded.`,
    },
  ];
};

function firstRejectedDim(rl: Record<LimitDim, number[]>, from: number): LimitDim | null {
  const n = rl.requests_per_min.length;
  for (let w = from; w < n; w++) {
    let best: LimitDim | null = null;
    for (const d of LIMIT_DIMS) if ((rl[d][w] ?? 0) > 0 && (!best || rl[d][w]! > rl[best][w]!)) best = d;
    if (best) return best;
  }
  return null;
}

/** 429s trigger retries, retries consume limits, and the provider keeps rejecting. */
export const rateLimitCascade: Detector = (ctx) => {
  const { run, scenario } = ctx;
  const g = goodputRatio(run);
  const out: RawFinding[] = [];
  for (const [id, node] of Object.entries(run.nodes)) {
    if (node.primitive !== 'llm' || !node.rate_limited_by_dim) continue;
    const arr = node.series.arrivals;
    const rl = node.series.rate_limited;
    const share = arr.map((a, w) => (a > 0 ? rl[w]! / a : 0));
    const cond = arr.map((a, w) => a >= 5 && share[w]! >= THRESHOLDS.rateLimitedShare);
    const ep = firstEpisode(cond, THRESHOLDS.minEpisode, scenario.warmup_s);
    if (!ep) continue;
    const incoming = Object.entries(run.edges).filter(([, e]) => e.to === id);
    const attempts = sum(incoming.map(([, e]) => sum(e.series.attempts.slice(ep.start, ep.end))));
    const retries = sum(incoming.map(([, e]) => sum(e.series.retries.slice(ep.start, ep.end))));
    const retryShare = attempts > 0 ? retries / attempts : 0;
    if (retryShare < THRESHOLDS.cascadeRetryShare) continue;
    const dim = firstRejectedDim(node.rate_limited_by_dim, scenario.warmup_s);
    const gMin = minOf(g.slice(ep.start, ep.end));
    out.push({
      type: 'rate_limit_cascade',
      severity: 'high',
      title: `Rate-limit cascade on ${id}`,
      component: id,
      trigger: triggerAt(run, ep.start),
      metrics: {
        peak_rejected_pct: pct(Math.max(...share.slice(ep.start, ep.end))),
        retry_share_pct: pct(retryShare),
        first_limit: dim ? DIM_LABEL[dim] : null,
        goodput_min_pct: pct(gMin),
        retry_policy: incoming.map(([eid]) => `${eid}: ${policyFor(ctx, eid)}`).join('; '),
      },
      series: [`nodes.${id}.rate_limited`, `nodes.${id}.rate_limited_by_dim`, ...incoming.map(([eid]) => `edges.${eid}.retries`)],
      summary:
        `${id} rejected up to ${pct(Math.max(...share.slice(ep.start, ep.end)))}% of calls with 429 after ` +
        `${dim ? DIM_LABEL[dim] : 'a limit'} ran out. ${pct(retryShare)}% of calls to it were retries of rejected calls; ` +
        `the retries add to the load the limits must absorb, so rejections feed themselves. Goodput fell to ${pct(gMin)}%.`,
    });
  }
  return out;
};

/** Which provider limit runs out first as traffic grows, and at what multiple of current traffic. */
export const firstLimitReached: Detector = (ctx) => {
  const { run, scenario } = ctx;
  if (scenario.load.kind !== 'ramp') return [];
  const out: RawFinding[] = [];
  for (const [id, node] of Object.entries(run.nodes)) {
    if (node.primitive !== 'llm' || !node.demand_by_dim || !node.limits) continue;
    const crossings: Partial<Record<LimitDim, number>> = {};
    for (const d of LIMIT_DIMS) {
      const limit = node.limits[d];
      if (limit === null) continue;
      const demand = node.demand_by_dim[d];
      for (let w = scenario.warmup_s; w < demand.length; w++) {
        const perMin = (mean(demand.slice(Math.max(0, w - 9), w + 1))! * 60);
        if (perMin > limit) {
          crossings[d] = w;
          break;
        }
      }
    }
    const order = (Object.entries(crossings) as [LimitDim, number][]).sort((a, b) => a[1] - b[1]);
    if (!order.length) continue;
    const [dim, w] = order[0]!;
    const t = triggerAt(run, w);
    const headroom = LIMIT_DIMS.filter((d) => node.limits![d] !== null)
      .map((d) => `${DIM_LABEL[d]}: ${crossings[d] !== undefined ? `${r2(run.load[crossings[d]]!)}x` : `above ${r2(Math.max(...run.load))}x`}`)
      .join('; ');
    const saw429 = sum(node.series.rate_limited) > 0;
    out.push({
      type: 'first_limit_reached',
      severity: t.load_multiplier < THRESHOLDS.lowHeadroom ? 'medium' : 'low',
      title: `First limit on ${id}: ${DIM_LABEL[dim]}`,
      component: id,
      trigger: t,
      metrics: {
        first_limit: DIM_LABEL[dim],
        limit_value: node.limits[dim],
        at_multiplier: t.load_multiplier,
        headroom,
        rejections_observed: saw429 ? 'yes' : 'no',
      },
      series: [`nodes.${id}.demand_by_dim`, `nodes.${id}.rate_limited_by_dim`],
      summary:
        `${DIM_LABEL[dim]} is the first ${id} limit to run out, at about ${t.load_multiplier}x current traffic ` +
        `(${t.load_rps} rps). Headroom per limit: ${headroom}.`,
      assumptions: ['Request and token sizes follow the traffic class distributions in the design.'],
    });
  }
  return out;
};

/** Agent invocations keep looping far beyond their normal step count. */
export const runawayAgentLoop: Detector = (ctx) => {
  const { run, scenario, baseline, design, registry } = ctx;
  const out: RawFinding[] = [];
  for (const [id, node] of Object.entries(run.nodes)) {
    if (node.primitive !== 'loop' || !node.agent) continue;
    const a = node.agent;
    const params = resolveComponent(design.components.find((c) => c.id === id)!, registry);
    if (params.primitive !== 'loop') continue;
    const { loop_cap, budget_cap_usd, steps_mean } = params.params;
    const runawayCond = a.active.map((n, w) => n >= 3 && a.runaway_active[w]! / n >= THRESHOLDS.runawayShare);
    const cappedCond = a.completed.map((n, w) => n >= 3 && (a.capped[w]! + a.budget_stopped[w]!) / n >= THRESHOLDS.cappedShare);
    const runaway = firstEpisode(runawayCond, THRESHOLDS.minEpisode, scenario.warmup_s);
    const capped = runaway ? null : firstEpisode(cappedCond, THRESHOLDS.minEpisode, scenario.warmup_s);
    const ep = runaway ?? capped;
    if (!ep) continue;
    const costX =
      baseline?.totals.cost_per_success_usd && run.totals.cost_per_success_usd
        ? r2(run.totals.cost_per_success_usd / baseline.totals.cost_per_success_usd)
        : null;
    const maxSteps = Math.max(...a.max_active_steps, ...a.max_completed_steps);
    const uncapped = loop_cap === null && budget_cap_usd === null;
    const share = runaway
      ? Math.max(...a.runaway_active.slice(ep.start, ep.end).map((r, i) => r / a.active[ep.start + i]!))
      : Math.max(...a.capped.slice(ep.start, ep.end).map((c, i) => (c + a.budget_stopped[ep.start + i]!) / a.completed[ep.start + i]!));
    out.push({
      type: 'runaway_agent_loop',
      severity: runaway && uncapped ? 'high' : 'medium',
      title: runaway ? `Runaway agent loop in ${id}` : `Agent loop in ${id} keeps hitting its caps`,
      component: id,
      trigger: triggerAt(run, ep.start),
      metrics: {
        normal_steps_mean: steps_mean,
        runaway_threshold_steps: a.runaway_threshold,
        max_steps_seen: maxSteps,
        [runaway ? 'peak_runaway_share_pct' : 'peak_capped_share_pct']: pct(share),
        loop_cap: loop_cap ?? 'none',
        budget_cap_usd: budget_cap_usd ?? 'none',
        cost_per_success_vs_baseline_x: costX,
        scenario_cost_usd: run.totals.cost_usd,
      },
      series: [`nodes.${id}.agent.active`, `nodes.${id}.agent.runaway_active`, `nodes.${id}.agent.max_active_steps`, 'totals.cost_usd'],
      summary: runaway
        ? `During "${scenario.title}", ${pct(share)}% of running ${id} invocations went past ${a.runaway_threshold} steps ` +
          `(normal mean ${steps_mean}, max seen ${maxSteps}). ` +
          (uncapped ? 'Nothing stops the loop: there is no step cap and no budget cap. ' : '') +
          (costX !== null ? `Cost per successful request was ${costX}x the normal-load figure.` : '')
        : `During "${scenario.title}", up to ${pct(share)}% of ${id} invocations ended because they hit the step or budget cap, ` +
          `so users get capped answers instead of completed ones.`,
      assumptions: [`Agent step count is geometric with mean ${steps_mean}; a failed tool call makes the agent re-plan.`],
    });
  }
  return out;
};

export const DETECTORS: Detector[] = [
  retryAmplification,
  metastableFailure,
  rateLimitCascade,
  firstLimitReached,
  runawayAgentLoop,
];
