import { analyze, SEVERITY_RANK, type AnalysisReport } from '@sim/detectors';
import { canonicalJson, runScenario } from '@sim/engine';
import { standardBattery } from '@sim/scenarios';
import { loadDesign, loadManifest } from './load.ts';

export interface BenchmarkOutcome {
  name: string;
  expected: string[];
  detected: string[];
  missing: string[];
  /** Findings not listed as expected (reported for review; not failures by themselves). */
  extra: string[];
  baselineFindings: string[];
  severityViolations: string[];
  deterministic: boolean;
  truncatedRuns: number;
  passed: boolean;
  report: AnalysisReport;
}

export interface GateResult {
  outcomes: BenchmarkOutcome[];
  expectedTotal: number;
  detectedTotal: number;
  passed: boolean;
}

/** Run the Phase 0 gate over a benchmark manifest. */
export function runBenchmarks(manifestPath: string, seeds = [1, 2, 3], onProgress?: (msg: string) => void): GateResult {
  const { benchmarks } = loadManifest(manifestPath);
  const outcomes: BenchmarkOutcome[] = [];
  for (const b of benchmarks) {
    onProgress?.(`${b.name}: running battery`);
    const { design, registry } = loadDesign(b.design);
    const report = analyze(design, registry, { seeds });
    const types = new Set(report.findings.map((f) => f.type));
    const missing = b.expect.filter((t) => !types.has(t as never));
    const extra = report.findings.filter((f) => !b.expect.includes(f.type)).map((f) => `${f.id} ${f.type} (${f.severity})`);
    const baselineFindings = report.findings
      .filter((f) => f.scenario === 'baseline' || f.also_seen_in.includes('baseline'))
      .map((f) => `${f.id} ${f.type}`);
    const severityViolations = b.max_severity
      ? report.findings
          .filter((f) => SEVERITY_RANK[f.severity] > SEVERITY_RANK[b.max_severity!])
          .map((f) => `${f.id} ${f.type} (${f.severity})`)
      : [];

    // Determinism: the same scenario and seed must give byte-identical results.
    const spike = standardBattery(design, registry).find((s) => s.id === 'spike')!;
    const a = canonicalJson(runScenario(design, registry, spike, { seed: seeds[0]! }));
    const c = canonicalJson(runScenario(design, registry, spike, { seed: seeds[0]! }));
    const deterministic = a === c;

    const truncatedRuns = report.runs.filter((r) => r.truncated).length;
    outcomes.push({
      name: b.name,
      expected: b.expect,
      detected: b.expect.filter((t) => types.has(t as never)),
      missing,
      extra,
      baselineFindings,
      severityViolations,
      deterministic,
      truncatedRuns,
      passed: !missing.length && !baselineFindings.length && !severityViolations.length && deterministic && !truncatedRuns,
      report,
    });
  }
  const expectedTotal = outcomes.reduce((s, o) => s + o.expected.length, 0);
  const detectedTotal = outcomes.reduce((s, o) => s + o.detected.length, 0);
  return { outcomes, expectedTotal, detectedTotal, passed: outcomes.every((o) => o.passed) };
}
