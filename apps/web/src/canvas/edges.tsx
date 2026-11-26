import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from '@xyflow/react';
import { fmtRate, useLive } from '../sim/live.tsx';
import type { SimEdge } from './types.ts';

/**
 * A connection that shows traffic: moving dots whose number follows the call rate,
 * red dots for the share of calls that fail or time out, and a label with the rate.
 */
export function FlowEdge(props: EdgeProps<SimEdge>) {
  const { id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, selected, markerEnd } = props;
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
  const live = useLive();
  const simId = live.edgeIds.get(id);
  const st = simId ? live.snapshot?.edges[simId] : undefined;
  const started = (live.snapshot?.time_s ?? 0) >= 1;
  const rate = started && st ? st.attempts : 0;
  const bad = st && st.attempts ? Math.min(1, (st.attempts - st.ok) / st.attempts) : 0;
  const n = rate <= 0 ? 0 : Math.max(1, Math.min(12, Math.round(Math.log2(rate + 1) * 1.6)));
  const redDots = Math.round(n * bad);
  const dur = 1.8 / Math.max(0.5, Math.min(4, Math.sqrt(live.speed)));
  const level = bad >= 0.2 ? 'critical' : bad >= 0.02 || (st?.retries ?? 0) > 0 ? 'warn' : rate > 0 ? 'ok' : 'idle';

  const policy: string[] = [];
  if (data?.per === 'step') policy.push('per step');
  if (data?.retry_max) policy.push(`${data.retry_max} ${data.retry_max === 1 ? 'retry' : 'retries'}${data.backoff === 'none' ? ', no backoff' : ''}`);
  if (data?.timeout_ms) policy.push(`timeout ${data.timeout_ms >= 1000 ? `${data.timeout_ms / 1000}s` : `${data.timeout_ms}ms`}`);
  if (data?.on_error === 'replan') policy.push('on fail: replan');

  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} className={`flow-edge ${level} ${selected ? 'selected' : ''}`} style={{ strokeWidth: 1.5 + Math.min(4, Math.log10(rate + 1) * 1.6) }} />
      {live.running && n > 0
        ? Array.from({ length: n }, (_, i) => (
            <circle key={`${n}-${i}`} r={3.2} className={i < redDots ? 'dot bad' : 'dot'}>
              <animateMotion dur={`${dur}s`} repeatCount="indefinite" begin={`-${((i * dur) / n).toFixed(3)}s`} path={path} />
            </circle>
          ))
        : null}
      <EdgeLabelRenderer>
        <div className={`edge-label nodrag nopan ${selected ? 'selected' : ''}`} style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}>
          {policy.length ? <div className="edge-policy">{policy.join(' · ')}</div> : null}
          {started && st ? (
            <div className="edge-rate">
              {fmtRate(st.attempts)}/s
              {st.retries ? <span className="warn-text"> · ↻ {fmtRate(st.retries)}/s</span> : null}
              {st.timeouts ? <span className="bad-text"> · ⏱ {fmtRate(st.timeouts)}/s</span> : null}
            </div>
          ) : null}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

export const edgeTypes = { flow: FlowEdge };
