import {
  addEdge,
  Background,
  Controls,
  MarkerType,
  MiniMap,
  Panel,
  ReactFlow,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type IsValidConnection,
} from '@xyflow/react';
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { stringify } from 'yaml';
import { PALETTE, registry, type PaletteItem } from './canvas/catalog.tsx';
import { edgeTypes } from './canvas/edges.tsx';
import { defaultCall, newNode, toDesign, uniqueId } from './canvas/graph.ts';
import { nodeTypes } from './canvas/nodes.tsx';
import type { CallData, ClientData, ComponentData, SimEdge, SimNode } from './canvas/types.ts';
import { Findings, type AnalysisState } from './panels/Findings.tsx';
import { Inspector } from './panels/Inspector.tsx';
import { DRAG_TYPE, Palette } from './panels/Palette.tsx';
import { Toolbar } from './panels/Toolbar.tsx';
import { loadExample } from './sim/examples.ts';
import { fmtMs, LiveProvider, successRate, sumSeries, useLive } from './sim/live.tsx';

const STORAGE_KEY = 'system-simulator.canvas.v1';

function loadSaved(): { nodes: SimNode[]; edges: SimEdge[] } | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as { nodes: SimNode[]; edges: SimEdge[] };
    return Array.isArray(v.nodes) && Array.isArray(v.edges) ? v : null;
  } catch {
    return null;
  }
}

const initial = loadSaved() ?? loadExample('retry-storm');

const defaultEdgeOptions = { type: 'flow' as const, markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 } };

function Stats() {
  const live = useLive();
  const s = live.snapshot;
  if (!s || s.time_s < 1) return null;
  const cls = Object.values(s.classes);
  const success = successRate(sumSeries(cls.map((c) => c.history.offered)), sumSeries(cls.map((c) => c.history.ok)));
  const hasLlm = Object.values(s.nodes).some((n) => n.primitive === 'llm');
  return (
    <div className="stats" aria-live="off">
      <span>
        <b>{s.totals.offered}</b> req/s
      </span>
      <span className={success !== null && success < 0.98 ? 'bad-text' : ''}>
        <b>{success === null ? '–' : `${Math.round(success * 100)}%`}</b> succeed
      </span>
      <span>
        p99 <b>{fmtMs(s.totals.p99_ms)}</b>
      </span>
      {hasLlm ? (
        <span>
          LLM <b>${s.totals.cost_per_min.toFixed(2)}</b>/min
        </span>
      ) : null}
    </div>
  );
}

