import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parse } from 'yaml';
import { parseDesign, type Design, type Registry } from '@sim/model';
import { defaultRegistry } from '@sim/packs';

export function loadDesign(path: string, registry: Registry = defaultRegistry()): { design: Design; registry: Registry } {
  const raw: unknown = parse(readFileSync(path, 'utf8'));
  return { design: parseDesign(raw, registry), registry };
}

export interface BenchmarkEntry {
  name: string;
  design: string;
  expect: string[];
  max_severity?: 'high' | 'medium' | 'low';
}

export function loadManifest(path: string): { dir: string; benchmarks: BenchmarkEntry[] } {
  const raw = parse(readFileSync(path, 'utf8')) as { benchmarks?: BenchmarkEntry[] };
  if (!raw?.benchmarks?.length) throw new Error(`${path}: no benchmarks listed`);
  const dir = dirname(resolve(path));
  return { dir, benchmarks: raw.benchmarks.map((b) => ({ ...b, design: resolve(dir, b.design) })) };
}
