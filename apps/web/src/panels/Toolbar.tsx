import { useLive } from '../sim/live.tsx';
import { EXAMPLES } from '../sim/examples.ts';

const SPEEDS = [1, 5, 20];

export function Toolbar({
  canRun,
  onExample,
  onNew,
  onAnalyze,
  onExport,
  analyzing,
}: {
  canRun: boolean;
  onExample: (id: string) => void;
  onNew: () => void;
  onAnalyze: () => void;
  onExport: () => void;
  analyzing: boolean;
}) {
  const live = useLive();
  const t = live.snapshot?.time_s ?? 0;
  return (
    <header className="toolbar">
      <div className="brand">System Simulator</div>
      <select
        className="examples"
        aria-label="Open an example"
        value=""
        onChange={(e) => {
          if (e.target.value === 'new') onNew();
          else if (e.target.value) onExample(e.target.value);
        }}
      >
        <option value="">Examples…</option>
        {EXAMPLES.map((x) => (
          <option key={x.id} value={x.id}>
            {x.title}
          </option>
        ))}
        <option value="new">Blank canvas</option>
      </select>
      <div className="divider" />
      {live.running ? (
        <button className="primary" onClick={live.pause}>
          ❚❚ Pause
        </button>
      ) : (
        <button className="primary" onClick={live.play} disabled={!canRun} title={canRun ? 'Start the simulation' : 'Fix the design problems first'}>
          ▶ Play
        </button>
      )}
      <button onClick={live.reset} disabled={!canRun} title="Start again from 0 s">
        ↺ Reset
      </button>
      <div className="seg" role="group" aria-label="Simulation speed">
        {SPEEDS.map((s) => (
          <button key={s} className={live.speed === s ? 'on' : ''} aria-pressed={live.speed === s} onClick={() => live.setSpeed(s)}>
            {s}×
          </button>
        ))}
      </div>
      <label className="traffic">
        <span>Traffic</span>
        <input
          type="range"
          aria-label="Traffic multiplier"
          min={0}
          max={100}
          value={Math.round((Math.log10(live.load) + 1) * 50)}
          onChange={(e) => live.setLoad(Math.round(10 ** (Number(e.target.value) / 50 - 1) * 10) / 10)}
          aria-valuetext={`${live.load} times normal traffic`}
        />
        <b>{live.load}×</b>
      </label>
      <span className="clock" aria-live="off">
        t = {Math.floor(t)} s{live.snapshot?.lagging ? <span className="warn-text"> · can't keep up</span> : null}
      </span>
      {live.overrides.size ? (
        <button className="link" onClick={live.clearFaults}>
          Clear {live.overrides.size} fault{live.overrides.size > 1 ? 's' : ''}
        </button>
      ) : null}
      <div className="spacer" />
      <button onClick={onAnalyze} disabled={!canRun || analyzing} title="Run the standard stress tests and list what breaks">
        {analyzing ? 'Testing…' : '🔍 Find problems'}
      </button>
      <button onClick={onExport} disabled={!canRun} title="Download the design as YAML for the sim command line">
        Export
      </button>
    </header>
  );
}
