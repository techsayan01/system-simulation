import type { RunResult } from '@sim/engine';
import type { Design, Registry, Scenario } from '@sim/model';

export type Severity = 'high' | 'medium' | 'low';
export const SEVERITY_RANK: Record<Severity, number> = { high: 3, medium: 2, low: 1 };

export type FindingType =
  | 'retry_amplification'
  | 'metastable_failure'
  | 'rate_limit_cascade'
  | 'first_limit_reached'
  | 'runaway_agent_loop';

export interface Trigger {
  /** Seconds from the start of the scenario. */
  time_s: number;
  load_multiplier: number;
  load_rps: number;
}

/** What one detector reports for one run. */
export interface RawFinding {
  type: FindingType;
  severity: Severity;
  title: string;
  /** Component id, or call id such as `api->db`. */
  component: string;
  trigger: Trigger;
  metrics: Record<string, number | string | null>;
  /** Names of the result series that show the problem. */
  series: string[];
  summary: string;
  assumptions?: string[];
}

export interface DetectorContext {
  design: Design;
  registry: Registry;
  scenario: Scenario;
  run: RunResult;
  /** Baseline run with the same seed, when available. */
  baseline?: RunResult;
}

export type Detector = (ctx: DetectorContext) => RawFinding[];

/** A finding confirmed across seeds and merged across scenarios. */
export interface Finding extends RawFinding {
  id: string;
  source: 'simulation';
  scenario: string;
  scenario_title: string;
  confidence: { seeds: number; reproduced: number };
  evidence: { run_id: string; seed: number; series: string[] };
  also_seen_in: string[];
}
