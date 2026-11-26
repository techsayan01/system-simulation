import { parse } from 'yaml';
import { parseDesign } from '@sim/model';
import retryStorm from '../../../../benchmarks/retry-storm.yaml?raw';
import rateLimit from '../../../../benchmarks/rate-limit-cascade.yaml?raw';
import runaway from '../../../../benchmarks/runaway-agent.yaml?raw';
import healthy from '../../../../benchmarks/healthy.yaml?raw';
import { registry } from '../canvas/catalog.tsx';
import { fromDesign } from '../canvas/graph.ts';

export const EXAMPLES = [
  { id: 'retry-storm', title: 'Web checkout with a hidden retry storm', yaml: retryStorm },
  { id: 'rate-limit-cascade', title: 'Chat assistant hitting LLM rate limits', yaml: rateLimit },
  { id: 'runaway-agent', title: 'Support agent that can loop forever', yaml: runaway },
  { id: 'healthy', title: 'Well-built web + GenAI app', yaml: healthy },
];

export function loadExample(id: string) {
  const ex = EXAMPLES.find((e) => e.id === id)!;
  const design = parseDesign(parse(ex.yaml), registry);
  return { ...fromDesign(design), description: design.design.description ?? '' };
}
