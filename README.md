# System Simulation

A design-time simulation platform for web and GenAI application architectures. It simulates a proposed design before it is built, finds failure modes on its own (retry storms, rate-limit cascades, runaway agent loops, single points of failure), projects cost, and proves recommended fixes by re-simulating them.

Status: Phase 0 prototype (command line). Open source under the [MIT licence](LICENSE).

## Quick start

Requires Node.js 24 or later and [pnpm](https://pnpm.io) 10.

```bash
pnpm install
pnpm bench
```

`pnpm bench` runs the Phase 0 gate: the analyzer must find the known failure modes in the benchmark designs without being told where to look.

Analyze a design with the standard scenario battery:

```bash
pnpm sim analyze benchmarks/retry-storm.yaml
```

Other commands:

```bash
pnpm sim run benchmarks/rate-limit-cascade.yaml --scenario ramp
pnpm sim scenarios benchmarks/runaway-agent.yaml
pnpm sim types
```

Add `--json out/report.json` to `analyze`, `run` or `bench` to save the full results.

Run the tests and the type check:

```bash
pnpm test
pnpm typecheck
```

## Layout

| Path | Contents |
| --- | --- |
| `packages/model` | Design file schema and validation |
| `packs/` | Component types as data (web and GenAI) |
| `packages/engine` | Deterministic discrete-event simulation engine |
| `packages/scenarios` | Standard scenario battery |
| `packages/detectors` | Failure detectors and the analyzer |
| `apps/cli` | `sim` command-line tool |
| `benchmarks/` | Designs with known failure modes, and the gate manifest |

## Documents

- [Solution overview](docs/solution-overview.md): tech stack, the solution at a high level, and first-release features
- [Phase 0 results](docs/phase-0.md)
- [Business requirements (BRD)](docs/brd.md)
- [System design](docs/system-design.md)
