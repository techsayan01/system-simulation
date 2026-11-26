import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyze } from '@sim/detectors';
import { loadDesign } from '../src/load.ts';

const bench = (name: string) => resolve(import.meta.dirname, `../../../benchmarks/${name}.yaml`);

describe('retry-storm findings', () => {
  const { design, registry } = loadDesign(bench('retry-storm'));
  const report = analyze(design, registry);

  it('names the database, not the service waiting on it, as the bottleneck', () => {
    const f = report.findings.find((x) => x.type === 'metastable_failure')!;
    expect(f.component).toBe('db');
    expect(f.metrics.backed_up).toBe('api');
  });

  it('reports retries at both layers as one finding on the component they overload', () => {
    const retries = report.findings.filter((x) => x.type === 'retry_amplification');
    expect(retries).toHaveLength(1);
    expect(retries[0]!.component).toBe('db');
    expect(retries[0]!.metrics.layers).toBe(2);
    expect(retries[0]!.metrics.theoretical_max_x).toBe(9);
    expect(retries[0]!.metrics.retrying_calls).toBe('client(checkout)->lb, api->db');
  });
});
