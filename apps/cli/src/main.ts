#!/usr/bin/env -S npx tsx
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { analyze, SEVERITY_RANK, type Severity } from '@sim/detectors';
import { runScenario } from '@sim/engine';
import { DesignError } from '@sim/model';
import { defaultRegistry } from '@sim/packs';
import { standardBattery } from '@sim/scenarios';
import { runBenchmarks } from './bench.ts';
import { bold, dim, formatReport, formatRun, green, red } from './format.ts';
import { loadDesign } from './load.ts';

const HELP = `sim: design-time simulation (Phase 0 prototype)

Usage:
  sim analyze <design.yaml> [--seeds 1,2,3] [--json out.json] [--fail-on high|medium|low]
      Run the standard scenario battery and report findings with evidence.
  sim run <design.yaml> [--scenario spike] [--seed 1] [--json out.json]
      Run one scenario from the battery and print a 10-second summary.
  sim scenarios <design.yaml>
      List the battery scenarios generated for a design.
  sim bench [manifest.yaml] [--seeds 1,2,3] [--json out.json]
      Run the Phase 0 gate over the benchmark designs.
  sim types
      List built-in component types.
`;

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(resolve(path)), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
  console.log(dim(`Wrote ${path}`));
}

function parseSeeds(s: string | undefined): number[] {
  if (!s) return [1, 2, 3];
  const seeds = s.split(',').map((x) => Number(x.trim()));
  if (!seeds.length || seeds.some((x) => !Number.isInteger(x))) throw new Error(`--seeds must be comma-separated integers`);
  return seeds;
}

function main(argv: string[]): number {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      seeds: { type: 'string' },
      seed: { type: 'string' },
      scenario: { type: 'string' },
      json: { type: 'string' },
      'fail-on': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [cmd, arg] = positionals;
  if (!cmd || values.help) {
    console.log(HELP);
    return cmd ? 0 : 1;
  }

  switch (cmd) {
    case 'analyze': {
      if (!arg) throw new Error('analyze needs a design file');
      const { design, registry } = loadDesign(arg);
      const t0 = performance.now();
      const report = analyze(design, registry, {
        seeds: parseSeeds(values.seeds),
        onRun: (s, seed) => process.stderr.write(dim(`\r  ran ${s.id} seed ${seed}`.padEnd(60))),
      });
      process.stderr.write('\r'.padEnd(62) + '\r');
      console.log(formatReport(report, performance.now() - t0));
      if (values.json) writeJson(values.json, report);
      const failOn = values['fail-on'] as Severity | undefined;
      if (failOn) {
        if (!(failOn in SEVERITY_RANK)) throw new Error('--fail-on must be high, medium or low');
        if (report.findings.some((f) => SEVERITY_RANK[f.severity] >= SEVERITY_RANK[failOn])) return 2;
      }
      return 0;
    }
    case 'run': {
      if (!arg) throw new Error('run needs a design file');
      const { design, registry } = loadDesign(arg);
      const battery = standardBattery(design, registry);
      const id = values.scenario ?? 'baseline';
      const scenario = battery.find((s) => s.id === id);
      if (!scenario) throw new Error(`unknown scenario ${id}; available: ${battery.map((s) => s.id).join(', ')}`);
      const run = runScenario(design, registry, scenario, { seed: Number(values.seed ?? 1) });
      console.log(formatRun(run));
      if (values.json) writeJson(values.json, run);
      return 0;
    }
    case 'scenarios': {
      if (!arg) throw new Error('scenarios needs a design file');
      const { design, registry } = loadDesign(arg);
      for (const s of standardBattery(design, registry)) console.log(`${bold(s.id.padEnd(22))} ${s.title} (${s.duration_s} s)`);
      return 0;
    }
    case 'types': {
      for (const t of defaultRegistry().list()) {
        console.log(`${bold(t.id.padEnd(20))} ${t.primitive.padEnd(8)} ${dim(t.fidelity)}  ${t.description}`);
      }
      return 0;
    }
    case 'bench': {
      const manifest = arg ?? resolve(repoRoot, 'benchmarks/manifest.yaml');
      const t0 = performance.now();
      const gate = runBenchmarks(manifest, parseSeeds(values.seeds), (m) => process.stderr.write(dim(`  ${m}\n`)));
      console.log('');
      for (const o of gate.outcomes) {
        console.log(`${o.passed ? green('PASS') : red('FAIL')} ${bold(o.name)}`);
        console.log(`     expected: ${o.expected.length ? o.expected.join(', ') : 'nothing'}`);
        console.log(`     detected: ${o.detected.length ? o.detected.join(', ') : 'nothing'}${o.missing.length ? red(` · missing ${o.missing.join(', ')}`) : ''}`);
        if (o.extra.length) console.log(dim(`     other findings: ${o.extra.join('; ')}`));
        console.log(
          dim(
            `     at normal load: ${o.baselineFindings.length ? red(o.baselineFindings.join(', ')) : 'clean'} · deterministic: ${o.deterministic ? 'yes' : red('NO')}` +
              ` · truncated runs: ${o.truncatedRuns}` +
              (o.severityViolations.length ? red(` · above allowed severity: ${o.severityViolations.join(', ')}`) : ''),
          ),
        );
      }
      console.log('');
      console.log(
        `${gate.passed ? green('GATE PASSED') : red('GATE FAILED')} · detected ${gate.detectedTotal}/${gate.expectedTotal} expected failure modes · ` +
          dim(`${((performance.now() - t0) / 1000).toFixed(1)} s`),
      );
      if (values.json) writeJson(values.json, gate.outcomes.map(({ report, ...o }) => ({ ...o, findings: report.findings })));
      return gate.passed ? 0 : 1;
    }
    default:
      console.error(`unknown command ${cmd}\n`);
      console.log(HELP);
      return 1;
  }
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (e) {
  if (e instanceof DesignError) console.error(red(e.message));
  else console.error(red(e instanceof Error ? e.message : String(e)));
  process.exitCode = 1;
}
