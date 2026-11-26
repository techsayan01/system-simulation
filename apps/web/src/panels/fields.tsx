import { useEffect, useId, useState } from 'react';
import type { Dist } from '@sim/model';

/** Number input that commits on blur or Enter, so typing does not restart the simulation. */
export function NumberField({
  label,
  value,
  onChange,
  help,
  min = 0,
  step = 'any',
  nullable,
  nullLabel = 'unlimited',
}: {
  label: string;
  value: number | null;
  onChange: (v: number | null) => void;
  help?: string;
  min?: number;
  step?: number | 'any';
  nullable?: boolean;
  nullLabel?: string;
}) {
  const id = useId();
  const [text, setText] = useState(value === null ? '' : String(value));
  useEffect(() => setText(value === null ? '' : String(value)), [value]);
  const commit = () => {
    if (text.trim() === '') {
      if (nullable) onChange(null);
      else setText(value === null ? '' : String(value));
      return;
    }
    const n = Number(text);
    if (Number.isFinite(n) && n >= min) onChange(n);
    else setText(value === null ? '' : String(value));
  };
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <div className="field-row">
        <input
          id={id}
          type="number"
          inputMode="decimal"
          min={min}
          step={step}
          value={text}
          disabled={nullable && value === null}
          placeholder={nullable && value === null ? nullLabel : undefined}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        />
        {nullable ? (
          <label className="check">
            <input
              type="checkbox"
              checked={value === null}
              onChange={(e) => onChange(e.target.checked ? null : Number(text) || 1)}
            />
            {nullLabel}
          </label>
        ) : null}
      </div>
      {help ? <div className="help">{help}</div> : null}
    </div>
  );
}

export function SelectField<T extends string>({
  label,
  value,
  options,
  onChange,
  help,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  help?: string;
}) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value as T)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {help ? <div className="help">{help}</div> : null}
    </div>
  );
}

export function CheckField({ label, value, onChange, help }: { label: string; value: boolean; onChange: (v: boolean) => void; help?: string }) {
  return (
    <div className="field">
      <label className="check">
        <input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} />
        {label}
      </label>
      {help ? <div className="help">{help}</div> : null}
    </div>
  );
}

type DistKind = 'const' | 'lognormal' | 'exponential' | 'uniform';
const kindOf = (d: Dist): DistKind => (typeof d === 'number' ? 'const' : d.dist);

/** Editor for a value that varies from request to request. */
export function DistField({ label, value, onChange, help }: { label: string; value: Dist; onChange: (d: Dist) => void; help?: string }) {
  const kind = kindOf(value);
  const mean = typeof value === 'number' ? value : value.dist === 'const' ? value.value : value.dist === 'lognormal' ? value.p50 : value.dist === 'exponential' ? value.mean : (value.min + value.max) / 2;
  const setKind = (k: DistKind) => {
    if (k === 'const') onChange(mean);
    else if (k === 'lognormal') onChange({ dist: 'lognormal', p50: mean || 1, p95: (mean || 1) * 3 });
    else if (k === 'exponential') onChange({ dist: 'exponential', mean: mean || 1 });
    else onChange({ dist: 'uniform', min: mean * 0.5, max: mean * 1.5 });
  };
  return (
    <div className="field dist">
      <div className="dist-head">
        <span className="dist-label">{label}</span>
        <select aria-label={`${label} distribution`} value={kind} onChange={(e) => setKind(e.target.value as DistKind)}>
          <option value="const">fixed</option>
          <option value="lognormal">typical + slow tail</option>
          <option value="exponential">random (exponential)</option>
          <option value="uniform">between two values</option>
        </select>
      </div>
      <div className="dist-grid">
        {typeof value === 'number' || value.dist === 'const' ? (
          <NumberField label="value" value={mean} onChange={(v) => onChange(v ?? 0)} />
        ) : value.dist === 'lognormal' ? (
          <>
            <NumberField label="typical (p50)" value={value.p50} min={0.001} onChange={(v) => v && onChange({ ...value, p50: v, p95: Math.max(v, value.p95) })} />
            <NumberField label="slow (p95)" value={value.p95} min={0.001} onChange={(v) => v && onChange({ ...value, p95: Math.max(v, value.p50) })} />
          </>
        ) : value.dist === 'exponential' ? (
          <NumberField label="mean" value={value.mean} min={0.001} onChange={(v) => v && onChange({ ...value, mean: v })} />
        ) : (
          <>
            <NumberField label="min" value={value.min} onChange={(v) => onChange({ ...value, min: v ?? 0, max: Math.max(v ?? 0, value.max) })} />
            <NumberField label="max" value={value.max} onChange={(v) => onChange({ ...value, max: Math.max(v ?? 0, value.min) })} />
          </>
        )}
      </div>
      {help ? <div className="help">{help}</div> : null}
    </div>
  );
}

/** Tiny line chart of the last minute or so. */
export function Sparkline({ label, series, max, unit = '' }: { label: string; series: { data: number[]; cls?: string }[]; max?: number; unit?: string }) {
  const W = 240;
  const H = 38;
  const n = Math.max(2, ...series.map((s) => s.data.length));
  const top = max ?? Math.max(1e-9, ...series.flatMap((s) => s.data));
  const pts = (d: number[]) => d.map((v, i) => `${((i / (n - 1)) * W).toFixed(1)},${(H - 2 - (Math.min(v, top) / top) * (H - 4)).toFixed(1)}`).join(' ');
  const current = series[0]?.data.at(-1);
  return (
    <div className="spark">
      <div className="spark-head">
        <span>{label}</span>
        <span className="spark-val">{current === undefined ? '–' : `${Number.isInteger(current) ? current : current.toFixed(2)}${unit}`}</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none" aria-hidden="true">
        {series.map((s, i) => (
          <polyline key={i} points={pts(s.data)} className={`spark-line ${s.cls ?? ''}`} />
        ))}
      </svg>
    </div>
  );
}
