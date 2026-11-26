import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { LiveSim, type FaultOverride, type LiveSnapshot } from '@sim/engine';
import type { Design } from '@sim/model';
import { registry } from '../canvas/catalog.tsx';

export interface LiveState {
  snapshot: LiveSnapshot | null;
  running: boolean;
  speed: number;
  load: number;
  overrides: Map<string, FaultOverride>;
  edgeIds: Map<string, string>;
  highlight: string | null;
}

export interface LiveControls extends LiveState {
  play: () => void;
  pause: () => void;
  reset: () => void;
  setSpeed: (s: number) => void;
  setLoad: (m: number) => void;
  setFault: (componentId: string, o: FaultOverride | null) => void;
  clearFaults: () => void;
}

const Ctx = createContext<LiveControls | null>(null);

export function useLive(): LiveControls {
  const v = useContext(Ctx);
  if (!v) throw new Error('useLive outside LiveProvider');
  return v;
}

/**
 * Runs the engine in the browser in small steps on each animation frame. Changing the
 * design rebuilds the simulation from time zero, keeping the traffic level and faults.
 */
export function LiveProvider({
  design,
  edgeIds,
  highlight,
  children,
}: {
  design: Design | null;
  edgeIds: Map<string, string>;
  highlight: string | null;
  children: ReactNode;
}) {
  const simRef = useRef<LiveSim | null>(null);
  const [snapshot, setSnapshot] = useState<LiveSnapshot | null>(null);
  const [running, setRunning] = useState(false);
  const [speed, setSpeedState] = useState(1);
  const [load, setLoadState] = useState(1);
  const [overrides, setOverrides] = useState(() => new Map<string, FaultOverride>());
  const [resetToken, setResetToken] = useState(0);
  const speedRef = useRef(speed);
  const loadRef = useRef(load);
  const overridesRef = useRef(overrides);
  speedRef.current = speed;
  loadRef.current = load;
  overridesRef.current = overrides;

  const designKey = design ? JSON.stringify(design) : '';
  useEffect(() => {
    if (!design) {
      simRef.current = null;
      setSnapshot(null);
      setRunning(false);
      return;
    }
    const sim = new LiveSim(design, registry, 1);
    sim.setLoad(loadRef.current);
    const ids = new Set(design.components.map((c) => c.id));
    for (const [id, o] of overridesRef.current) if (ids.has(id)) sim.setOverride(id, o);
    simRef.current = sim;
    setSnapshot(sim.snapshot());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [designKey, resetToken]);

  useEffect(() => {
    if (!running) return;
    let raf = 0;
    let last = performance.now();
    let lastSnap = 0;
    const frame = (now: number) => {
      const dt = Math.min(0.25, (now - last) / 1000);
      last = now;
      const sim = simRef.current;
      if (sim) {
        sim.advance(dt * speedRef.current);
        if (now - lastSnap > 200) {
          lastSnap = now;
          setSnapshot(sim.snapshot());
        }
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [running]);

  const setLoad = useCallback((m: number) => {
    setLoadState(m);
    simRef.current?.setLoad(m);
  }, []);

  const setFault = useCallback((id: string, o: FaultOverride | null) => {
    simRef.current?.setOverride(id, o);
    setOverrides((prev) => {
      const next = new Map(prev);
      if (o) next.set(id, o);
      else next.delete(id);
      return next;
    });
  }, []);

  const clearFaults = useCallback(() => {
    for (const id of overridesRef.current.keys()) simRef.current?.setOverride(id, null);
    setOverrides(new Map());
  }, []);

  const value: LiveControls = {
    snapshot,
    running,
    speed,
    load,
    overrides,
    edgeIds,
    highlight,
    play: () => design && setRunning(true),
    pause: () => setRunning(false),
    reset: () => setResetToken((t) => t + 1),
    setSpeed: setSpeedState,
    setLoad,
    setFault,
    clearFaults,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Health of a component from its live numbers, with a word for it (never colour alone). */
export type Level = 'idle' | 'ok' | 'warn' | 'critical' | 'down';

export function componentHealth(
  st: LiveSnapshot['nodes'][string] | undefined,
  o: FaultOverride | undefined,
): { level: Level; label: string } {
  if (o?.errorRate !== undefined && o.errorRate >= 1) return { level: 'down', label: 'Down' };
  if (!st || (st.arrivals === 0 && st.busy === 0 && st.queue === 0)) return { level: 'idle', label: o?.slowdown ? 'Slowed' : 'Idle' };
  const failRate = (st.errors + st.rejected + st.rate_limited) / Math.max(1, st.arrivals);
  if (st.agent && st.agent.runaway > 0) return { level: 'critical', label: 'Runaway' };
  if (st.agent && st.agent.max_steps > st.agent.threshold / 2) return { level: 'warn', label: 'Looping' };
  const saturated = st.concurrency !== null && st.utilization >= 0.95 && st.queue > 0;
  if (saturated) return { level: 'critical', label: 'Overloaded' };
  if (failRate >= 0.2) return { level: 'critical', label: st.rate_limited > st.errors ? 'Rate limited' : 'Failing' };
  if ((st.concurrency !== null && st.utilization >= 0.75) || failRate >= 0.02) {
    return { level: 'warn', label: failRate >= 0.02 ? (st.rate_limited > st.errors ? '429s' : 'Errors') : 'Busy' };
  }
  if (o?.slowdown) return { level: 'warn', label: 'Slowed' };
  return { level: 'ok', label: 'Healthy' };
}

/**
 * Share of requests that succeeded over the last few seconds. A single second undercounts,
 * because requests still in flight at the window edge have not succeeded yet.
 */
export function successRate(offered: number[], ok: number[], n = 5): number | null {
  const o = offered.slice(-n).reduce((a, b) => a + b, 0);
  const k = ok.slice(-n).reduce((a, b) => a + b, 0);
  return o > 0 ? Math.min(1, k / o) : null;
}

export const sumSeries = (list: number[][]) => (list.length ? list[0]!.map((_, i) => list.reduce((a, s) => a + (s[i] ?? 0), 0)) : []);

export const fmtRate = (x: number) => (x >= 1000 ? `${(x / 1000).toFixed(1)}k` : x >= 100 ? x.toFixed(0) : x >= 10 ? x.toFixed(0) : x.toFixed(1).replace(/\.0$/, ''));
export const fmtMs = (x: number | null) => (x === null ? '–' : x >= 10_000 ? `${(x / 1000).toFixed(0)} s` : x >= 1000 ? `${(x / 1000).toFixed(1)} s` : `${Math.round(x)} ms`);
export const fmtPct = (x: number) => `${Math.round(x * 100)}%`;
