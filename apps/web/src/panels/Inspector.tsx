import { useEffect, useState } from 'react';
import type { Dist } from '@sim/model';
import { itemForType, registry } from '../canvas/catalog.tsx';
import type { Backoff, CallData, ClientData, ComponentData, RetrySettings, SimEdge, SimNode } from '../canvas/types.ts';
import { componentHealth, fmtMs, fmtRate, successRate, useLive } from '../sim/live.tsx';
import { CheckField, DistField, NumberField, SelectField, Sparkline } from './fields.tsx';

const PARAM_INFO: Record<string, { label: string; help?: string; nullLabel?: string }> = {
  concurrency: { label: 'Workers', help: 'Requests it can work on at the same time. A worker stays busy while it waits for the components it calls.' },
  service_time_ms: { label: 'Processing time (ms)', help: 'Time spent on each request, not counting calls to other components.' },
  queue_limit: { label: 'Queue limit', help: 'Requests waiting beyond this are rejected straight away.', nullLabel: 'no limit' },
  error_rate: { label: 'Error rate (0–1)', help: 'Share of requests that fail on their own.' },
  strategy: { label: 'Routing' },
  rpm: { label: 'Requests per minute limit', nullLabel: 'no limit' },
  itpm: { label: 'Input tokens per minute limit', nullLabel: 'no limit' },
  otpm: { label: 'Output tokens per minute limit', nullLabel: 'no limit' },
  count_rejected_toward_rpm: { label: 'Rejected (429) calls count toward the request limit' },
  max_concurrency: { label: 'Max requests at once', nullLabel: 'unlimited' },
  ttft_ms: { label: 'Time to first token (ms)' },
  output_tps: { label: 'Output speed (tokens/s)' },
  price_input_per_mtok: { label: '$ per 1M input tokens' },
  price_output_per_mtok: { label: '$ per 1M output tokens' },
  step_overhead_ms: { label: 'Overhead per step (ms)' },
  steps_mean: { label: 'Average steps to finish', help: 'After each clean step the agent stops with probability 1 ÷ this.' },
  loop_cap: { label: 'Step cap', help: 'Stop after this many steps.', nullLabel: 'no cap' },
  budget_cap_usd: { label: 'Budget cap per request ($)', nullLabel: 'no cap' },
  context_growth_tokens_per_step: { label: 'Context growth per step (tokens)' },
  step_output_tokens: { label: 'Output tokens per step' },
};
const DIST_KEYS = new Set(['service_time_ms', 'ttft_ms', 'step_overhead_ms', 'step_output_tokens']);
const NULLABLE = new Set(['concurrency', 'queue_limit', 'rpm', 'itpm', 'otpm', 'max_concurrency', 'loop_cap', 'budget_cap_usd']);

function ParamField({ k, value, onChange }: { k: string; value: unknown; onChange: (v: unknown) => void }) {
  const info = PARAM_INFO[k] ?? { label: k.replaceAll('_', ' ') };
  if (DIST_KEYS.has(k)) return <DistField label={info.label} value={value as Dist} onChange={onChange} help={info.help} />;
  if (typeof value === 'boolean') return <CheckField label={info.label} value={value} onChange={onChange} help={info.help} />;
  if (k === 'strategy') {
    return (
      <SelectField
        label={info.label}
        value={value as 'round_robin' | 'random'}
        options={[
          { value: 'round_robin', label: 'round robin' },
          { value: 'random', label: 'random (by weight)' },
        ]}
        onChange={onChange}
      />
    );
  }
  return (
    <NumberField
      label={info.label}
      value={value as number | null}
      onChange={onChange}
      help={info.help}
      nullable={NULLABLE.has(k)}
      nullLabel={info.nullLabel}
      step={k === 'error_rate' ? 0.01 : 'any'}
    />
  );
}

function RetryFields({ value, onChange, who }: { value: RetrySettings; onChange: (v: Partial<RetrySettings>) => void; who: string }) {
  return (
    <>
      <NumberField label="Timeout (ms)" value={value.timeout_ms} nullable nullLabel="no timeout" onChange={(v) => onChange({ timeout_ms: v })} help={`How long ${who} waits before giving up on a call.`} />
      <NumberField label="Retries" value={value.retry_max} step={1} onChange={(v) => onChange({ retry_max: Math.round(v ?? 0) })} help="Extra attempts after a failure or timeout." />
      {value.retry_max > 0 ? (
        <>
          <SelectField<Backoff>
            label="Wait between retries"
            value={value.backoff}
            options={[
              { value: 'none', label: 'none (retry at once)' },
              { value: 'constant', label: 'fixed wait' },
              { value: 'exponential', label: 'doubling wait (exponential backoff)' },
            ]}
            onChange={(v) => onChange({ backoff: v })}
          />
          {value.backoff !== 'none' ? <NumberField label="First wait (ms)" value={value.base_ms} onChange={(v) => onChange({ base_ms: v ?? 0 })} /> : null}
          <CheckField label="Add random jitter to the wait" value={value.jitter} onChange={(v) => onChange({ jitter: v })} />
        </>
      ) : null}
    </>
  );
}

