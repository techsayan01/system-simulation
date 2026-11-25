import {
  ComponentTypeSchema,
  DesignSchema,
  PARAM_SCHEMAS,
  type Component,
  type ComponentType,
  type Design,
  type LlmParams,
  type LoopParams,
  type Primitive,
  type RouterParams,
  type StationParams,
} from './schema.ts';

export class Registry {
  private readonly types = new Map<string, ComponentType>();

  constructor(types: unknown[] = []) {
    for (const t of types) this.add(t);
  }

  add(raw: unknown): void {
    const t = ComponentTypeSchema.parse(raw);
    if (this.types.has(t.id)) throw new Error(`duplicate component type ${t.id}`);
    this.types.set(t.id, t);
  }

  get(id: string): ComponentType | undefined {
    return this.types.get(id);
  }

  list(): ComponentType[] {
    return [...this.types.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  /** Stable fingerprint of type ids and versions, used in run ids. */
  fingerprint(): string {
    return this.list()
      .map((t) => `${t.id}@${t.version}`)
      .join(',');
  }
}

export type ResolvedComponent =
  | { id: string; type: ComponentType; primitive: 'station'; params: StationParams }
  | { id: string; type: ComponentType; primitive: 'router'; params: RouterParams }
  | { id: string; type: ComponentType; primitive: 'llm'; params: LlmParams }
  | { id: string; type: ComponentType; primitive: 'loop'; params: LoopParams };

export class DesignError extends Error {
  constructor(readonly problems: string[]) {
    super(`invalid design:\n  - ${problems.join('\n  - ')}`);
  }
}

/** Merge a component's params over its type defaults and validate them. */
export function resolveComponent(c: Component, registry: Registry): ResolvedComponent {
  const type = registry.get(c.type);
  if (!type) throw new DesignError([`component ${c.id}: unknown type ${c.type}`]);
  const merged = { ...type.defaults, ...c.params };
  const schema = PARAM_SCHEMAS[type.primitive as Primitive];
  const parsed = schema.safeParse(merged);
  if (!parsed.success) {
    throw new DesignError(
      parsed.error.issues.map((i) => `component ${c.id} (${c.type}): ${i.path.join('.') || 'params'}: ${i.message}`),
    );
  }
  return { id: c.id, type, primitive: type.primitive, params: parsed.data } as ResolvedComponent;
}

/** Parse and check a design: schema, references, call rules and absence of call cycles. */
export function parseDesign(raw: unknown, registry: Registry): Design {
  const parsed = DesignSchema.safeParse(raw);
  if (!parsed.success) {
    throw new DesignError(parsed.error.issues.map((i) => `${i.path.join('.') || 'design'}: ${i.message}`));
  }
  const design = parsed.data;
  const problems: string[] = [];
  const byId = new Map<string, Component>();
  for (const c of design.components) {
    if (byId.has(c.id)) problems.push(`duplicate component id ${c.id}`);
    byId.set(c.id, c);
    try {
      resolveComponent(c, registry);
    } catch (e) {
      if (e instanceof DesignError) problems.push(...e.problems);
      else throw e;
    }
  }
  const classIds = new Set<string>();
  for (const cls of design.traffic.classes) {
    if (classIds.has(cls.id)) problems.push(`duplicate traffic class ${cls.id}`);
    classIds.add(cls.id);
    if (!byId.has(cls.entry)) problems.push(`traffic class ${cls.id}: entry ${cls.entry} is not a component`);
  }
  const adjacency = new Map<string, string[]>();
  for (const call of design.calls) {
    const from = byId.get(call.from);
    if (!from) problems.push(`call ${call.from}->${call.to}: unknown caller ${call.from}`);
    if (!byId.has(call.to)) problems.push(`call ${call.from}->${call.to}: unknown callee ${call.to}`);
    if (from && call.per === 'step' && registry.get(from.type)?.primitive !== 'loop') {
      problems.push(`call ${call.from}->${call.to}: per: step is only allowed from agent-loop components`);
    }
    if (from && registry.get(from.type)?.primitive === 'llm') {
      problems.push(`call ${call.from}->${call.to}: LLM provider components cannot make calls`);
    }
    adjacency.set(call.from, [...(adjacency.get(call.from) ?? []), call.to]);
  }
  for (const c of design.components) {
    if (registry.get(c.type)?.primitive === 'router' && !adjacency.get(c.id)?.length) {
      problems.push(`component ${c.id}: a router needs at least one outgoing call`);
    }
  }
  const cycle = findCycle(adjacency);
  if (cycle) problems.push(`call cycle ${cycle.join(' -> ')} (synchronous cycles never terminate)`);
  if (problems.length) throw new DesignError(problems);
  return design;
}

function findCycle(adj: Map<string, string[]>): string[] | null {
  const state = new Map<string, 1 | 2>();
  const stack: string[] = [];
  const visit = (n: string): string[] | null => {
    state.set(n, 1);
    stack.push(n);
    for (const m of adj.get(n) ?? []) {
      if (state.get(m) === 1) return [...stack.slice(stack.indexOf(m)), m];
      if (!state.has(m)) {
        const c = visit(m);
        if (c) return c;
      }
    }
    stack.pop();
    state.set(n, 2);
    return null;
  };
  for (const n of [...adj.keys()].sort()) {
    if (!state.has(n)) {
      const c = visit(n);
      if (c) return c;
    }
  }
  return null;
}
