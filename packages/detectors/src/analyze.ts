import { ENGINE_VERSION, runScenario, type RunResult } from '@sim/engine';
import type { Design, Registry, Scenario } from '@sim/model';
import { standardBattery } from '@sim/scenarios';
import { DETECTORS } from './detectors.ts';
import { SEVERITY_RANK, type Detector, type Finding, type RawFinding } from './types.ts';

export interface AnalyzeOptions {
  /** Seeds to run each scenario with. A finding must reproduce in a majority of them. */
  seeds?: number[];
  /** Scenarios to run; defaults to the standard battery. */
  scenarios?: Scenario[];
  detectors?: Detector[];
  /** Progress callback, called after each run. */
  onRun?: (scenario: Scenario, seed: number, run: RunResult) => void;
}

export interface RunSummary {
  scenario: string;
  seed: number;
  run_id: string;
  events: number;
  truncated: boolean;
  requests: number;
  ok: number;
  cost_usd: number;
}

export interface AnalysisReport {
  design_id: string;
  engine_version: string;
  seeds: number[];
  scenarios: { id: string; title: string }[];
  runs: RunSummary[];
  findings: Finding[];
}

/**
 * Run every scenario with every seed, apply every detector, keep findings that reproduce
 * in a majority of seeds, and merge the same problem seen in several scenarios.
 */
export function analyze(design: Design, registry: Registry, opts: AnalyzeOptions = {}): AnalysisReport {
  const seeds = opts.seeds ?? [1, 2, 3];
  const scenarios = opts.scenarios ?? standardBattery(design, registry);
  const detectors = opts.detectors ?? DETECTORS;
  const runs: RunSummary[] = [];
  const baselines = new Map<number, RunResult>();
  const baselineScenario = scenarios.find((s) => s.id === 'baseline');

  // key -> per-seed raw findings
  const grouped = new Map<string, { scenario: Scenario; hits: { seed: number; runId: string; f: RawFinding }[] }>();

  const order = baselineScenario ? [baselineScenario, ...scenarios.filter((s) => s !== baselineScenario)] : scenarios;
  for (const scenario of order) {
    for (const seed of seeds) {
      const run = runScenario(design, registry, scenario, { seed });
      if (scenario === baselineScenario) baselines.set(seed, run);
      opts.onRun?.(scenario, seed, run);
      runs.push({
        scenario: scenario.id,
        seed,
        run_id: run.meta.run_id,
        events: run.meta.events,
        truncated: run.meta.truncated,
        requests: run.totals.requests,
        ok: run.totals.ok,
        cost_usd: run.totals.cost_usd,
      });
      const ctx = { design, registry, scenario, run, baseline: baselines.get(seed) };
      for (const detect of detectors) {
        for (const f of detect(ctx)) {
          const key = `${f.type}|${f.component}|${scenario.id}`;
          const g = grouped.get(key) ?? { scenario, hits: [] };
          g.hits.push({ seed, runId: run.meta.run_id, f });
          grouped.set(key, g);
        }
      }
    }
  }

  // Confirm across seeds: keep the median-trigger hit as the representative.
  const confirmed: Omit<Finding, 'id' | 'also_seen_in'>[] = [];
  const majority = Math.floor(seeds.length / 2) + 1;
  for (const { scenario, hits } of grouped.values()) {
    if (hits.length < majority) continue;
    const sorted = [...hits].sort((a, b) => a.f.trigger.time_s - b.f.trigger.time_s || a.seed - b.seed);
    const rep = sorted[Math.floor((sorted.length - 1) / 2)]!;
    confirmed.push({
      ...rep.f,
      source: 'simulation',
      scenario: scenario.id,
      scenario_title: scenario.title,
      confidence: { seeds: seeds.length, reproduced: hits.length },
      evidence: { run_id: rep.runId, seed: rep.seed, series: rep.f.series },
    });
  }

  // Merge the same problem across scenarios: keep the most severe, earliest-triggering one.
  const scenarioIndex = new Map(order.map((s, i) => [s.id, i]));
  const merged = new Map<string, Omit<Finding, 'id'>>();
  const rank = (f: Omit<Finding, 'id' | 'also_seen_in'>) =>
    [-SEVERITY_RANK[f.severity], f.trigger.load_multiplier, scenarioIndex.get(f.scenario)!] as const;
  const before = (a: readonly number[], b: readonly number[]) => {
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i]! < b[i]!;
    return false;
  };
  for (const f of confirmed) {
    const key = `${f.type}|${f.component}`;
    const cur = merged.get(key);
    if (!cur) merged.set(key, { ...f, also_seen_in: [] });
    else if (before(rank(f), rank(cur))) merged.set(key, { ...f, also_seen_in: [...cur.also_seen_in, cur.scenario] });
    else cur.also_seen_in.push(f.scenario);
  }

  const findings = [...merged.values()]
    .map((f) => ({ ...f, also_seen_in: [...f.also_seen_in].sort((a, b) => scenarioIndex.get(a)! - scenarioIndex.get(b)!) }))
    .sort(
      (a, b) =>
        SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
        a.type.localeCompare(b.type) ||
        a.component.localeCompare(b.component),
    )
    .map((f, i) => ({ id: `F-${String(i + 1).padStart(3, '0')}`, ...f }));

  return {
    design_id: design.design.id,
    engine_version: ENGINE_VERSION,
    seeds,
    scenarios: order.map((s) => ({ id: s.id, title: s.title })),
    runs,
    findings,
  };
}