function NameField({ id, onRename }: { id: string; onRename: (next: string) => string | null }) {
  const [text, setText] = useState(id);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setText(id);
    setError(null);
  }, [id]);
  const commit = () => {
    if (text === id) return;
    const err = onRename(text);
    setError(err);
    if (err) setText(id);
  };
  return (
    <div className="field">
      <label htmlFor="node-name">Name</label>
      <input id="node-name" value={text} onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
      {error ? <div className="help bad-text">{error}</div> : null}
    </div>
  );
}

export interface InspectorProps {
  node: SimNode | null;
  edge: SimEdge | null;
  nodes: SimNode[];
  onNodeData: (id: string, data: Partial<ClientData> | Partial<ComponentData>) => void;
  onEdgeData: (id: string, data: Partial<CallData>) => void;
  onRename: (id: string, next: string) => string | null;
  onDelete: () => void;
}

export function Inspector(p: InspectorProps) {
  const live = useLive();
  if (p.edge) return <EdgeInspector {...p} edge={p.edge} />;
  if (p.node?.data.kind === 'client') return <ClientInspector {...p} node={p.node} data={p.node.data as ClientData} />;
  if (p.node) return <ComponentInspector {...p} node={p.node} data={p.node.data as ComponentData} />;
  const s = live.snapshot;
  const cls = s ? Object.values(s.classes) : [];
  return (
    <aside className="inspector" aria-label="Details">
      <h2>Whole system</h2>
      {s && s.time_s >= 1 ? (
        <>
          <Sparkline
            label="Requests per second: sent vs succeeded"
            series={[
              { data: sum(cls.map((c) => c.history.offered)) },
              { data: sum(cls.map((c) => c.history.ok)), cls: 'good' },
            ]}
          />
          <div className="kv">
            <span>Success</span>
            <b>{(() => { const r = successRate(sum(cls.map((c) => c.history.offered)), sum(cls.map((c) => c.history.ok))); return r === null ? '–' : `${Math.round(r * 100)}%`; })()}</b>
            <span>Slowest 1% (p99)</span>
            <b>{fmtMs(s.totals.p99_ms)}</b>
            <span>LLM spend</span>
            <b>${s.totals.cost_per_min.toFixed(2)}/min</b>
          </div>
        </>
      ) : (
        <p className="hint">Press Play to start the simulation. Select a component or connection to change its settings, see its live numbers, or break it on purpose.</p>
      )}
      <h3>How to read the canvas</h3>
      <ul className="legend-list">
        <li><span className="swatch ok" /> Healthy · <span className="swatch warn" /> busy or some errors · <span className="swatch critical" /> overloaded or failing · <span className="swatch down" /> down</li>
        <li>Dots on a connection are calls in flight; more dots means more calls per second. Red dots are calls that fail or time out.</li>
        <li>↻ is retries per second, ⏱ is timeouts per second.</li>
      </ul>
    </aside>
  );
}

const sum = (list: number[][]) => (list.length ? list[0]!.map((_, i) => list.reduce((a, s) => a + (s[i] ?? 0), 0)) : []);

function LiveActions({ id }: { id: string }) {
  const live = useLive();
  const o = live.overrides.get(id);
  const down = (o?.errorRate ?? 0) >= 1;
  const slow = (o?.slowdown ?? 1) > 1;
  return (
    <div className="actions">
      <button className={down ? 'danger active' : 'danger'} onClick={() => live.setFault(id, down ? null : { errorRate: 1 })} aria-pressed={down}>
        {down ? 'Bring back up' : 'Take down'}
      </button>
      <button className={slow ? 'active' : ''} onClick={() => live.setFault(id, slow ? null : { slowdown: 5 })} aria-pressed={slow}>
        {slow ? 'Restore speed' : 'Slow down 5×'}
      </button>
    </div>
  );
}

function ComponentInspector({ node, data, onNodeData, onRename, onDelete }: InspectorProps & { node: SimNode; data: ComponentData }) {
  const live = useLive();
  const type = registry.get(data.type)!;
  const st = live.snapshot?.nodes[node.id];
  const h = componentHealth(st, live.overrides.get(node.id));
  return (
    <aside className="inspector" aria-label="Component details">
      <h2>{itemForType(data.type)?.label ?? data.type}</h2>
      <p className="hint">{type.description}</p>
      <NameField id={node.id} onRename={(next) => onRename(node.id, next)} />
      <h3>Live</h3>
      <div className="kv">
        <span>Status</span>
        <b className={`level-text ${h.level}`}>{h.label}</b>
      </div>
      {st && live.snapshot!.time_s >= 1 ? (
        <>
          {st.concurrency !== null || type.primitive === 'loop' ? <Sparkline label="Busy" series={[{ data: st.history.utilization }]} max={1} /> : null}
          <Sparkline label="Calls in per second" series={[{ data: st.history.arrivals }]} />
          <Sparkline label="Failures per second" series={[{ data: st.history.failures, cls: 'bad' }]} />
          {st.concurrency !== null ? <Sparkline label="Waiting in queue" series={[{ data: st.history.queue }]} /> : null}
        </>
      ) : null}
      <LiveActions id={node.id} />
      <h3>Settings</h3>
      {Object.entries(data.params).map(([k, v]) => (
        <ParamField key={k} k={k} value={v} onChange={(nv) => onNodeData(node.id, { params: { ...data.params, [k]: nv } })} />
      ))}
      <button className="danger wide" onClick={onDelete}>
        Delete {node.id}
      </button>
    </aside>
  );
}

