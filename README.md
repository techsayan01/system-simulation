# System Simulation

A visual simulator for web and GenAI application architectures. Draw a design on a canvas the way you would in draw.io, then press Play and watch it run: requests flow along the connections, components fill up and turn amber or red, and you can raise the traffic, take a component down or slow it while it runs. A "Find problems" button stress-tests the design automatically and lists what breaks (retry storms, rate-limit cascades, runaway agent loops), each with a button to watch it happen on the canvas.

Status: prototype. Open source under the [MIT licence](LICENSE).

## Quick start

Requires Node.js 24 or later and [pnpm](https://pnpm.io) 10.

```bash
pnpm install
pnpm dev
```

Then open http://localhost:5173. The canvas opens with an example; pick others from **Examples**, or start from **Blank canvas**.

On the canvas:

- Drag components from the left panel (or click them) and connect them by dragging from a component's right edge to another's left edge. A design needs at least one **Client**, which sends the traffic.
- Select a component or connection to change its settings on the right: workers, processing time, LLM limits and prices, agent step caps, timeouts, retries and backoff.
- Press **Play**. Use **Traffic** to multiply the load, **1× / 5× / 20×** to change speed, and **Take down** or **Slow down 5×** on a selected component to break it on purpose.
- Press **Find problems** to run the standard stress tests in the background.

The same engine runs from the command line, which is useful for CI:

```bash
pnpm sim analyze benchmarks/retry-storm.yaml
pnpm bench
```

`pnpm bench` checks that the analyzer finds the known failure modes in the benchmark designs without being told where to look. **Export** on the canvas downloads the design as YAML for these commands.

Other commands:

```bash
pnpm sim run benchmarks/rate-limit-cascade.yaml --scenario ramp
pnpm sim scenarios benchmarks/runaway-agent.yaml
pnpm sim types
pnpm test
pnpm typecheck
```

## Layout

| Path | Contents |
| --- | --- |
| `apps/web` | The visual simulator (React, React Flow, Vite) |
| `apps/cli` | `sim` command-line tool |
| `packages/engine` | Deterministic discrete-event simulation engine, with a live mode for the canvas |
| `packages/model` | Design file schema and validation |
| `packs/` | Component types as data (web and GenAI) |
| `packages/scenarios` | Standard stress-test scenarios |
| `packages/detectors` | Failure detectors and the analyzer |
| `benchmarks/` | Designs with known failure modes, also used as the canvas examples |

## Documents

- [Solution overview](docs/solution-overview.md): tech stack, the solution at a high level, and first-release features
- [Phase 0 results](docs/phase-0.md)
- [Business requirements (BRD)](docs/brd.md)
- [System design](docs/system-design.md)
