import { Handle, Position, type NodeProps } from '@xyflow/react';
import { componentHealth, fmtMs, fmtPct, fmtRate, successRate, useLive, type Level } from '../sim/live.tsx';
import { Icon, itemForType, registry } from './catalog.tsx';
import type { ClientNode, ComponentNode } from './types.ts';

function Pill({ level, label }: { level: Level; label: string }) {
  return <span className={`pill ${level}`}>{label}</span>;
}

function Bar({ value, level }: { value: number; level: Level }) {
  return (
    <div className="bar" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(value * 100)} aria-label="utilization">
      <div className={`bar-fill ${level}`} style={{ width: `${Math.min(100, value * 100)}%` }} />
    </div>
  );
}

export function ComponentNodeView({ id, data, selected }: NodeProps<ComponentNode>) {
  const live = useLive();
  const st = live.snapshot?.nodes[id];
  const o = live.overrides.get(id);
  const h = componentHealth(st, o);
  const item = itemForType(data.type);
  const primitive = registry.get(data.type)?.primitive;
  const started = (live.snapshot?.time_s ?? 0) >= 1;
  const failures = st ? st.errors + st.rejected + st.rate_limited : 0;
  const failRate = st && st.arrivals ? failures / st.arrivals : 0;
  return (
    <div className={`node ${h.level} ${selected ? 'selected' : ''} ${live.highlight === id ? 'highlight' : ''}`}>
      <Handle type="target" position={Position.Left} />
      <div className="node-head">
        <span className="node-icon">
          <Icon name={item?.icon ?? 'service'} />
        </span>
        <span className="node-name">{id}</span>
        <Pill level={h.level} label={h.label} />
      </div>
      <div className="node-type">{item?.label ?? data.type}</div>
      {o?.slowdown && o.slowdown > 1 ? <div className="node-tag">slowed {o.slowdown}×</div> : null}
      {started && st ? (
        <div className="node-metrics">
          {primitive === 'station' || primitive === 'loop' ? (
            <>
              <Bar value={st.utilization} level={h.level} />
              <div className="row">
                <span>busy {fmtPct(st.utilization)}</span>
                <span>queue {fmtRate(st.queue)}</span>
              </div>
            </>
          ) : null}
          <div className="row">
            <span>in {fmtRate(st.arrivals)}/s</span>
            <span className={failRate >= 0.02 ? 'bad' : ''}>fail {fmtPct(failRate)}</span>
          </div>
          {primitive === 'llm' ? (
            <div className="row">
              <span className={st.rate_limited ? 'bad' : ''}>429 {fmtRate(st.rate_limited)}/s</span>
              <span>${(st.cost * 60).toFixed(2)}/min</span>
            </div>
          ) : null}
          {st.agent ? (
            <div className="row">
              <span>running {st.agent.active}</span>
              <span className={st.agent.runaway ? 'bad' : ''}>
                {st.agent.runaway ? `${st.agent.runaway} past ${st.agent.threshold} steps` : `max ${st.agent.max_steps} steps`}
              </span>
            </div>
          ) : null}
          {st.p99_ms !== null ? (
            <div className="row">
              <span>p99 {fmtMs(st.p99_ms)}</span>
            </div>
          ) : null}
        </div>
      ) : (
        <div className="node-hint">{item?.blurb}</div>
      )}
      {primitive !== 'llm' ? <Handle type="source" position={Position.Right} /> : null}
    </div>
  );
}

export function ClientNodeView({ id, data, selected }: NodeProps<ClientNode>) {
  const live = useLive();
  const st = live.snapshot?.classes[id];
  const started = (live.snapshot?.time_s ?? 0) >= 1;
  const success = st ? successRate(st.history.offered, st.history.ok) : null;
  const level: Level = !started || success === null ? 'idle' : success >= 0.98 ? 'ok' : success >= 0.8 ? 'warn' : 'critical';
  const label = level === 'idle' ? 'Idle' : level === 'ok' ? 'Happy' : level === 'warn' ? 'Some failing' : 'Mostly failing';
  const rate = data.rate_rps * live.load;
  return (
    <div className={`node client ${level} ${selected ? 'selected' : ''}`}>
      <div className="node-head">
        <span className="node-icon">
          <Icon name="client" />
        </span>
        <span className="node-name">{id}</span>
        <Pill level={level} label={label} />
      </div>
      <div className="node-type">
        Client · {fmtRate(rate)} req/s{live.load !== 1 ? ` (${live.load}× of ${fmtRate(data.rate_rps)})` : ''}
      </div>
      {started && st ? (
        <div className="node-metrics">
          <div className="row">
            <span>sent {fmtRate(st.offered)}/s</span>
            <span className={success !== null && success < 0.98 ? 'bad' : ''}>ok {success === null ? '–' : fmtPct(success)}</span>
          </div>
          <div className="row">
            <span>p99 {fmtMs(st.p99_ms)}</span>
            {data.retry_max ? <span>{data.retry_max} retries</span> : null}
          </div>
        </div>
      ) : (
        <div className="node-hint">Connect to the first component</div>
      )}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

export const nodeTypes = { component: ComponentNodeView, client: ClientNodeView };
