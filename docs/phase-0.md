# Phase 0: Proof Prototype

Status: built and gate passed · 2026-11-25 · see [system-design.md §16](system-design.md#16-delivery-plan)

Phase 0 tests the core idea of the BRD: can a simulator find hidden failure modes on its own, without anyone choosing what to probe? It is a command-line prototype with no UI.

## Gate result

The gate (BRD next step 2) asks the analyzer to find a retry storm, a provider rate-limit cascade and a runaway agent loop on designs with known flaws, using only the standard scenario battery, with deterministic results.

| Benchmark | Expected | Detected | At normal load | Deterministic |
| --- | --- | --- | --- | --- |
| `retry-storm` | retry amplification, metastable failure | both | clean | yes |
| `rate-limit-cascade` | rate-limit cascade, first limit reached | both | clean | yes |
| `runaway-agent` | runaway agent loop | yes | clean | yes |
| `healthy` (control) | nothing of medium severity or above | nothing | clean | yes |

**5 of 5 expected failure modes detected; the control design produced no findings.** The whole suite (4 designs, 22 scenarios, 3 seeds each) runs in about 5 seconds.

"Clean at normal load" matters: it is the case Breakscale's own check missed. Each flawed design looks healthy at 1× traffic, and the problem only appears under the battery's stress scenarios.

Run it yourself:

```bash
pnpm install
pnpm bench
```

## What the findings look like

From `retry-storm` (abridged):

> **HIGH F-001 System does not recover after a load spike.** A 3x spike lasting 60 s left the system failing after load returned to normal: goodput was 99.8% before the spike and 0% from 180 s to 300 s. The bottleneck is db, which stays fully busy … api backs up behind it because its workers wait on db. Reproduced 3/3 seeds.
>
> **HIGH F-002 Retries at 2 layers multiply load on db.** client(checkout)->lb (2 retries, no backoff) and api->db (2 retries, no backoff). One request can reach db up to 9 times; measured 3.2x the normal calls per request.

From `rate-limit-cascade`:

> **MEDIUM First limit on llm: input tokens per minute** is the first limit to run out, at about 1.38x current traffic. Headroom per limit: requests per minute 1.66x; input tokens per minute 1.38x; output tokens per minute 2.67x.

From `runaway-agent`:

> **HIGH Runaway agent loop in agent.** During "search fails every call from 60 s to 180 s", 54% of running agent invocations went past 25 steps (normal mean 3, max seen 70). Nothing stops the loop: there is no step cap and no budget cap. Cost per successful request was about 20x the normal-load figure.

Every finding carries the scenario, the time and load it started at, the component, its metrics, how many seeds reproduced it, and the run ID that regenerates the evidence.

Two rules keep findings pointed at causes rather than symptoms:

- **Bottleneck tracing.** A saturated component whose own callee is also saturated is only waiting, so the analyzer follows the calls down and names the saturated component with no saturated callee. The ones waiting on it are listed as backed up.
- **Stacked retries.** Retries at several layers on the way to the same component multiply each other, so they are reported once, against the component that receives the multiplied load, with the theoretical worst case and the measured increase.

## Visual simulator

`pnpm dev` opens the visual simulator at http://localhost:5173 (`apps/web`). You draw the design on a canvas, press Play, and the same engine runs live in the browser:

- Requests show as moving dots on each connection, more dots for more calls per second and red dots for calls that fail or time out. Retries (↻) and timeouts (⏱) per second appear on the connection label.
- Each component shows how busy it is, its queue, calls per second, failure rate and p99, and a status word with colour: Healthy, Busy, Overloaded, Failing, Rate limited, Looping, Runaway, Down.
- While it runs you can change the traffic multiplier (0.1× to 10×), the speed (1×, 5×, 20×), and take any component down or slow it 5×.
- Changing the design restarts the simulation from 0 s, keeping the traffic level and the faults.
- **Find problems** runs the standard stress-test battery in a background worker and lists the findings. **Show on canvas** points at the component, and **Watch it happen** recreates the condition live.
- **Export** downloads the design as YAML for the `sim` command line.

The engine gained a live mode for this (`LiveSim` in `packages/engine/src/live.ts`): it advances in small steps on each animation frame and accepts traffic and fault changes mid-run.

## What was built

| Package | Contents |
| --- | --- |
| `packages/model` | Design file schema (Zod), component type registry, validation (references, unknown params, call cycles) |
| `packs/` | 6 component types as data: `web/service`, `web/database`, `web/load-balancer`, `genai/llm-provider`, `genai/agent-loop`, `genai/tool` |
| `packages/engine` | Deterministic discrete-event engine: station, router, LLM provider (three token buckets, token-based latency, per-token cost) and agent loop primitives; edge timeouts and retries with backoff and jitter; per-window metrics; run IDs |
| `packages/scenarios` | Standard battery: baseline, ramp 0.5x→5x, spike 3x, LLM limits halved, outage of each leaf dependency |
| `packages/detectors` | Five detectors and the analyzer that confirms findings across seeds and merges them across scenarios |
| `apps/web` | Visual simulator: drag-and-drop canvas, live simulation, Find problems |
| `apps/cli` | `sim analyze`, `sim run`, `sim scenarios`, `sim bench`, `sim types` |
| `benchmarks/` | Four benchmark designs and the gate manifest |

Engine tests check results against queueing theory (M/M/1 and Erlang C M/M/c mean response time), token-bucket admission, LLM billing, agent step counts, byte-identical determinism and design validation.

## Modelling choices worth knowing

- A caller that times out abandons the call, but the callee keeps working on it. Wasted work under overload is what makes retry storms persist.
- A service holds its worker slot during its own processing and during every synchronous downstream call, so a slow dependency exhausts its callers.
- LLM limits are token buckets that refill continuously and hold up to one minute of capacity. Rejected requests count against the request limit (configurable). Output tokens are reserved on admission.
- The provider bills a completed generation even if the caller has already timed out.
- An agent step is overhead, then its per-step calls in order. A failed call marked `on_error: replan` costs a step and the loop continues; after a clean step the agent stops with probability 1/`steps_mean`. Context grows by a fixed number of tokens per step.
- A finding is kept only if it reproduces in a majority of seeds (default 3).

## Limits of this prototype

- Default parameters, including LLM limits and prices, are placeholders, not any provider's real numbers.
- Detector thresholds were tuned on these four benchmarks only. A larger benchmark suite is needed before the BRD's 90% detection and under-10% false-finding targets mean anything.
- The battery has no dependency slowdown, hot key or network-cut scenarios yet, and the ramp stops at 5x rather than 10x.
- No rule checks, fix recommender, cost projection, report or UI yet. These are Phase 1.
- The load balancer adds no latency or queueing, and caches, autoscalers and queues are not modelled yet.

## Next

Phase 1 adds the canvas editor, the full web and GenAI packs, the complete scenario battery, rule checks, the fix recommender with paired re-simulation, cost projection and the HTML/PDF report. Before that, two Phase 0 follow-ups would strengthen the evidence:

1. Grow the benchmark suite with more flawed and healthy designs, to measure detection and false-finding rates properly.
2. Profile the engine on larger designs to set the interactive speed target (BRD open question).
