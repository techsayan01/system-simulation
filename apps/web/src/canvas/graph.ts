import { DesignError, parseDesign, type CallPolicy, type Design } from '@sim/model';
import { PALETTE, registry, type PaletteItem } from './catalog.tsx';
import type { CallData, ClientData, ComponentData, RetrySettings, SimEdge, SimNode } from './types.ts';
import { NO_RETRY } from './types.ts';

export function uniqueId(base: string, taken: Iterable<string>): string {
  const set = new Set(taken);
  if (!set.has(base)) return base;
  for (let i = 2; ; i++) if (!set.has(`${base}-${i}`)) return `${base}-${i}`;
}

export function newNode(item: PaletteItem, id: string, position: { x: number; y: number }): SimNode {
  if (item.kind === 'client') {
    const data: ClientData = {
      kind: 'client',
      rate_rps: 20,
      input_tokens: { dist: 'lognormal', p50: 1200, p95: 3000 },
      output_tokens: { dist: 'lognormal', p50: 250, p95: 700 },
      ...NO_RETRY,
      timeout_ms: 5000,
    };
    return { id, type: 'client', position, data };
  }
  const type = registry.get(item.type!)!;
  const data: ComponentData = { kind: 'component', type: type.id, params: structuredClone(type.defaults) };
  return { id, type: 'component', position, data };
}

/** Sensible call settings for a new connection, based on what it connects. */
export function defaultCall(source: SimNode, target: SimNode): CallData {
  const targetType = target.data.kind === 'component' ? target.data.type : '';
  const fromAgent = source.data.kind === 'component' && registry.get(source.data.type)?.primitive === 'loop';
  const slow = targetType === 'genai/llm-provider' || targetType === 'genai/agent-loop';
  return {
    ...NO_RETRY,
    timeout_ms: slow ? 30_000 : 1_000,
    per: fromAgent ? 'step' : 'request',
    on_error: fromAgent && targetType === 'genai/tool' ? 'replan' : 'fail',
  };
}

function policyOf(r: RetrySettings): CallPolicy | undefined {
  const p: CallPolicy = {};
  if (r.timeout_ms !== null) p.timeout_ms = r.timeout_ms;
  if (r.retry_max > 0) p.retry = { max: r.retry_max, backoff: r.backoff, base_ms: r.base_ms, max_ms: 30_000, jitter: r.jitter };
  return Object.keys(p).length ? p : undefined;
}

export interface CanvasDesign {
  design: Design | null;
  problems: string[];
  /** Canvas edge id -> simulator call id, for showing live traffic on edges. */
  edgeIds: Map<string, string>;
}

/** Turn the canvas into a design file, or explain why it cannot run yet. */
export function toDesign(nodes: SimNode[], edges: SimEdge[]): CanvasDesign {
  const problems: string[] = [];
  const edgeIds = new Map<string, string>();
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const clients = nodes.filter((n) => n.data.kind === 'client');
  const components = nodes.filter((n) => n.data.kind === 'component');
  if (!clients.length) problems.push('Add a Client to send traffic into the design.');
  if (!components.length) problems.push('Add at least one component.');

  const classes = [];
  for (const c of clients) {
    const d = c.data as ClientData;
    const out = edges.filter((e) => e.source === c.id);
    if (out.length !== 1) {
      problems.push(`Client ${c.id} must connect to exactly one component (it has ${out.length}).`);
      continue;
    }
    const entry = out[0]!.target;
    if (byId.get(entry)?.data.kind !== 'component') {
      problems.push(`Client ${c.id} must connect to a component, not another client.`);
      continue;
    }
    edgeIds.set(out[0]!.id, `client(${c.id})->${entry}`);
    classes.push({
      id: c.id,
      entry,
      arrival: { kind: 'poisson', rate_rps: d.rate_rps },
      attrs: { input_tokens: d.input_tokens, output_tokens: d.output_tokens },
      client: policyOf(d),
    });
  }
  for (const e of edges) if (byId.get(e.target)?.data.kind === 'client') problems.push(`Nothing can call a client (${e.source} → ${e.target}).`);

  const calls = [];
  const seen = new Set<string>();
  for (const e of edges) {
    if (byId.get(e.source)?.data.kind !== 'component' || byId.get(e.target)?.data.kind !== 'component') continue;
    const d = e.data ?? { ...NO_RETRY, per: 'request', on_error: 'fail' };
    let id = `${e.source}->${e.target}`;
    for (let n = 2; seen.has(id); n++) id = `${e.source}->${e.target}#${n}`;
    seen.add(id);
    edgeIds.set(e.id, id);
    calls.push({ from: e.source, to: e.target, per: d.per, on_error: d.on_error, policy: policyOf(d) });
  }

  if (problems.length) return { design: null, problems, edgeIds };
  try {
    const design = parseDesign(
      {
        apiVersion: 'sim/v1',
        design: { id: 'canvas' },
        traffic: { classes },
        components: components.map((n) => ({ id: n.id, type: (n.data as ComponentData).type, params: (n.data as ComponentData).params })),
        calls,
      },
      registry,
    );
    return { design, problems: [], edgeIds };
  } catch (e) {
    if (e instanceof DesignError) return { design: null, problems: e.problems, edgeIds };
    return { design: null, problems: [String(e)], edgeIds };
  }
}

