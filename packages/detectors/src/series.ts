import type { RunResult } from '@sim/engine';
import type { Trigger } from './types.ts';

export const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);

export function mean(xs: readonly number[]): number | null {
  return xs.length ? sum(xs) / xs.length : null;
}

export const pct = (x: number | null) => (x === null ? null : Math.round(x * 1000) / 10);
export const r2 = (x: number) => Math.round(x * 100) / 100;

/** First run of at least `minLen` consecutive true values starting at or after `from`. */
export function firstEpisode(cond: readonly boolean[], minLen: number, from = 0): { start: number; end: number } | null {
  let start = -1;
  for (let i = from; i <= cond.length; i++) {
    if (i < cond.length && cond[i]) {
      if (start < 0) start = i;
    } else if (start >= 0) {
      if (i - start >= minLen) return { start, end: i };
      start = -1;
    }
  }
  return null;
}

/** Successful client requests / offered client requests per window, smoothed over `smooth` windows. */
export function goodputRatio(run: RunResult, smooth = 5): (number | null)[] {
  const classes = Object.values(run.classes);
  const n = run.load.length;
  const offered = Array.from({ length: n }, (_, w) => sum(classes.map((c) => c.offered[w]!)));
  const ok = Array.from({ length: n }, (_, w) => sum(classes.map((c) => c.ok[w]!)));
  return offered.map((_, w) => {
    const lo = Math.max(0, w - smooth + 1);
    const o = sum(offered.slice(lo, w + 1));
    return o > 0 ? Math.min(1, sum(ok.slice(lo, w + 1)) / o) : null;
  });
}

export function minOf(xs: readonly (number | null)[]): number | null {
  const v = xs.filter((x): x is number => x !== null);
  return v.length ? Math.min(...v) : null;
}

export function meanOf(xs: readonly (number | null)[]): number | null {
  return mean(xs.filter((x): x is number => x !== null));
}

export function triggerAt(run: RunResult, w: number): Trigger {
  const mult = run.load[w] ?? 1;
  return { time_s: w, load_multiplier: r2(mult), load_rps: r2(mult * run.meta.base_rps) };
}
