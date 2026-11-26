import type { Edge, Node } from '@xyflow/react';
import type { Dist } from '@sim/model';

export type Backoff = 'none' | 'constant' | 'exponential';

export interface RetrySettings {
  timeout_ms: number | null;
  retry_max: number;
  backoff: Backoff;
  base_ms: number;
  jitter: boolean;
}

/** A traffic source: becomes a traffic class in the design. */
export interface ClientData extends RetrySettings, Record<string, unknown> {
  kind: 'client';
  rate_rps: number;
  input_tokens: Dist;
  output_tokens: Dist;
}

export interface ComponentData extends Record<string, unknown> {
  kind: 'component';
  type: string;
  params: Record<string, unknown>;
}

export interface CallData extends RetrySettings, Record<string, unknown> {
  per: 'request' | 'step';
  on_error: 'fail' | 'replan' | 'ignore';
}

export type ClientNode = Node<ClientData, 'client'>;
export type ComponentNode = Node<ComponentData, 'component'>;
export type SimNode = ClientNode | ComponentNode;
export type SimEdge = Edge<CallData, 'flow'>;

export const NO_RETRY: RetrySettings = { timeout_ms: null, retry_max: 0, backoff: 'none', base_ms: 100, jitter: false };
