import { describe, expect, it } from 'vitest';
import { Rng } from '../src/rng.ts';

describe('Rng', () => {
  it('repeats the same sequence for the same seed and stream', () => {
    const a = new Rng(42, 'node:db');
    const b = new Rng(42, 'node:db');
    const xs = Array.from({ length: 1000 }, () => a.nextU32());
    const ys = Array.from({ length: 1000 }, () => b.nextU32());
    expect(xs).toEqual(ys);
  });

  it('gives independent streams for different names and seeds', () => {
    const a = new Rng(42, 'node:db').nextU32();
    expect(new Rng(42, 'node:api').nextU32()).not.toBe(a);
    expect(new Rng(43, 'node:db').nextU32()).not.toBe(a);
  });

  it('produces uniform values in (0, 1) with the right mean', () => {
    const r = new Rng(1, 'u');
    let sum = 0;
    for (let i = 0; i < 200_000; i++) {
      const x = r.next();
      expect(x).toBeGreaterThan(0);
      expect(x).toBeLessThan(1);
      sum += x;
    }
    expect(sum / 200_000).toBeCloseTo(0.5, 2);
  });

  it('produces exponential samples with the requested mean', () => {
    const r = new Rng(7, 'e');
    let sum = 0;
    for (let i = 0; i < 200_000; i++) sum += r.exponential(10);
    expect(sum / 200_000).toBeGreaterThan(9.8);
    expect(sum / 200_000).toBeLessThan(10.2);
  });
});
