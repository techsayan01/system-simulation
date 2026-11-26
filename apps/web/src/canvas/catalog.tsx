import type { ReactElement } from 'react';
import { defaultRegistry } from '@sim/packs';

export const registry = defaultRegistry();

export type IconName = 'client' | 'lb' | 'service' | 'db' | 'llm' | 'agent' | 'tool';

export interface PaletteItem {
  kind: 'client' | 'component';
  type?: string;
  label: string;
  idBase: string;
  icon: IconName;
  group: 'Traffic' | 'Web' | 'GenAI';
  blurb: string;
}

export const PALETTE: PaletteItem[] = [
  { kind: 'client', label: 'Client', idBase: 'users', icon: 'client', group: 'Traffic', blurb: 'Sends requests at a set rate' },
  { kind: 'component', type: 'web/load-balancer', label: 'Load balancer', idBase: 'lb', icon: 'lb', group: 'Web', blurb: 'Spreads requests across backends' },
  { kind: 'component', type: 'web/service', label: 'Service', idBase: 'api', icon: 'service', group: 'Web', blurb: 'Application server with workers' },
  { kind: 'component', type: 'web/database', label: 'Database', idBase: 'db', icon: 'db', group: 'Web', blurb: 'Connection pool and queries' },
  { kind: 'component', type: 'genai/llm-provider', label: 'LLM provider', idBase: 'llm', icon: 'llm', group: 'GenAI', blurb: 'Token limits, latency and price' },
  { kind: 'component', type: 'genai/agent-loop', label: 'Agent loop', idBase: 'agent', icon: 'agent', group: 'GenAI', blurb: 'Repeats LLM and tool steps' },
  { kind: 'component', type: 'genai/tool', label: 'Tool', idBase: 'tool', icon: 'tool', group: 'GenAI', blurb: 'Search, API or function call' },
];

export const itemForType = (type: string) => PALETTE.find((p) => p.type === type);

const paths: Record<IconName, ReactElement> = {
  client: (
    <>
      <circle cx="10" cy="7" r="3" />
      <path d="M4 17c0-3.3 2.7-5 6-5s6 1.7 6 5" />
    </>
  ),
  lb: (
    <>
      <circle cx="4" cy="10" r="2" />
      <path d="M6 10h3M9 10l5-5M9 10l5 5M9 10h5" />
      <circle cx="16" cy="5" r="1.6" />
      <circle cx="16" cy="10" r="1.6" />
      <circle cx="16" cy="15" r="1.6" />
    </>
  ),
  service: (
    <>
      <rect x="3" y="4" width="14" height="5" rx="1.5" />
      <rect x="3" y="11" width="14" height="5" rx="1.5" />
      <path d="M6 6.5h.01M6 13.5h.01" />
    </>
  ),
  db: (
    <>
      <ellipse cx="10" cy="5" rx="6" ry="2.5" />
      <path d="M4 5v10c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5V5M4 10c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5" />
    </>
  ),
  llm: (
    <>
      <path d="M10 2.5l1.6 4.4 4.4 1.6-4.4 1.6L10 14.5l-1.6-4.4L4 8.5l4.4-1.6z" />
      <path d="M15.5 13l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z" />
    </>
  ),
  agent: (
    <>
      <path d="M15.5 8a6 6 0 0 0-10.6-2.5M4.5 12a6 6 0 0 0 10.6 2.5" />
      <path d="M4.5 3v3h3M15.5 17v-3h-3" />
    </>
  ),
  tool: <path d="M12.5 3.5a3.5 3.5 0 0 0-3.3 4.6L3.5 13.8 6.2 16.5l5.7-5.7a3.5 3.5 0 0 0 4.6-3.3l-2.2 2.2-2.3-.6-.6-2.3z" />,
};

export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {paths[name]}
    </svg>
  );
}