function retryOf(p: CallPolicy | undefined): RetrySettings {
  return {
    timeout_ms: p?.timeout_ms ?? null,
    retry_max: p?.retry?.max ?? 0,
    backoff: p?.retry?.backoff ?? 'none',
    base_ms: p?.retry?.base_ms ?? 100,
    jitter: p?.retry?.jitter ?? false,
  };
}

/** Lay out a design file on the canvas, left to right by call depth. */
export function fromDesign(design: Design): { nodes: SimNode[]; edges: SimEdge[] } {
  const componentIds = new Set(design.components.map((c) => c.id));
  const clientId = (cls: string) => (componentIds.has(cls) ? `${cls}-client` : cls);
  const depth = new Map<string, number>();
  const queue: string[] = [];
  for (const cls of design.traffic.classes) {
    depth.set(clientId(cls.id), 0);
    if (!depth.has(cls.entry)) {
      depth.set(cls.entry, 1);
      queue.push(cls.entry);
    }
  }
  while (queue.length) {
    const id = queue.shift()!;
    for (const c of design.calls.filter((x) => x.from === id)) {
      if (!depth.has(c.to)) {
        depth.set(c.to, depth.get(id)! + 1);
        queue.push(c.to);
      }
    }
  }
  for (const c of design.components) if (!depth.has(c.id)) depth.set(c.id, 1);
  const columns = new Map<number, string[]>();
  const order = [...design.traffic.classes.map((c) => clientId(c.id)), ...design.components.map((c) => c.id)];
  for (const id of order) {
    const d = depth.get(id)!;
    columns.set(d, [...(columns.get(d) ?? []), id]);
  }
  const pos = (id: string) => {
    const d = depth.get(id)!;
    const col = columns.get(d)!;
    const i = col.indexOf(id);
    return { x: 40 + d * 380, y: 220 + (i - (col.length - 1) / 2) * 200 };
  };

  const nodes: SimNode[] = [];
  const edges: SimEdge[] = [];
  for (const cls of design.traffic.classes) {
    const id = clientId(cls.id);
    nodes.push({
      id,
      type: 'client',
      position: pos(id),
      data: {
        kind: 'client',
        rate_rps: cls.arrival.rate_rps,
        input_tokens: cls.attrs.input_tokens ?? 0,
        output_tokens: cls.attrs.output_tokens ?? 0,
        ...retryOf(cls.client),
      },
    });
    edges.push({ id: `e-${id}-${cls.entry}`, source: id, target: cls.entry, type: 'flow', data: { ...retryOf(undefined), per: 'request', on_error: 'fail' } });
  }
  for (const c of design.components) {
    const type = registry.get(c.type)!;
    nodes.push({ id: c.id, type: 'component', position: pos(c.id), data: { kind: 'component', type: c.type, params: { ...structuredClone(type.defaults), ...c.params } } });
  }
  design.calls.forEach((c, i) => {
    edges.push({ id: `e-${c.from}-${c.to}-${i}`, source: c.from, target: c.to, type: 'flow', data: { ...retryOf(c.policy), per: c.per, on_error: c.on_error } });
  });
  return { nodes, edges };
}

export const paletteItem = (n: SimNode) =>
  n.data.kind === 'client' ? PALETTE[0]! : (PALETTE.find((p) => p.type === (n.data as ComponentData).type) ?? PALETTE[2]!);
