import type { AnalysisReport, Finding } from '@sim/detectors';
import type { RunResult } from '@sim/engine';

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: string, s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
export const bold = (s: string) => paint('1', s);
export const dim = (s: string) => paint('2', s);
export const red = (s: string) => paint('31', s);
export const green = (s: string) => paint('32', s);
export const yellow = (s: string) => paint('33', s);

// Severity is shown as a word, never by colour alone.
const SEV_LABEL = { high: red('HIGH  '), medium: yellow('MEDIUM'), low: dim('LOW   ') } as const;

export function formatFinding(f: Finding): string {
  const t = f.trigger;
  const lines = [
    `${SEV_LABEL[f.severity]} ${bold(f.id)} ${f.title}`,
    `       ${f.summary}`,
    dim(
      `       type ${f.type} · component ${f.component} · scenario ${f.scenario} · starts at ${t.time_s} s ` +
        `(${t.load_multiplier}x, ${t.load_rps} rps) · reproduced ${f.confidence.reproduced}/${f.confidence.seeds} seeds`,
    ),
    dim(
      `       metrics ${Object.entries(f.metrics)
        .filter(([, v]) => v !== null)
        .map(([k, v]) => `${k}=${v}`)
        .join(', ')}`,
    ),
    dim(
      `       evidence run ${f.evidence.run_id} (seed ${f.evidence.seed})` +
        (f.also_seen_in.length ? ` · also seen in ${f.also_seen_in.join(', ')}` : ''),
    ),
  ];
  return lines.join('\n');
}

export function formatReport(r: AnalysisReport, elapsedMs: number): string {
  const events = r.runs.reduce((s, x) => s + x.events, 0);
  const out = [
    bold(`Design ${r.design_id}`) +
      dim(
        ` · ${r.scenarios.length} scenarios × ${r.seeds.length} seeds = ${r.runs.length} runs · ` +
          `${(events / 1e6).toFixed(1)}M events · ${(elapsedMs / 1000).toFixed(1)} s`,
      ),
    dim(`Scenarios: ${r.scenarios.map((s) => s.id).join(', ')}`),
    '',
  ];
  const truncated = r.runs.filter((x) => x.truncated);
  if (truncated.length) out.push(yellow(`Warning: ${truncated.length} runs hit the event budget and were cut short.`), '');
  if (!r.findings.length) out.push(green('No findings.'));
  else {
    out.push(bold(`${r.findings.length} findings`), '');
    for (const f of r.findings) out.push(formatFinding(f), '');
  }
  return out.join('\n');
}

const fmt = (x: number | null | undefined, digits = 0) => (x === null || x === undefined ? '-' : x.toFixed(digits));

/** Ten-second summary table of one run. */
export function formatRun(run: RunResult, every = 10): string {
  const nodes = Object.keys(run.nodes);
  const head = ['t(s)', 'load', 'offered', 'ok', 'p99 ms', ...nodes.map((n) => `${n} util/queue/err`)];
  const rows: string[][] = [];
  const classes = Object.values(run.classes);
  for (let end = every; end <= run.load.length; end += every) {
    const lo = end - every;
    const sum = (xs: number[]) => xs.slice(lo, end).reduce((a, b) => a + b, 0);
    const offered = classes.reduce((s, c) => s + sum(c.offered), 0) / every;
    const ok = classes.reduce((s, c) => s + sum(c.ok), 0) / every;
    const p99 = Math.max(...classes.flatMap((c) => c.p99.slice(lo, end).filter((x): x is number => x !== null)), -1);
    rows.push([
      String(end),
      `${fmt(run.load[end - 1], 2)}x`,
      fmt(offered, 1),
      fmt(ok, 1),
      p99 < 0 ? '-' : fmt(p99),
      ...nodes.map((id) => {
        const s = run.nodes[id]!.series;
        const err = sum(s.errors) + sum(s.rejected) + sum(s.rate_limited);
        return `${fmt(s.utilization[end - 1], 2)}/${s.queue[end - 1]}/${err}`;
      }),
    ]);
  }
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padStart(widths[i]!)).join('  ');
  const t = run.totals;
  return [
    bold(`${run.meta.design_id} · ${run.meta.scenario_id} · seed ${run.meta.seed} · run ${run.meta.run_id}`),
    dim(
      `${run.meta.events} events${run.meta.truncated ? ' (TRUNCATED)' : ''} · requests ${t.requests}, ok ${t.ok}, failed ${t.failed}` +
        (Object.values(run.nodes).some((n) => n.primitive === 'llm')
          ? ` · LLM cost $${t.cost_usd.toFixed(2)}${t.cost_per_success_usd !== null ? ` ($${t.cost_per_success_usd.toFixed(4)} per success)` : ''}`
          : ''),
    ),
    dim('Rates are per second averaged over each 10 s; util/queue at the end of the interval; err = errors + rejected + 429 in the interval.'),
    line(head),
    ...rows.map(line),
  ].join('\n');
}
