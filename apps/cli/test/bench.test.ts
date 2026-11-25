import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runBenchmarks } from '../src/bench.ts';

describe('Phase 0 gate', () => {
  it('detects every seeded failure mode without manual probing, and nothing at normal load', () => {
    const gate = runBenchmarks(resolve(import.meta.dirname, '../../../benchmarks/manifest.yaml'));
    for (const o of gate.outcomes) {
      expect.soft(o.missing, `${o.name}: missing findings`).toEqual([]);
      expect.soft(o.baselineFindings, `${o.name}: findings at normal load`).toEqual([]);
      expect.soft(o.severityViolations, `${o.name}: severity above allowed`).toEqual([]);
      expect.soft(o.deterministic, `${o.name}: deterministic`).toBe(true);
      expect.soft(o.truncatedRuns, `${o.name}: truncated runs`).toBe(0);
    }
    expect(gate.detectedTotal).toBe(gate.expectedTotal);
    expect(gate.passed).toBe(true);
  });
});
