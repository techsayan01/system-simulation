import { describe, expect, it } from 'vitest';
import { parseDesign, ScenarioSchema, DesignError } from '@sim/model';
import { defaultRegistry } from '@sim/packs';
import { canonicalJson, runScenario } from '../src/index.ts';

const registry = defaultRegistry();

const constant = (duration_s: number) =>
  ScenarioSchema.parse({ id: 'test', title: 'test', duration_s, warmup_s: 0, load: { kind: 'constant', mult: 1 } });

function single(component: Record<string, unknown>, rate_rps: number, extra: Record<string, unknown> = {}) {
  return parseDesign(
    {
      apiVersion: 'sim/v1',
      design: { id: 'test' },
      traffic: { classes: [{ id: 'c', entry: 's', arrival: { kind: 'poisson', rate_rps }, ...extra }] },
      components: [{ id: 's', ...component }],
      calls: [],
    },
    registry,
  );
}

/** Erlang C probability of waiting for an M/M/c queue. */
function erlangC(c: number, a: number): number {
  let sum = 0;
  let term = 1;
  for (let k = 0; k < c; k++) {
    if (k > 0) term *= a / k;
    sum += term;
  }
  const last = (term * a) / c;
  const top = (last * c) / (c - a);
  return top / (sum + top);
}

describe('queueing accuracy', () => {
  it('matches M/M/1 mean response time and utilization', () => {
    // lambda = 50/s, mean service 10 ms -> rho = 0.5, mean response 1/(mu - lambda) = 20 ms
    const design = single(
      { type: 'web/service', params: { concurrency: 1, service_time_ms: { dist: 'exponential', mean: 10 }, error_rate: 0 } },
      50,
    );
    const run = runScenario(design, registry, constant(2000), { seed: 1 });
    const s = run.nodes.s!;
    expect(s.totals.latency_mean_ms!).toBeGreaterThan(20 * 0.92);
    expect(s.totals.latency_mean_ms!).toBeLessThan(20 * 1.08);
    const util = s.series.utilization.reduce((a, b) => a + b, 0) / s.series.utilization.length;
    expect(util).toBeGreaterThan(0.47);
    expect(util).toBeLessThan(0.53);
  });

  it('matches M/M/c (Erlang C) mean response time', () => {
    // c = 4, mean service 40 ms (mu = 25/s), lambda = 80/s -> a = 3.2, rho = 0.8
    const c = 4;
    const mu = 25;
    const lambda = 80;
    const expected = (erlangC(c, lambda / mu) / (c * mu - lambda) + 1 / mu) * 1000;
    const design = single(
      { type: 'web/database', params: { concurrency: c, service_time_ms: { dist: 'exponential', mean: 40 }, error_rate: 0 } },
      lambda,
    );
    const run = runScenario(design, registry, constant(3000), { seed: 3 });
    const got = run.nodes.s!.totals.latency_mean_ms!;
    expect(got).toBeGreaterThan(expected * 0.9);
    expect(got).toBeLessThan(expected * 1.1);
  });
});

describe('LLM provider limits', () => {
  it('admits about the request limit per minute and rejects the rest with 429', () => {
    const design = single(
      {
        type: 'genai/llm-provider',
        params: { rpm: 60, itpm: null, otpm: null, count_rejected_toward_rpm: false, error_rate: 0 },
      },
      2,
    );
    const run = runScenario(design, registry, constant(600), { seed: 2 });
    const s = run.nodes.s!.series;
    const from = 120;
    const arrivals = s.arrivals.slice(from).reduce((a, b) => a + b, 0);
    const limited = s.rate_limited.slice(from).reduce((a, b) => a + b, 0);
    const admittedPerS = (arrivals - limited) / (600 - from);
    expect(admittedPerS).toBeGreaterThan(0.95);
    expect(admittedPerS).toBeLessThan(1.05);
    expect(run.nodes.s!.rate_limited_by_dim!.requests_per_min.slice(from).reduce((a, b) => a + b, 0)).toBe(limited);
  });

  it('bills input and output tokens at the configured prices', () => {
    const design = single(
      {
        type: 'genai/llm-provider',
        params: { rpm: null, itpm: null, otpm: null, error_rate: 0, price_input_per_mtok: 2, price_output_per_mtok: 10 },
      },
      1,
      { attrs: { input_tokens: 1000, output_tokens: 100 } },
    );
    const run = runScenario(design, registry, constant(120), { seed: 1 });
    // each completed call costs 1000 * 2e-6 + 100 * 1e-5 = 0.003 USD
    const completed = run.nodes.s!.totals.ok;
    expect(run.totals.cost_usd).toBeCloseTo(completed * 0.003, 6);
  });
});