export function App() {
  const [nodes, setNodes, onNodesChange] = useNodesState<SimNode>(initial.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<SimEdge>(initial.edges);
  const [highlight, setHighlight] = useState<string | null>(null);
  const [hint, setHint] = useState<string>('description' in initial ? String(initial.description) : '');
  const [analysis, setAnalysis] = useState<AnalysisState>({ status: 'idle' });
  const [showFindings, setShowFindings] = useState(false);
  const flow = useReactFlow<SimNode, SimEdge>();
  const workerRef = useRef<Worker | null>(null);
  const canvasRef = useRef<HTMLElement | null>(null);

  const canvas = useMemo(() => toDesign(nodes, edges), [nodes, edges]);
  const designKey = canvas.design ? JSON.stringify(canvas.design) : '';
  const analyzedKey = useRef('');

  // Save the canvas for next time (best effort).
  useEffect(() => {
    const t = setTimeout(() => {
      try {
        localStorage.setItem(
          STORAGE_KEY,
          JSON.stringify({
            nodes: nodes.map(({ id, type, position, data }) => ({ id, type, position, data })),
            edges: edges.map(({ id, source, target, type, data }) => ({ id, source, target, type, data })),
          }),
        );
      } catch {
        /* storage unavailable */
      }
    }, 400);
    return () => clearTimeout(t);
  }, [nodes, edges]);

  useEffect(() => {
    setAnalysis((a) => (a.status === 'done' ? { ...a, stale: analyzedKey.current !== designKey } : a));
  }, [designKey]);

  const selectedNode = nodes.find((n) => n.selected) ?? null;
  const selectedEdge = selectedNode ? null : (edges.find((e) => e.selected) ?? null);

  const addItem = useCallback(
    (item: PaletteItem, position?: { x: number; y: number }) => {
      const id = uniqueId(item.idBase, nodes.map((n) => n.id));
      let pos = position;
      if (!pos) {
        // Middle of the visible canvas, moved down until it does not cover another node.
        const r = canvasRef.current?.getBoundingClientRect();
        const c = flow.screenToFlowPosition(r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : { x: 600, y: 400 });
        pos = { x: c.x - 110, y: c.y - 50 };
        const overlaps = (p: { x: number; y: number }) => nodes.some((n) => Math.abs(n.position.x - p.x) < 240 && Math.abs(n.position.y - p.y) < 140);
        for (let i = 0; i < 20 && overlaps(pos); i++) pos = { x: pos.x, y: pos.y + 150 };
      }
      setNodes((ns) => [...ns.map((n) => ({ ...n, selected: false })), { ...newNode(item, id, pos), selected: true }]);
    },
    [nodes, flow, setNodes],
  );

  const onDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault();
      const idx = e.dataTransfer.getData(DRAG_TYPE);
      if (idx === '') return;
      const item = PALETTE[Number(idx)];
      if (!item) return;
      const p = flow.screenToFlowPosition({ x: e.clientX, y: e.clientY });
      addItem(item, { x: p.x - 100, y: p.y - 40 });
    },
    [flow, addItem],
  );

  const onConnect = useCallback(
    (c: Connection) => {
      const s = nodes.find((n) => n.id === c.source);
      const t = nodes.find((n) => n.id === c.target);
      if (!s || !t) return;
      setEdges((es) => addEdge({ ...c, id: `e-${c.source}-${c.target}-${Date.now()}`, type: 'flow', data: defaultCall(s, t) }, es));
    },
    [nodes, setEdges],
  );

  const isValidConnection: IsValidConnection<SimEdge> = useCallback(
    (c) => {
      if (c.source === c.target) return false;
      const t = nodes.find((n) => n.id === c.target);
      const s = nodes.find((n) => n.id === c.source);
      if (!s || !t || t.data.kind === 'client') return false;
      if (s.data.kind === 'component' && registry.get((s.data as ComponentData).type)?.primitive === 'llm') return false;
      if (s.data.kind === 'client' && edges.some((e) => e.source === s.id)) return false;
      return !edges.some((e) => e.source === c.source && e.target === c.target);
    },
    [nodes, edges],
  );

  const onNodeData = useCallback(
    (id: string, d: Partial<ClientData> | Partial<ComponentData>) =>
      setNodes((ns) => ns.map((n) => (n.id === id ? ({ ...n, data: { ...n.data, ...d } } as SimNode) : n))),
    [setNodes],
  );

  const onEdgeData = useCallback(
    (id: string, d: Partial<CallData>) => setEdges((es) => es.map((e) => (e.id === id ? { ...e, data: { ...e.data!, ...d } } : e))),
    [setEdges],
  );

  const onRename = useCallback(
    (id: string, next: string): string | null => {
      const name = next.trim();
      if (!/^[a-zA-Z0-9_-]+$/.test(name)) return 'Use letters, digits, - and _ only.';
      if (nodes.some((n) => n.id === name)) return `${name} is already used.`;
      setNodes((ns) => ns.map((n) => (n.id === id ? { ...n, id: name } : n)));
      setEdges((es) => es.map((e) => ({ ...e, source: e.source === id ? name : e.source, target: e.target === id ? name : e.target })));
      return null;
    },
    [nodes, setNodes, setEdges],
  );

  const onDelete = useCallback(() => {
    if (selectedNode) flow.deleteElements({ nodes: [{ id: selectedNode.id }] });
    else if (selectedEdge) flow.deleteElements({ edges: [{ id: selectedEdge.id }] });
  }, [flow, selectedNode, selectedEdge]);

  const openExample = useCallback(
    (id: string) => {
      const ex = loadExample(id);
      setNodes(ex.nodes);
      setEdges(ex.edges);
      setHint(ex.description);
      setAnalysis({ status: 'idle' });
      setShowFindings(false);
      setTimeout(() => flow.fitView({ padding: 0.2, duration: 300 }), 50);
    },
    [flow, setNodes, setEdges],
  );

  const analyze = useCallback(() => {
    if (!canvas.design) return;
    workerRef.current?.terminate();
    const w = new Worker(new URL('./sim/analyze.worker.ts', import.meta.url), { type: 'module' });
    workerRef.current = w;
    const llms = canvas.design.components.filter((c) => registry.get(c.type)?.primitive === 'llm').length;
    const leaves = canvas.design.components.filter((c) => !canvas.design!.calls.some((x) => x.from === c.id) && registry.get(c.type)?.primitive !== 'router').length;
    const total = (3 + (llms ? 1 : 0) + leaves) * 3;
    let done = 0;
    analyzedKey.current = designKey;
    setShowFindings(true);
    setAnalysis({ status: 'running', done, total });
    w.onmessage = (e) => {
      if (e.data.type === 'progress') setAnalysis({ status: 'running', done: ++done, total });
      else if (e.data.type === 'done') {
        setAnalysis({ status: 'done', report: e.data.report, stale: false });
        w.terminate();
      } else {
        setAnalysis({ status: 'error', error: e.data.error });
        w.terminate();
      }
    };
    w.postMessage({ design: canvas.design });
  }, [canvas.design, designKey]);

  const exportYaml = useCallback(() => {
    if (!canvas.design) return;
    const blob = new Blob([stringify(canvas.design)], { type: 'text/yaml' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'design.yaml';
    a.click();
    URL.revokeObjectURL(a.href);
  }, [canvas.design]);

  const showOnCanvas = useCallback(
    (component: string) => {
      setHighlight(component);
      setNodes((ns) => ns.map((n) => ({ ...n, selected: n.id === component })));
      const n = flow.getNode(component);
      if (n) flow.setCenter(n.position.x + 110, n.position.y + 60, { zoom: 1.1, duration: 400 });
      setTimeout(() => setHighlight(null), 2500);
    },
    [flow, setNodes],
  );

  const llmIds = canvas.design?.components.filter((c) => registry.get(c.type)?.primitive === 'llm').map((c) => c.id) ?? [];

  return (
    <LiveProvider design={canvas.design} edgeIds={canvas.edgeIds} highlight={highlight}>
      <div className="app">
        <Toolbar
          canRun={!!canvas.design}
          onExample={openExample}
          onNew={() => {
            setNodes([]);
            setEdges([]);
            setHint('Drag a Client and some components from the left, connect them, then press Play.');
            setAnalysis({ status: 'idle' });
          }}
          onAnalyze={analyze}
          onExport={exportYaml}
          analyzing={analysis.status === 'running'}
        />
        <Palette onAdd={(item) => addItem(item)} />
        <main className="canvas" ref={canvasRef} onDragOver={(e) => (e.preventDefault(), (e.dataTransfer.dropEffect = 'move'))} onDrop={onDrop}>
          <ReactFlow<SimNode, SimEdge>
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            isValidConnection={isValidConnection}
            defaultEdgeOptions={defaultEdgeOptions}
            deleteKeyCode={['Backspace', 'Delete']}
            colorMode="system"
            fitView
            fitViewOptions={{ padding: 0.2 }}
            proOptions={{ hideAttribution: false }}
          >
            <Background gap={20} />
            <Controls />
            <MiniMap pannable zoomable />
            <Panel position="top-left">
              <Stats />
            </Panel>
            {canvas.problems.length ? (
              <Panel position="top-center">
                <div className="problems" role="status">
                  <b>Not ready to run yet</b>
                  <ul>
                    {canvas.problems.slice(0, 4).map((p) => (
                      <li key={p}>{p}</li>
                    ))}
                  </ul>
                </div>
              </Panel>
            ) : hint ? (
              <Panel position="bottom-center">
                <div className="hint-bar">
                  <span>{hint}</span>
                  <button className="icon-btn" aria-label="Dismiss" onClick={() => setHint('')}>
                    ×
                  </button>
                </div>
              </Panel>
            ) : null}
          </ReactFlow>
          {showFindings ? (
            <Findings
              state={analysis}
              onAnalyze={analyze}
              onShow={showOnCanvas}
              onClose={() => setShowFindings(false)}
              llmIds={llmIds}
              onHint={setHint}
              canRun={!!canvas.design}
            />
          ) : null}
        </main>
        <Inspector node={selectedNode} edge={selectedEdge} nodes={nodes} onNodeData={onNodeData} onEdgeData={onEdgeData} onRename={onRename} onDelete={onDelete} />
      </div>
    </LiveProvider>
  );
}
