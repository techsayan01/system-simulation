import { ScenarioSchema, type Design, type Registry, type Scenario } from '@sim/model';

export interface BatteryOptions {
  /** Highest load multiplier for the ramp. */
  rampTo?: number;
  spikePeak?: number;
}

/**
 * The standard scenario battery (Phase 0 subset). The user does not choose what to probe:
 * every design gets the same stress tests, derived from its own structure.
 *
 * - baseline: normal load, to show what a review at current traffic would see
 * - ramp: 0.5x to 5x, to find where things start to break
 * - spike: 3x for 60 s, then back to normal, to find failures that persist after the trigger
 * - limit-squeeze: every LLM provider limit halved (GenAI designs only)
 * - outage: each leaf dependency fails every call for 2 minutes, one at a time
 */
export function standardBattery(design: Design, registry: Registry, opts: BatteryOptions = {}): Scenario[] {
  const rampTo = opts.rampTo ?? 5;
  const spikePeak = opts.spikePeak ?? 3;
  const out: unknown[] = [
    { id: 'baseline', title: 'Normal load (1x)', duration_s: 180, load: { kind: 'constant', mult: 1 } },
    {
      id: 'ramp',
      title: `Load ramp 0.5x to ${rampTo}x`,
      duration_s: 300,
      load: { kind: 'ramp', from: 0.5, to: rampTo, start_s: 0, end_s: 300 },
    },
    {
      id: 'spike',
      title: `Spike to ${spikePeak}x for 60 s, then back to 1x`,
      duration_s: 300,
      load: { kind: 'spike', base: 1, peak: spikePeak, start_s: 60, end_s: 120 },
    },
  ];

  const typeOf = (id: string) => registry.get(design.components.find((c) => c.id === id)!.type)!;
  const llms = design.components.filter((c) => registry.get(c.type)?.primitive === 'llm');
  if (llms.length) {
    out.push({
      id: 'limit-squeeze',
      title: 'LLM provider limits halved at normal load',
      duration_s: 240,
      load: { kind: 'constant', mult: 1 },
      faults: llms.map((c) => ({ kind: 'limit_scale', target: c.id, factor: 0.5, from_s: 0, to_s: 240 })),
    });
  }

  const callers = new Set(design.calls.map((c) => c.from));
  const leaves = design.components
    .filter((c) => !callers.has(c.id) && typeOf(c.id).primitive !== 'router')
    .map((c) => c.id)
    .sort();
  for (const leaf of leaves) {
    out.push({
      id: `outage:${leaf}`,
      title: `${leaf} fails every call from 60 s to 180 s`,
      duration_s: 300,
      load: { kind: 'constant', mult: 1 },
      faults: [{ kind: 'error_rate', target: leaf, value: 1, from_s: 60, to_s: 180 }],
    });
  }
  return out.map((s) => ScenarioSchema.parse(s));
}
