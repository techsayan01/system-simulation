import type { LoadShape } from '@sim/model';

/** Traffic multiplier at time t (seconds). */
export function loadMultiplier(shape: LoadShape, t: number): number {
  switch (shape.kind) {
    case 'constant':
      return shape.mult;
    case 'ramp': {
      if (t <= shape.start_s) return shape.from;
      if (t >= shape.end_s) return shape.to;
      const f = (t - shape.start_s) / (shape.end_s - shape.start_s);
      return shape.from + f * (shape.to - shape.from);
    }
    case 'spike':
      return t >= shape.start_s && t < shape.end_s ? shape.peak : shape.base;
  }
}

export function maxMultiplier(shape: LoadShape): number {
  switch (shape.kind) {
    case 'constant':
      return shape.mult;
    case 'ramp':
      return Math.max(shape.from, shape.to);
    case 'spike':
      return Math.max(shape.base, shape.peak);
  }
}
