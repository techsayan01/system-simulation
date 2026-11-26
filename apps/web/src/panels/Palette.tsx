import { Icon, PALETTE, type PaletteItem } from '../canvas/catalog.tsx';

export const DRAG_TYPE = 'application/x-sim-component';

export function Palette({ onAdd }: { onAdd: (item: PaletteItem) => void }) {
  const groups = ['Traffic', 'Web', 'GenAI'] as const;
  return (
    <aside className="palette" aria-label="Components">
      <h2>Components</h2>
      <p className="hint">Drag onto the canvas, or click to add. Connect by dragging from a component's right edge to another's left edge.</p>
      {groups.map((g) => (
        <section key={g}>
          <h3>{g}</h3>
          {PALETTE.filter((p) => p.group === g).map((p) => (
            <button
              key={p.label}
              className="palette-item"
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData(DRAG_TYPE, String(PALETTE.indexOf(p)));
                e.dataTransfer.effectAllowed = 'move';
              }}
              onClick={() => onAdd(p)}
              title={p.blurb}
            >
              <span className="palette-icon">
                <Icon name={p.icon} />
              </span>
              <span>
                <span className="palette-label">{p.label}</span>
                <span className="palette-blurb">{p.blurb}</span>
              </span>
            </button>
          ))}
        </section>
      ))}
    </aside>
  );
}
