import { z } from 'zod';

/**
 * Probability distribution for a sampled quantity. A bare number is a constant.
 * Times are in milliseconds, token counts in tokens.
 */
export const DistSchema = z.union([
  z.number().nonnegative(),
  z.object({ dist: z.literal('const'), value: z.number().nonnegative() }).strict(),
  z.object({ dist: z.literal('exponential'), mean: z.number().positive() }).strict(),
  z
    .object({ dist: z.literal('lognormal'), p50: z.number().positive(), p95: z.number().positive() })
    .strict()
    .refine((d) => d.p95 >= d.p50, { message: 'p95 must be >= p50' }),
  z
    .object({ dist: z.literal('uniform'), min: z.number().nonnegative(), max: z.number().nonnegative() })
    .strict()
    .refine((d) => d.max >= d.min, { message: 'max must be >= min' }),
]);
export type Dist = z.infer<typeof DistSchema>;

export const ErrorKindSchema = z.enum(['rejected', 'rate_limited', 'error', 'timeout', 'dependency']);
export type ErrorKind = z.infer<typeof ErrorKindSchema>;
export const ERROR_KINDS = ErrorKindSchema.options;

export const RetryPolicySchema = z
  .object({
    max: z.number().int().nonnegative(),
    backoff: z.enum(['none', 'constant', 'exponential']).default('none'),
    base_ms: z.number().nonnegative().default(100),
    max_ms: z.number().nonnegative().default(30_000),
    jitter: z.boolean().default(false),
    on: z.array(ErrorKindSchema).optional(),
  })
  .strict();
export type RetryPolicy = z.infer<typeof RetryPolicySchema>;

export const CallPolicySchema = z
  .object({
    timeout_ms: z.number().positive().optional(),
    retry: RetryPolicySchema.optional(),
  })
  .strict();
export type CallPolicy = z.infer<typeof CallPolicySchema>;

export const CallSchema = z
  .object({
    from: z.string(),
    to: z.string(),
    /** `request`: once per job. `step`: once per agent-loop step (loop components only). */
    per: z.enum(['request', 'step']).default('request'),
    /** What the caller does when this call finally fails. `replan` lets an agent loop try another step. */
    on_error: z.enum(['fail', 'replan', 'ignore']).default('fail'),
    weight: z.number().positive().default(1),
    policy: CallPolicySchema.optional(),
  })
  .strict();
export type Call = z.infer<typeof CallSchema>;

export const TrafficClassSchema = z
  .object({
    id: z.string(),
    entry: z.string(),
    arrival: z.object({ kind: z.literal('poisson'), rate_rps: z.number().positive() }).strict(),
    attrs: z
      .object({
        input_tokens: DistSchema.optional(),
        output_tokens: DistSchema.optional(),
      })
      .strict()
      .default({}),
    /** Timeout and retry behaviour of the calling client itself. */
    client: CallPolicySchema.optional(),
  })
  .strict();
export type TrafficClass = z.infer<typeof TrafficClassSchema>;