describe('agent loop', () => {
  it('runs a geometric number of steps with the configured mean', () => {
    const design = parseDesign(
      {
        apiVersion: 'sim/v1',
        design: { id: 'agent' },
        traffic: { classes: [{ id: 'c', entry: 'agent', arrival: { kind: 'poisson', rate_rps: 5 } }] },
        components: [
          { id: 'agent', type: 'genai/agent-loop', params: { steps_mean: 4 } },
          { id: 'tool', type: 'genai/tool', params: { error_rate: 0, service_time_ms: 10 } },
        ],
        calls: [{ from: 'agent', to: 'tool', per: 'step' }],
      },
      registry,
    );
    const run = runScenario(design, registry, constant(1200), { seed: 5 });
    const a = run.nodes.agent!.agent!;
    const steps = a.steps_sum.reduce((x, y) => x + y, 0) / a.completed.reduce((x, y) => x + y, 0);
    expect(steps).toBeGreaterThan(3.8);
    expect(steps).toBeLessThan(4.2);
  });
});

describe('determinism', () => {
  const design = parseDesign(
    {
      apiVersion: 'sim/v1',
      design: { id: 'det' },
      traffic: {
        classes: [{ id: 'c', entry: 'api', arrival: { kind: 'poisson', rate_rps: 100 }, client: { timeout_ms: 200, retry: { max: 2 } } }],
      },
      components: [
        { id: 'api', type: 'web/service' },
        { id: 'db', type: 'web/database', params: { concurrency: 2 } },
      ],
      calls: [{ from: 'api', to: 'db', policy: { timeout_ms: 100, retry: { max: 1, backoff: 'exponential', jitter: true } } }],
    },
    registry,
  );

  it('gives byte-identical results for the same seed', () => {
    const a = runScenario(design, registry, constant(60), { seed: 9 });
    const b = runScenario(design, registry, constant(60), { seed: 9 });
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });

  it('gives different results and run ids for a different seed', () => {
    const a = runScenario(design, registry, constant(60), { seed: 9 });
    const b = runScenario(design, registry, constant(60), { seed: 10 });
    expect(a.meta.run_id).not.toBe(b.meta.run_id);
    expect(canonicalJson(a.nodes)).not.toBe(canonicalJson(b.nodes));
  });
});

describe('design validation', () => {
  const base = {
    apiVersion: 'sim/v1',
    design: { id: 'bad' },
    traffic: { classes: [{ id: 'c', entry: 'a', arrival: { kind: 'poisson', rate_rps: 1 } }] },
  };

  it('rejects synchronous call cycles', () => {
    expect(() =>
      parseDesign(
        {
          ...base,
          components: [
            { id: 'a', type: 'web/service' },
            { id: 'b', type: 'web/service' },
          ],
          calls: [
            { from: 'a', to: 'b' },
            { from: 'b', to: 'a' },
          ],
        },
        registry,
      ),
    ).toThrow(/cycle/);
  });

  it('reports unknown types, unknown params and bad references together', () => {
    try {
      parseDesign(
        {
          ...base,
          components: [
            { id: 'a', type: 'web/nope' },
            { id: 'b', type: 'web/service', params: { concurency: 3 } },
          ],
          calls: [{ from: 'a', to: 'zzz' }],
        },
        registry,
      );
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(DesignError);
      const msg = (e as DesignError).problems.join('\n');
      expect(msg).toMatch(/unknown type web\/nope/);
      expect(msg).toMatch(/concurency/);
      expect(msg).toMatch(/unknown callee zzz/);
    }
  });
});
