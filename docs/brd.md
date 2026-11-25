# BRD: Design-Time System Simulation Platform for Web and GenAI Applications

Nov 24, 2026 · @Sayan

## 1. Executive summary

The business needs a platform that simulates a proposed software architecture before it is built, then reports where it will fail, what it will cost and which fix works best. The first customers are engineering and technology consultancies that review client designs. The platform covers two domains: classic web systems, and application-level GenAI systems (LLM provider calls, RAG pipelines, agents and gateways).

The expected outcome is fewer design flaws reaching build, faster and more consistent architecture reviews, and client-ready reports backed by simulation evidence instead of opinion.

Status: draft v0.1 for review. Working product name: not yet chosen.

## 2. Problem and opportunity

Architecture diagrams never fail, so designs reach build with failure modes nobody has seen. In a hands-on test of the open-source simulator Breakscale on 2026-11-24, its "Find the problem" check reported "Running fine" at normal load on a design with a latent retry storm. The design only collapsed when the load was raised.

GenAI applications add failure modes that classic reviews miss:

- Provider limits are enforced per minute on requests, input tokens and output tokens separately, so a design can hit one limit while looking safe on the others.
- Retries multiply token spend, not just load.
- Agent loops without step or budget caps can run up unbounded cost while ordinary dashboards stay green.

Consultancies handle this today with manual audits that are slow, vary by reviewer and leave little evidence to show a client. The opportunity is an automated, repeatable review that finds hidden failure modes on its own and shows the evidence.

## 3. Market landscape and gap

No tool found covers an application-level, design-time simulation of web and GenAI systems with automatic failure detection. Related tools fall into calculators, learning simulators, runtime guards and manual audits. As of 2026-11-24; only Breakscale was tested hands-on, and the rest are taken from web search results and need verification.