export const ComponentSchema = z
  .object({
    id: z.string().regex(/^[a-zA-Z0-9_-]+$/, 'ids may contain letters, digits, _ and -'),
    type: z.string(),
    params: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();
export type Component = z.infer<typeof ComponentSchema>;

export const DesignSchema = z
  .object({
    apiVersion: z.literal('sim/v1'),
    design: z
      .object({
        id: z.string(),
        version: z.number().int().optional(),
        description: z.string().optional(),
      })
      .strict(),
    traffic: z.object({ classes: z.array(TrafficClassSchema).min(1) }).strict(),
    components: z.array(ComponentSchema).min(1),
    calls: z.array(CallSchema).default([]),
  })
  .strict();
export type Design = z.infer<typeof DesignSchema>;

// ---------------------------------------------------------------- component types

export const PrimitiveSchema = z.enum(['station', 'router', 'llm', 'loop']);
export type Primitive = z.infer<typeof PrimitiveSchema>;

export const FidelitySchema = z.enum(['formula', 'queueing', 'event']);
export type Fidelity = z.infer<typeof FidelitySchema>;

export const ComponentTypeSchema = z
  .object({
    kind: z.literal('ComponentType'),
    id: z.string(),
    version: z.string(),
    primitive: PrimitiveSchema,
    fidelity: FidelitySchema,
    description: z.string(),
    defaults: z.record(z.string(), z.unknown()),
  })
  .strict();
export type ComponentType = z.infer<typeof ComponentTypeSchema>;

const nullablePositive = z.number().positive().nullable();
const rate = z.number().min(0).max(1);

export const StationParamsSchema = z
  .object({
    concurrency: nullablePositive,
    service_time_ms: DistSchema,
    queue_limit: z.number().int().nonnegative().nullable(),
    error_rate: rate,
  })
  .strict();
export type StationParams = z.infer<typeof StationParamsSchema>;

export const RouterParamsSchema = z
  .object({
    strategy: z.enum(['round_robin', 'random']),
  })
  .strict();
export type RouterParams = z.infer<typeof RouterParamsSchema>;

export const LlmParamsSchema = z
  .object({
    rpm: nullablePositive,
    itpm: nullablePositive,
    otpm: nullablePositive,
    /** Providers usually count rejected (429) requests against the request limit. */
    count_rejected_toward_rpm: z.boolean(),
    max_concurrency: nullablePositive,
    ttft_ms: DistSchema,
    output_tps: z.number().positive(),
    error_rate: rate,
    price_input_per_mtok: z.number().nonnegative(),
    price_output_per_mtok: z.number().nonnegative(),
  })
  .strict();
export type LlmParams = z.infer<typeof LlmParamsSchema>;

export const LoopParamsSchema = z
  .object({
    concurrency: nullablePositive,
    queue_limit: z.number().int().nonnegative().nullable(),
    step_overhead_ms: DistSchema,
    /** Mean number of successful steps before the agent decides it is done (geometric). */
    steps_mean: z.number().min(1),
    loop_cap: z.number().int().positive().nullable(),
    budget_cap_usd: z.number().positive().nullable(),
    context_growth_tokens_per_step: z.number().nonnegative(),
    step_output_tokens: DistSchema,
    error_rate: rate,
  })
  .strict();
export type LoopParams = z.infer<typeof LoopParamsSchema>;

export const PARAM_SCHEMAS = {
  station: StationParamsSchema,
  router: RouterParamsSchema,
  llm: LlmParamsSchema,
  loop: LoopParamsSchema,
} as const;

// ---------------------------------------------------------------- scenarios

export const LoadShapeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('constant'), mult: z.number().positive() }).strict(),
  z
    .object({
      kind: z.literal('ramp'),
      from: z.number().positive(),
      to: z.number().positive(),
      start_s: z.number().nonnegative(),
      end_s: z.number().positive(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('spike'),
      base: z.number().positive(),
      peak: z.number().positive(),
      start_s: z.number().nonnegative(),
      end_s: z.number().positive(),
    })
    .strict(),
]);
export type LoadShape = z.infer<typeof LoadShapeSchema>;

export const FaultSchema = z.discriminatedUnion('kind', [
  z
    .object({ kind: z.literal('error_rate'), target: z.string(), value: rate, from_s: z.number(), to_s: z.number() })
    .strict(),
  z
    .object({ kind: z.literal('slowdown'), target: z.string(), factor: z.number().positive(), from_s: z.number(), to_s: z.number() })
    .strict(),
  z
    .object({ kind: z.literal('limit_scale'), target: z.string(), factor: z.number().positive(), from_s: z.number(), to_s: z.number() })
    .strict(),
]);
export type Fault = z.infer<typeof FaultSchema>;

export const ScenarioSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    duration_s: z.number().positive(),
    warmup_s: z.number().nonnegative().default(10),
    load: LoadShapeSchema,
    faults: z.array(FaultSchema).default([]),
  })
  .strict();
export type Scenario = z.infer<typeof ScenarioSchema>;