function ClientInspector({ node, data, onNodeData, onRename, onDelete }: InspectorProps & { node: SimNode; data: ClientData }) {
  const live = useLive();
  const st = live.snapshot?.classes[node.id];
  const set = (d: Partial<ClientData>) => onNodeData(node.id, d);
  return (
    <aside className="inspector" aria-label="Client details">
      <h2>Client</h2>
      <p className="hint">Users or another system sending requests. Its single connection goes to the first component they call.</p>
      <NameField id={node.id} onRename={(next) => onRename(node.id, next)} />
      {st && live.snapshot!.time_s >= 1 ? (
        <>
          <h3>Live</h3>
          <Sparkline label="Sent vs succeeded per second" series={[{ data: st.history.offered }, { data: st.history.ok, cls: 'good' }]} />
          <div className="kv">
            <span>Slowest 1% (p99)</span>
            <b>{fmtMs(st.p99_ms)}</b>
          </div>
        </>
      ) : null}
      <h3>Traffic</h3>
      <NumberField label="Requests per second" value={data.rate_rps} min={0.01} onChange={(v) => v && set({ rate_rps: v })} help="Normal traffic. The Traffic slider in the toolbar multiplies it while the simulation runs." />
      <DistField label="Input tokens per request" value={data.input_tokens} onChange={(d) => set({ input_tokens: d })} help="Only matters when the request reaches an LLM." />
      <DistField label="Output tokens per request" value={data.output_tokens} onChange={(d) => set({ output_tokens: d })} />
      <h3>How the client calls</h3>
      <RetryFields value={data} onChange={set} who="the client" />
      <button className="danger wide" onClick={onDelete}>
        Delete {node.id}
      </button>
    </aside>
  );
}

function EdgeInspector({ edge, nodes, onEdgeData, onDelete }: InspectorProps & { edge: SimEdge }) {
  const live = useLive();
  const src = nodes.find((n) => n.id === edge.source);
  const fromClient = src?.data.kind === 'client';
  const fromAgent = src?.data.kind === 'component' && registry.get((src.data as ComponentData).type)?.primitive === 'loop';
  const d = edge.data!;
  const simId = live.edgeIds.get(edge.id);
  const st = simId ? live.snapshot?.edges[simId] : undefined;
  const set = (x: Partial<CallData>) => onEdgeData(edge.id, x);
  return (
    <aside className="inspector" aria-label="Connection details">
      <h2>
        {edge.source} → {edge.target}
      </h2>
      {st && live.snapshot!.time_s >= 1 ? (
        <div className="kv">
          <span>Calls per second</span>
          <b>{fmtRate(st.attempts)}</b>
          <span>of which retries</span>
          <b className={st.retries ? 'warn-text' : ''}>{fmtRate(st.retries)}</b>
          <span>Timeouts per second</span>
          <b className={st.timeouts ? 'bad-text' : ''}>{fmtRate(st.timeouts)}</b>
          <span>Gave up per second</span>
          <b className={st.failed ? 'bad-text' : ''}>{fmtRate(st.failed)}</b>
        </div>
      ) : null}
      {fromClient ? (
        <p className="hint">Timeouts and retries for this connection are set on the client {edge.source}.</p>
      ) : (
        <>
          {fromAgent ? (
            <>
              <SelectField
                label="When"
                value={d.per}
                options={[
                  { value: 'step', label: 'every agent step' },
                  { value: 'request', label: 'once, before the loop' },
                ]}
                onChange={(v) => set({ per: v })}
              />
            </>
          ) : null}
          <SelectField
            label="If this call finally fails"
            value={d.on_error}
            options={[
              { value: 'fail', label: `${edge.source} fails the request` },
              ...(fromAgent ? [{ value: 'replan' as const, label: 'the agent tries another step' }] : []),
              { value: 'ignore', label: 'carry on anyway' },
            ]}
            onChange={(v) => set({ on_error: v })}
          />
          <RetryFields value={d} onChange={set} who={edge.source} />
        </>
      )}
      <button className="danger wide" onClick={onDelete}>
        Delete connection
      </button>
    </aside>
  );
}
