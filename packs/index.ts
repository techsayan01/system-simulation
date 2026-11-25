import { Registry } from '@sim/model';
import webService from './web/service.json' with { type: 'json' };
import webDatabase from './web/database.json' with { type: 'json' };
import webLoadBalancer from './web/load-balancer.json' with { type: 'json' };
import llmProvider from './genai/llm-provider.json' with { type: 'json' };
import agentLoop from './genai/agent-loop.json' with { type: 'json' };
import tool from './genai/tool.json' with { type: 'json' };

export const WEB_PACK = [webService, webDatabase, webLoadBalancer];
export const GENAI_PACK = [llmProvider, agentLoop, tool];

/** Registry with every built-in component type. */
export function defaultRegistry(): Registry {
  return new Registry([...WEB_PACK, ...GENAI_PACK]);
}
