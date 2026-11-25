import type { Dist } from '@sim/model';
import type { Rng } from './rng.ts';

export type Sampler = (rng: Rng) => number;

const Z95 = 1.6448536269514722;

/** Turn a distribution spec into a sampling function. */
export function compileDist(d: Dist): Sampler {
  if (typeof d === 'number') return () => d;
  switch (d.dist) {
    case 'const':
      return () => d.value;
    case 'exponential':
      return (rng) => rng.exponential(d.mean);
    case 'uniform':
      return (rng) => d.min + (d.max - d.min) * rng.next();
    case 'lognormal': {
      const mu = Math.log(d.p50);
      const sigma = Math.log(d.p95 / d.p50) / Z95;
      return (rng) => Math.exp(mu + sigma * rng.normal());
    }
  }
}

/** Mean of a distribution spec, used for reporting and analytic estimates. */
export function distMean(d: Dist): number {
  if (typeof d === 'number') return d;
  switch (d.dist) {
    case 'const':
      return d.value;
    case 'exponential':
      return d.mean;
    case 'uniform':
      return (d.min + d.max) / 2;
    case 'lognormal': {
      const sigma = Math.log(d.p95 / d.p50) / Z95;
      return d.p50 * Math.exp((sigma * sigma) / 2);
    }
  }
}
