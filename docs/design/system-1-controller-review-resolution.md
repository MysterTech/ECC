# System 1 design review resolution

Date: 2026-10-11. Proposed contract v3 of the
[design](system-1-controller.md), [protocol](system-1-controller-protocol.md) and
[provider handoff](system-1-provider-handoff.md).

The v2 revision gave all 27 original findings an explicit contract decision, scope
restriction or deferred acceptance condition. V3 retains those boundaries and adds
the user's requested Codex/Claude subscription continuation. Design decisions are
not evidence of implemented behavior, native quota handling or economic savings.

The [original adversarial report](system-1-controller-review.md) and
[appendix](system-1-controller-review-appendix.md) remain unchanged historical evidence,
including original draft digests and observations. Their line references identify
the reviewed draft, not these revisions.

## Decisions by finding

Implementation acceptance remains pending for every row. Links identify the
current authoritative contract; cases come from the protocol and original
appendix rather than unobserved planned test code.

| Finding | Contract decision and location |
| --- | --- |
| F01 — Operational routing | [Requirements/routing](system-1-controller.md#requirements-and-initial-routing) defines all complexity/ambiguity combinations, defaults, precedence, bands, risk/phase minima and verification influence. Fixtures must demonstrate distinct easy/demanding routes without classification. V3 classifies tiers and separately selects an available compatible provider. |
| F02 — Configuration invariants | [Configuration](system-1-controller.md#allocation-configuration) defines one ordered tier ladder, complete floors, compatible suffix and last-tier fallback. Explicit below-floor/incompatible choices reject; unavailable alternatives cannot weaken the tier. |
| F03 — Task identity | [Canonical ownership](system-1-controller-protocol.md#canonical-ownership-and-revision-closure) pins task/query/requirements, revision/phase, working repo/cwd, ECC source, all runtime/context bindings and policy snapshot. Next matches originalTask; resume consumes the bound private original capsule. |
| F04 — Initial versus retry | [Successor reservations](system-1-controller-protocol.md#idempotency-progress-and-successor-reservations) separates initial run, next-tier capability next and same-tier provider resume. Successors are persisted and claimed once; no reclassification or transparent same-allocation retry. |
| F05 — Lifecycle/concurrency | [Lifecycle](system-1-controller-protocol.md#task-lifecycle-and-switching-guards) defines guarded frontiers, terminal/provisional evidence, replay, conflicts and one successor of either kind. Cross-revision closure cannot bypass cessation acknowledgement. |
| F06 — Crash windows | [Root lifecycle](system-1-controller-protocol.md#root-operation-lifecycle-and-recovery) persists intent/launch observations; missing completion blocks work pending reconciliation. Exactly-once subprocess/remote effects remain unclaimed. Capsule/transition publication must preserve the same crash boundary. |
| F07 — Classifier authority | [Runtime authority](system-1-controller.md#runtime-identity-and-authority) defaults classifier off. Inherited-authority mode needs acknowledgement; prompt/read-only/ephemeral do not remove hooks, MCP, delegation, reads or remote effects. Strong minimal classification remains deferred. |
| F08 — Descendant termination | [Recovery](system-1-controller.md#checkpoints-and-recovery) treats root exit as root-only. Manual continuation needs effect acknowledgement; automatic continuation adds event quiescence and an explicit trusted synchronous-local-work assertion. Neither claims universal descendant/remote cessation. |
| F09 — Public API and DB | [Operation boundary](system-1-controller-protocol.md#public-operation-boundary) defines asynchronous run/progress/checkpoint/next/switch/resume/status/recover with bounded input and explicit DB. Dry-run opens no DB/capsule and calls no providers/auth commands; outer dispatcher forwards stdin. |
| F10 — Effective runtime identity | [Runtime authority](system-1-controller.md#runtime-identity-and-authority) pins every allowed provider and distinguishes requested from nullable observed model/effort/backend. Subscription route evidence is separately guarded; native context readiness cannot establish billing or entitlement. |
| F11 — Root/child and proposal | [Scope](system-1-controller.md#purpose-and-scope) remains root-only. Per-provider context proposal has its own allocation/accounting. Children remain independently configured and their costs may be unobserved. |
| F12 — Transport and limits | [Provider transport](system-1-controller.md#classifier-and-provider-transport) defines exact tier classifier JSON, transport-specific framing and per-phase completion rules. Quota signals have typed mapping/certification gates; input fits both operation cap and allocation capacity. |
| F13 — Shared preflight | [Preflight](system-1-controller.md#limits-and-shared-preflight) rechecks source/native/executable/config/auth before every call and after completion. Destination context/body/capacity binding applies to every selection path. Integrity/input/persistence errors cannot become response fallback. |
| F14 — Typed process results | [Root lifecycle](system-1-controller-protocol.md#root-operation-lifecycle-and-recovery) preserves actual nullable exit/signal, category and origin. Timeout/overflow/cancellation differ from normal failure; app-server terminal turn and server cleanup are separate observations. |
| F15 — Verification evidence | [Evidence](system-1-controller-protocol.md#verification-effects-and-successor-input) requires expected check IDs/methods/results and artifact/workspace correspondence. Asserted-success remains distinct from independent grading; journal progress is not verification. |
| F16 — External blockers | [Lifecycle](system-1-controller-protocol.md#task-lifecycle-and-switching-guards) escalates only capability causes. Environment/requirements/unknown blockers suspend. Quota is availability, not reasoning insufficiency or model-quality evidence. |
| F17 — Handoff/effects | [Portable continuation](system-1-controller.md#portable-progress-and-provider-continuation) binds task, parent, capsule, workspace and transition while retaining explicit effect safety. Destination starts fresh and inspects retained work. No hidden reasoning/native transcript transfer, evidence fetching or rollback. |
| F18 — Risk authority | [Requirements](system-1-controller-protocol.md#policy-and-requirement-domains) treats every unapproved assessment as high; lowering needs non-null trusted-caller approval. Provenance labels are not authentication. Changed risk needs a safely closed prior revision. |
| F19 — Compatibility | [Configuration](system-1-controller.md#allocation-configuration) checks exact runtime/model/effort support, capabilities and byte feasibility per alternative across a contiguous tier suffix. Common labels/tier membership do not prove cross-provider equivalence. |
| F20 — Store model | [Dedicated SQLite operations](system-1-controller-protocol.md#dedicated-sqlite-operations) defines additive entities, ownership, immutable history, capsule privacy and guarded atomic operations. Ordinary sessions are preserved; generic decision upsert cannot replace history. |
| F21 — Telemetry reconciliation | [Recovery](system-1-controller-protocol.md#root-operation-lifecycle-and-recovery) returns ran/recording-incomplete and durable operation lookup. Post-commit exceptions do not authorize fallback/replay. Recovery appends assertions without rewriting known abnormal observations. |
| F22 — Economic objective | [Economics](system-1-controller.md#verification-and-economics) puts quality/safety/completion before cost/latency. Cost per independently verified completion is undefined at zero successes and unavailable with incomplete accounting. Failover itself is not savings evidence. |
| F23 — Metric completeness | [Accounting](system-1-controller-protocol.md#accounting-responses-and-errors) includes both providers, failed pre-task work, pauses/switches, nullable usage/counts, known subtotals and pricing provenance. Unknown child populations cannot appear as zero cost. |
| F24 — Evaluator fidelity | [Economics](system-1-controller.md#verification-and-economics) records that the existing evaluator fixes model/effort and discards launch argv. Native allocation arguments must survive its adapter before valid economic comparison; evaluator extension is subsequent work. |
| F25 — Comparable experiment | [Economics](system-1-controller.md#verification-and-economics) requires preregistered fixed/deterministic/classifier arms with equivalent context, permissions, grading and recovery, including failover conditions. Full failure populations, clustered repeats and missingness remain required. |
| F26 — Verification/workflow | [ECC verification record](../workflows/system-1-verification.md) preserves historical evidence and current preflight. Dependencies now installed offline; full-suite isolation, coverage and native certification remain obligations. Retired workflow/profile sign-off is not required. |
| F27 — Private telemetry | [Capsule privacy](system-1-controller-protocol.md#portable-capsule-and-workspace-observation) preserves redacted status/event/error output. V3 explicitly changes opt-in private storage: continuation-enabled persists bounded original task/visible notes; disabled mode persists no task prose. No native transcripts/credentials or encryption claim. |

## V3 extension and changed assumptions

The user's continuation request changes the original first-slice scope; Claude
and same-tier provider switching are now included. The changes are explicit:

- Policy v2 separates capability tiers from 1–2 ordered provider alternatives.
  Classifier returns tierId; provider availability cannot lower floors. Capability
  next and same-tier resume use different durable transitions.
- Both runtime/context sets are pinned before launch. ECC catalog source root and
  task working root are distinct; destination context is re-resolved, not imported
  from a prior provider's receipt or proposal.
- Progress/switch/resume add explicit private capsule persistence and CAS journal
  updates. A classifier/model prompt does not ensure progress capture; integrations
  must actually call progress. Fresh workers inspect files and verify prior claims.
- Continuation keeps workspace edits through bounded safe-boundary file manifests.
  No source bodies are copied into state, no atomic-filesystem guarantee is made,
  and capture-to-resume drift stops execution.
- Automatic switching needs a certified typed subscription-limit mapping, normal
  root cessation, tool quiescence, complete bindings/capsule/manifest and a trusted
  synchronous-local-work assertion. Ambiguous 429/text/retry signals and uncertain
  effects stop for manual/recovery. Finite visited sets/budgets prevent ping-pong.
- Codex exec cannot identify quota cause from its JSONL. Codex app-server 0.155.1
  exposes usageLimitExceeded; native automatic behavior remains uncertified.
  Claude quota observations require exact version-scoped terminal correlation and
  non-overage route evidence; informational events alone are insufficient.
- Subscription login does not prove included entitlement or disabled paid extra
  usage. paidExtraUsageDisabled is an explicit operator assertion; unknown/API
  routes and observed overage reject. Account settings are never modified and a
  hard spend cap is not claimed.

Earlier independent v2 reviews also corrected response-versus-process fallback,
unapproved risk, closure acknowledgement, managed/native receipt distinctions,
all-branch final preflight, zero-exit failed-turn handling, recovery provenance
and nullable accounting populations. V3 preserves these decisions.

## What remains unproven

These are acceptance obligations, not implemented or native-certified fixes:

1. Policy/transport/state behavior, capsule confidentiality, race/crash recovery,
   both-direction continuation and outer-CLI behavior through meaningful unit,
   integration and E2E tests against the on-disk contract.
2. Full current-checkout suite in a dedicated test home with owned loopback/process
   cleanup, required legacy regressions and 80%+ coverage. The prior missing-tool
   limitation changed after locked offline dependency installation; it must not be
   carried forward as the current reason for an unexecuted gate.
3. Exact native authenticated/quota behavior and effective allocations on admitted
   transport versions. Help/schema generation and injected fixtures do not prove
   subscription entitlement, event reliability or universal cessation.
4. Independent completion grading and complete economic measurements. No live
   benchmark, native seamless handoff or production retention/performance claim
   follows from this documentation pass.

Remaining limits are root-only allocation, optional inherited classifier authority,
caller-asserted progress/safety/verification, conservative recovery and retrospective
accounting. Strong isolated inference, task-wide child control, hard spend caps,
automatic rollback, online policy learning, Rust and Obsidian require later work.

## Revision verification

This pass freshly reads the linked context/source contracts and preserves the
original report/appendix. Current evidence and checks are recorded in the
[ECC verification record](../workflows/system-1-verification.md). V2's historical
markdown lint, 52 local links/anchors, whitespace/Unicode/personal-path checks,
catalog and command-registry checks remain historical rather than v3 certification.
The current focused preflight passed 79 Node results; full suite, coverage and
native-provider acceptance remain distinct. No design omission is labelled an
implemented fix, passing native behavior or measured economic improvement.