| Tool | Type | What it does | Gap against this product |
| --- | --- | --- | --- |
| [Breakscale](https://breakscale.tech) | Learning simulator (open source) | Discrete-event simulation of 33 component types, fault injection, load slider | Diagnoses only current load; manual canvas; no import or client report |
| [Argon](https://builder.aws.com/content/3Jazoj7AsnFBA57fl4aUn2kuGfu/argon-break-your-aws-architecture-before-production-does) | AWS architecture simulator | Per-node latency, throughput, drops and cost from queueing models | AWS-specific; hackathon project; demo not reachable for testing |
| [Archimyst](https://www.producthunt.com/posts/archimyst) | AI architecture designer | Generates architectures and simulates spikes, outages, scaling and cost | Early product; analysis depth unverified |
| [Cascode](https://peerlist.io/mxnyawi/project/cascode) | Diagram and simulation tool | Simulates flows, exports Terraform, gives AI-graded reviews | Anti-pattern review is rule or AI based, not evidence-led |
| [beforeyouship.dev](https://mcpservers.org/servers/beforeyouship-dev-docs) | LLM cost model | Monthly cost with retry, caching and growth multipliers | Fixed multipliers; no queues, cascades or architecture graph |
| [SolvoHQ capacity planner](https://dev.to/solvohq/the-llm-rate-limit-that-429s-you-first-is-rarely-the-one-you-sized-for-so-i-gave-my-agent-a-tool-344b) | LLM rate-limit calculator | Finds which provider limit (requests, input or output tokens) is hit first | Arithmetic only; single dependency view |
| [Varpulis Agent Runtime](https://dev.to/cyril_poder_5a868f214b8f5/how-to-prevent-your-ai-agent-from-burning-50-in-a-loop-45g4) | Runtime guard (open source) | Detects retry storms and runaway loops in live agents | Acts after the system is built |
| [Manual RAG audit](https://www.upwork.com/services/product/development-it-a-production-rag-readiness-audit-and-prioritized-remediation-roadmap-2067681347991649051) | Consulting service | Reviews architecture, latency and cost risk, delivers a roadmap | Slow, reviewer-dependent, no simulation evidence |

## 4. Objectives and success metrics

The product succeeds if it finds real design flaws before build and saves reviewers time. All targets below are proposals to confirm with stakeholders.

| Objective | Metric | Proposed target |
| --- | --- | --- |
| Find hidden failure modes automatically | Share of seeded failure modes in the benchmark suite that the analyzer detects without manual probing | 90% or more |
| Keep findings trustworthy | Findings that a reviewer rejects as false or unsupported | Under 10% |
| Speed up reviews | Time from design input to first findings report | Under 30 minutes |
| Make GenAI cost and limits visible | Designs with a projected monthly cost and the first limit to be hit | 100% of GenAI designs |
| Prove the fix | Recommended fixes re-simulated with before and after metrics | 100% of recommendations |
| Support growth of the technique catalog | Plugins that pass their benchmark test before release | 100% |

## 5. Stakeholders and users

Solution architects at consultancies are the primary users; the client's technical leadership reads the output.

| Role | Interest | What they need |
| --- | --- | --- |
| Solution architect (primary user) | Review and improve client designs quickly | Build or import a design, run scenarios, get ranked findings with evidence |
| Consultancy partner or practice lead | Quality, consistency and margin across engagements | Repeatable review method, branded client reports |
| Client CTO or engineering lead | Confidence in the design and its cost | Plain-language report, cost projection, tested fixes |
| Platform and AI engineers at the client | Know what will break and why | Component-level detail, assumptions they can correct with real numbers |
| Product team (builders) | Ship and maintain the platform | Clear plugin format, stable engine, benchmark tests |

## 6. Scope

The product simulates how an application architecture behaves under load and failure. It does not judge whether an AI model's answers are good.

**In scope**

- A generic simulation core with components defined by data: capacity, latency, cost and failure behavior.
- A web pack: load balancer, CDN, cache, database, replicas, queues, rate limiters, autoscalers and similar.
- A GenAI application pack: LLM provider API (request and token limits, token-based latency, price), prompt and context builder, RAG stages, agent loops, gateway routing, fallback and caching.
- Scenario sweeps: load ramps, traffic spikes, dependency slowdowns, node loss and retry amplification.
- An analyzer that detects failure modes and recommends fixes that are re-simulated.
- A plugin format for optimization techniques such as Bloom filters, gossip protocols and consistent hashing.
- Client-ready reports with cost projections.
- Import of existing infrastructure definitions, starting with Terraform.

**Out of scope**

- GPU and inference-serving simulation. Research simulators exist for that and can be wrapped later if needed.
- Evaluating answer quality or hallucination. The product offers hooks to plug in an evaluation suite.
- Live production monitoring and runtime guardrails.
- Deploying infrastructure or running load tests against real systems.
- Security testing.

## 7. Business requirements

Ten business requirements drive the functional scope. "Must" items are needed for the first release.

| ID | Business requirement | Priority |
| --- | --- | --- |
| BR-01 | Consultants can evaluate a proposed architecture before any code or infrastructure exists | Must |
| BR-02 | The product finds failure modes on its own, including ones that only appear under stress, and does not rely on the user probing for them | Must |
| BR-03 | Every finding is backed by simulation evidence and is reproducible | Must |
| BR-04 | Recommended fixes are tested in the simulator and shown with before and after results | Must |
| BR-05 | The product supports web architectures and application-level GenAI architectures in one model | Must |
| BR-06 | GenAI designs show projected cost, the first provider limit reached, and retry and agent-loop risk | Must |
| BR-07 | Results are packaged as a client-ready report with assumptions and cost projections | Must |
| BR-08 | New optimization techniques can be added without changing the engine | Should |
| BR-09 | Users can replace default parameters with real client data, such as traffic logs, limits and prices | Should |
| BR-10 | Client designs can stay inside the consultancy's own environment | Should |

## 8. Functional requirements

Eighteen functional requirements, grouped by capability, each traced to a business requirement.

| ID | Requirement | Traces to |
| --- | --- | --- |
| FR-01 | Users build a design on a canvas from a component library and set traffic assumptions | BR-01 |
| FR-02 | Each component is defined by data: concurrency, service-time distribution, queue limit, error rate, cost per call and downstream calls | BR-05, BR-08 |
| FR-03 | A discrete-event engine simulates the design and reports latency percentiles, throughput, goodput, queue depth, drops and cost per component | BR-01, BR-03 |
| FR-04 | A scenario runner sweeps load ramps, spikes, hot keys, dependency slowdowns, node loss and network cuts | BR-02 |
| FR-05 | The analyzer detects saturation, retry amplification, single points of failure, cascading failure and unbounded queues | BR-02 |
| FR-06 | Each finding shows the scenario, the trigger point, the failing component and a timeline as evidence | BR-03 |
| FR-07 | The analyzer proposes fixes, applies each to a copy of the design and re-runs the same scenarios | BR-04 |
| FR-08 | LLM provider component models separate limits for requests, input tokens and output tokens, token-based latency, 429 and timeout behavior, and price per token | BR-06 |
| FR-09 | RAG components model embedding, vector search, reranking and context assembly, each with its own latency, limit and cost | BR-06 |
| FR-10 | Agent components model steps, tool calls, retry policy, loop caps and budget caps | BR-06 |
| FR-11 | The analyzer detects rate-limit cascades, retry cost storms, runaway agent loops, context growth and single-provider dependency | BR-02, BR-06 |
| FR-12 | The product projects monthly cost at current and multiplied traffic and names the first limit reached | BR-06 |
| FR-13 | Technique plugins declare a behavior model, an applicability rule, a validation check and known trade-offs | BR-08 |
| FR-14 | A technique is recommended only if re-simulation shows improvement with no new regression, and its trade-offs are listed | BR-04, BR-08 |
| FR-15 | Each plugin ships with a benchmark design where its effect is known, and fails release if the simulator does not reproduce it | BR-08 |
| FR-16 | Users override default parameters with client logs, limits and prices, and results show sensitivity ranges | BR-09 |
| FR-17 | The product exports a report with findings, evidence, assumptions, cost and prioritized fixes | BR-07 |
| FR-18 | The product imports Terraform definitions and maps resources to component types | BR-01, BR-09 |

## 9. Non-functional requirements

Trust in the results matters more than speed, so reproducibility and honesty about fidelity come first.

| Category | Requirement |
| --- | --- |
| Reproducibility | The same design, parameters and random seed always produce the same results |
| Honesty about fidelity | Each component and plugin is labeled as formula, queueing model or full event simulation, and results show ranges where parameters are guesses |
| Evidence over narration | An LLM may explain findings and suggest fixes, but may only report problems the simulator or a rule check actually triggered |
| Privacy | A self-hosted or private deployment option so client architectures never leave the consultancy's environment |
| Interactive speed | Typical runs finish fast enough for interactive use; target to be set after the first prototype |
| Extensibility | A new component or technique is added as a data file and a benchmark test, with no engine release |
| Auditability | Plugins record their source, assumptions and valid parameter ranges; reports cite them |
| Accessibility | Findings and charts are readable without relying on color alone |

## 10. Solution overview

&#91;embedded content: solution architecture · core, 2 packs, plugins, analyzer, report\]

The core knows only components with capacity, latency, cost and faults. Domain packs and technique plugins are data files added on top, and the analyzer turns simulation results into findings and tested fixes.

## 11. Assumptions, dependencies and risks

The largest risk is that simulated numbers are trusted more than their inputs deserve.

**Assumptions and dependencies**

- Consultancies will supply real traffic figures, provider limits and prices for at least some engagements.
- The market research behind this BRD came from web search on 2026-11-24 and needs verification before positioning decisions.
- Reusing Breakscale's open-source engine is an option; its license and fit have not been checked.

**Risks**

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Default parameters are wrong | Misleading findings | Calibration with client data, sensitivity ranges, fidelity labels |
| LLM-written narration invents problems | Loss of trust | Report only findings triggered by the simulator or a rule; evidence attached to each |
| Some techniques, such as gossip protocols, need higher-fidelity models | Plugin results too coarse | Fidelity level per plugin; event-level model where needed |
| Scope creep into inference or answer quality | Delay, diluted product | Keep both explicitly out of scope; offer hooks only |
| Indie competitors extend into the same space | Shrinking gap | Focus on automatic detection, reports and consultancy workflow |
| Plugin catalog is never complete | Missed techniques | Start with the 20 to 30 most common; allow private plugins |

## 12. Feasibility assessment

The product is technically feasible as a staged build. Demand and calibration accuracy are the two things not yet proven. Assessed on 2026-11-24 from the research in this BRD; no customer interviews or prototype work have been done.

| Area | Verdict | Basis and caveats |
| --- | --- | --- |
| Simulation core and web pack | High | A discrete-event simulator with 33 component types already runs in a browser ([Breakscale](https://breakscale.tech), tested hands-on), so the approach is proven. Reuse depends on an unchecked license. |
| GenAI application pack | Medium to high | Provider limits and token pricing are plain arithmetic, and retry cost is modelable. Agent step counts and failure rates are assumptions that need calibration. |
| Automatic failure detection | Medium | Breakscale's own check only looks at the current load, so scenario sweeps and detectors (retry amplification, cascades, runaway loops) must be built. The failure patterns are well defined. |
| Technique plugin framework | Medium | Simple techniques such as Bloom filters fit a formula or queueing model. Gossip protocols may need an event-level model, so fidelity varies per plugin. |
| Terraform import | Medium | Mapping resources to component types is straightforward, but default parameters for each type must be chosen and defended. |
| Result accuracy | Medium to low | Parameters are guesses until calibrated with client data. Mitigated by ranges, fidelity labels and calibration, not eliminated. |
| Market | Medium, unvalidated | A gap was found in a limited web search, but adjacent indie tools could extend into it and no consultancy has been asked whether they would use or pay for it. |
| Team and cost | Not estimated | Needs a simulation or distributed-systems engineer, a canvas front-end engineer and a GenAI application engineer, plus a domain advisor. Cost and timeline depend on the open build-versus-reuse decision. |
| Legal and data | Open | Breakscale's license and the confidentiality terms for using client data to calibrate are not yet checked. |

**Recommended next steps**

1. Check Breakscale's license and decide whether to build on its engine.
2. Build a small prototype that reproduces three known failures: a retry storm, a provider rate-limit cascade and a runaway agent loop. If the analyzer finds them without manual probing, the core idea holds.
3. Interview 5 to 10 consultants and architects about how they review designs today and what they would pay for.
4. Verify the competitor claims in section 3, especially Argon, Archimyst and Cascode.

## 13. Phased roadmap

&#91;embedded content: roadmap · 4 phases, 4 exit gates\]

The phases are ordered, not scaled to time. Gate criteria are proposals to confirm with stakeholders, and no dates are set yet.

## 14. Open questions

- [ ] Is this an internal tool for one consultancy first, or a product sold to many?
- [ ] Build on Breakscale's open-source engine, or write a new core? License check needed.
- [ ] Which GenAI providers and models must the first provider component cover?
- [ ] What real client data can be used to calibrate defaults, and under what confidentiality terms?
- [ ] Which 20 to 30 optimization techniques go into the first plugin catalog?
- [ ] Is a self-hosted deployment required at launch, or can the first version be cloud-hosted?
- [ ] What interactive speed target should simulations meet?
- [ ] Verify the competitor findings in section 3, especially Argon, Archimyst and Cascode, which were not tested hands-on.
