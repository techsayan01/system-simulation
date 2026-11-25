/**
 * Deterministic random numbers. Each component, edge and traffic class gets its own
 * stream derived from (run seed, stream name), so adding a component never shifts the
 * draws of another one. That keeps before/after comparisons fair (common random numbers).
 */

/** FNV-1a 32-bit hash of a string. */
export function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function splitmix32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x9e3779b9) | 0;
    let t = a ^ (a >>> 16);
    t = Math.imul(t, 0x21f0aaad);
    t ^= t >>> 15;
    t = Math.imul(t, 0x735a2d97);
    t ^= t >>> 15;
    return t >>> 0;
  };
}

const rotl = (x: number, k: number) => (x << k) | (x >>> (32 - k));

/** xoshiro128** generator. */
export class Rng {
  private s0: number;
  private s1: number;
  private s2: number;
  private s3: number;

  constructor(seed: number, stream: string) {
    const sm = splitmix32(hash32(`${seed}:${stream}`));
    this.s0 = sm();
    this.s1 = sm();
    this.s2 = sm();
    this.s3 = sm();
    if ((this.s0 | this.s1 | this.s2 | this.s3) === 0) this.s0 = 1;
  }

  nextU32(): number {
    const result = Math.imul(rotl(Math.imul(this.s1, 5), 7), 9) >>> 0;
    const t = this.s1 << 9;
    this.s2 ^= this.s0;
    this.s3 ^= this.s1;
    this.s1 ^= this.s2;
    this.s0 ^= this.s3;
    this.s2 ^= t;
    this.s3 = rotl(this.s3, 11);
    return result;
  }

  /** Uniform in the open interval (0, 1). */
  next(): number {
    return (this.nextU32() + 1) / 4294967297;
  }

  /** Standard normal (Box-Muller). */
  normal(): number {
    return Math.sqrt(-2 * Math.log(this.next())) * Math.cos(2 * Math.PI * this.next());
  }

  exponential(mean: number): number {
    return -mean * Math.log(this.next());
  }
}
