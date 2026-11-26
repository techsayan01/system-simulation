/// <reference lib="webworker" />
import { analyze } from '@sim/detectors';
import type { Design } from '@sim/model';
import { defaultRegistry } from '@sim/packs';

// Runs the full scenario battery off the main thread so the canvas stays responsive.
self.onmessage = (e: MessageEvent<{ design: Design }>) => {
  try {
    const report = analyze(e.data.design, defaultRegistry(), {
      onRun: (s, seed) => self.postMessage({ type: 'progress', scenario: s.id, seed }),
    });
    self.postMessage({ type: 'done', report });
  } catch (err) {
    self.postMessage({ type: 'error', error: err instanceof Error ? err.message : String(err) });
  }
};
