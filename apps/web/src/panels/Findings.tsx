import type { AnalysisReport, Finding } from '@sim/detectors';
import { useLive } from '../sim/live.tsx';

export type AnalysisState =
  | { status: 'idle' }
  | { status: 'running'; done: number; total: number }
  | { status: 'done'; report: AnalysisReport; stale: boolean }
  | { status: 'error'; error: string };

/** Recreate the conditions of a finding on the live canvas. */
function useTryLive() {
  const live = useLive();
  return (f: Finding, llmIds: string[]): string => {
    live.reset();
    live.clearFaults();
    live.setLoad(1);
    let hint = '';
    if (f.scenario === 'spike' || f.scenario === 'ramp') {
      const m = Math.max(1.5, Math.ceil(f.trigger.load_multiplier * 2) / 2);
      live.setLoad(m);
      hint =
        f.scenario === 'spike'
          ? `Traffic set to ${m}×. After about a minute, drag Traffic back to 1× and watch whether the system recovers.`
          : `Traffic set to ${m}×, where this problem started in the ramp.`;
    } else if (f.scenario.startsWith('outage:')) {
      const target = f.scenario.slice('outage:'.length);
      live.setFault(target, { errorRate: 1 });
      hint = `${target} is taken down. Bring it back up from its panel to see whether the system recovers.`;
    } else if (f.scenario === 'limit-squeeze') {
      for (const id of llmIds) live.setFault(id, { limitScale: 0.5 });
      hint = 'LLM limits are halved at normal traffic.';
    }
    live.setSpeed(f.scenario.startsWith('outage:') || f.scenario === 'spike' ? 5 : live.speed);
    live.play();
    return hint;
  };
}

export function Findings({
  state,
  onAnalyze,
  onShow,
  onClose,
  llmIds,
  onHint,
  canRun,
}: {
  state: AnalysisState;
  onAnalyze: () => void;
  onShow: (component: string) => void;
  onClose: () => void;
  llmIds: string[];
  onHint: (h: string) => void;
  canRun: boolean;
}) {
  const tryLive = useTryLive();
  return (
    <section className="findings" aria-label="Problems found">
      <header>
        <h2>Problems found</h2>
        {state.status === 'done' ? (
          <span className="muted">
            {state.report.scenarios.length} stress tests × {state.report.seeds.length} seeds = {state.report.runs.length} simulations
            {state.stale ? ' · design changed since, run again' : ''}
          </span>
        ) : null}
        <span className="spacer" />
        <button onClick={onAnalyze} disabled={!canRun || state.status === 'running'}>
          {state.status === 'running' ? 'Testing…' : 'Run again'}
        </button>
        <button className="icon-btn" onClick={onClose} aria-label="Close problems panel">
          ×
        </button>
      </header>
      <div className="findings-body">
        {state.status === 'running' ? (
          <p className="muted">
            Stress-testing the design: {state.done}/{state.total} simulations (normal load, ramp to 5×, spike, limits halved, each dependency down)…
          </p>
        ) : state.status === 'error' ? (
          <p className="bad-text">{state.error}</p>
        ) : state.status === 'done' && !state.report.findings.length ? (
          <p className="good-text">No problems found. The design held up in every stress test.</p>
        ) : state.status === 'done' ? (
          <ol className="finding-list">
            {state.report.findings.map((f) => (
              <li key={f.id} className="finding-item">
                <div className="finding-top">
                  <span className={`sev ${f.severity}`}>{f.severity.toUpperCase()}</span>
                  <b>{f.title}</b>
                </div>
                <p>{f.summary}</p>
                <div className="finding-meta">
                  {f.scenario_title} · starts at {f.trigger.time_s}s, {f.trigger.load_multiplier}× traffic · seen in {f.confidence.reproduced}/{f.confidence.seeds} runs
                </div>
                <div className="finding-actions">
                  <button onClick={() => onShow(f.component)}>Show on canvas</button>
                  {f.scenario !== 'baseline' ? <button onClick={() => onHint(tryLive(f, llmIds))}>Watch it happen</button> : null}
                </div>
              </li>
            ))}
          </ol>
        ) : null}
      </div>
    </section>
  );
}
