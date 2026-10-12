# System 1 allocation controller

Status: proposed contract v3, 2026-10-11. Not implemented or runtime-certified;
model quality, seamless native handoff and economic savings remain unproven.
ECC planning, test-driven implementation and applicable reviews govern delivery.

This document, the [protocol](system-1-controller-protocol.md) and
[provider handoff](system-1-provider-handoff.md) form one normative contract.
The [review resolution](system-1-controller-review-resolution.md) preserves the
27 original findings and identifies the v3 extension.

## Purpose and scope

Choose model and reasoning effort for explicit coding-task launches using a
deterministic policy and an optional fast classifier. When an admitted provider
cannot continue, preserve task state and support a safe switch between the user's
Codex and Claude Code subscriptions. Quality, completion and inherited safety
requirements constrain cost and latency; token minimization alone is not the goal.

The first slice is a configured heuristic, not a measured optimizer or online
learning system. It includes JavaScript, a separate asynchronous allocation CLI,
Codex and Claude root operations, checkpoints, portable task state and additive
SQLite persistence. Ordinary interactive sessions are unchanged. Rust ECC2,
Obsidian, task-wide child allocation, publication and live economic evaluation
remain subsequent work.

Continuation starts a fresh destination-provider session using the original task,
accepted visible progress and the current workspace. It does not transfer hidden
reasoning, native transcripts, native session IDs or provider authentication.
Automatic switching is conditional on a certified typed quota signal and the
scoped safety guards below. Unsupported or ambiguous signals preserve progress
for manual acknowledgement or recovery instead of guessing.

Controls and floors apply only to controller-launched root operations. Native
subagents and model-backed tools may have independent settings and costs. Floors
do not grant permissions or certify security, quality or child capability.

## Existing contracts and compatibility

Read before implementation or revision:

- [Context delivery](context-profile-delivery.md) and
  [foundation](context-profiles.md): selection, source bindings, native boundaries,
  discovery versus authority, and bytes versus native token observations.
- [Launcher](../../scripts/lib/context-profile-launch.js),
  [proposal](../../scripts/lib/context-profile-proposal.js) and
  [profile commands](../../scripts/lib/context-profile-commands.js): existing
  synchronous operations and inherited runtime policy.
- [Schema](../../schemas/state-store.schema.json),
  [store](../../scripts/lib/state-store/index.js) and
  [migrations](../../scripts/lib/state-store/migrations.js): asynchronous
  initialization, synchronous locked transactions and snapshot publication.
- [Evaluation](context-profile-ai-evaluation.md) and
  [verification record](../workflows/system-1-verification.md): independent grading,
  empirical preflight and unresolved execution evidence.

Unconfigured ecc profile operations retain interfaces, argv order, limits,
environments, schemas and behavior. Reuse context selection/admission and native
binding helpers through explicit opt-in options; the new asynchronous provider
path must not silently replace the existing synchronous launcher. Existing source
contracts describe existing behavior; this document proposes an extension.

The task's repoRoot and cwd identify its canonical working repository. The ECC
registry/source root identifies the executing ECC installation and its bound
compiler/profile/skill resources. They are separate identities even when their
paths happen to coincide. Context selection reads the pinned ECC source root,
never an opportunistic catalog from the working repository. Source-root identity,
source receipts and final selections remain bound and revalidated for each provider.
An injected registry root is a trusted fixture dependency, not a caller runtime
permission to replace source bindings mid-revision.

## Allocation configuration

Configuration is strict ecc.allocation-policy.v2 UTF-8 JSON, at most 65,536 bytes.
Unknown fields, NUL, terminal controls, unsafe integers and invalid references
reject. IDs use the protocol's safe syntax and are at most 128 bytes.

| Field | Required contract |
| --- | --- |
| schemaVersion | Exactly ecc.allocation-policy.v2 |
| policyVersion | Safe operator ID; canonical digest binds normalized contents |
| providers | 1–2 pinned runtime records with distinct Codex/Claude targets |
| allocations | 2–32 unique records defined below |
| tiers | 2–8 records; each has id and 1–2 ordered allocationIds of distinct targets |
| taskLadder | Every tier ID exactly once; sole capability escalation order |
| bands | routine/standard/demanding tier IDs; routine first, demanding last |
| riskMinimums | Complete low/medium/high map with nondecreasing positions |
| phaseMinimums | Complete map for the protocol's eight phases |
| fallbackTier | Last ladder tier; compatible with every accepted task |
| classifier | Disabled, or one allocationId with inherited-authority acknowledgement |
| contextProposals | Per-provider null or same-provider allocation plus acknowledgement |
| continuation | Explicit enabled/automaticOnUsageLimit/maxSwitches/cooldownMs |
| limits | Exact deadline/reservation fields in protocol; fixed output bounds |

Each task allocation belongs to exactly one tier. Classifier/proposal allocations
may be separate records outside tiers. There is no second rank or escalation
order. A tier groups operator-declared alternatives that individually meet that
level's task requirements; common tier membership is not measured equivalence.
Ordered alternatives express provider preference, not an automatic quality claim.

An allocation has exactly id, providerId, modelId, effort, descriptor, capabilities
and maxSubmittedBytes. Model IDs are 1–128 bytes matching
`^[A-Za-z0-9][A-Za-z0-9._:/-]*$`. Descriptors are 1–512 nonsecret bytes; capabilities
are 0–16 unique safe IDs. Submitted capacity is 8,192–65,536 bytes.
Codex effort is low/medium/high/xhigh/max/ultra; Claude effort is low/medium/high/max.
Each exact CLI/model/effort tuple requires declared support and a documented
adapter mapping. Unsupported effort rejects; it is never dropped or translated
by assumption. Names do not prove entitlement, availability, price or quality.

For a task, individually compatible alternatives meet the union of required and
verification capability tags plus submitted-byte reservation. Tiers with at least
one compatible alternative must form a nonempty contiguous suffix of taskLadder.
Reject empty/noncontiguous compatibility before inference; fallbackTier must be
eligible. Record incompatible alternatives and never launch them. Availability
is separate: an exhausted tier pauses rather than weakening requirements or
routing to a lower tier.

Reservation covers maximum assembled query, capsule/handoff, context and wrapper
bytes, at most 65,536. Actual input must fit its operation-specific cap and chosen
allocation capacity. Query/context keep separate caps. Byte capacity is an
operator declaration, not native context-window/token certification. Effective
startup context remains unknown unless observed.

## Requirements and initial routing

The protocol defines strict requirement defaults, assessment provenance and
expected verification. Shared task identity must match. Missing complexity or
ambiguity becomes unknown; missing/unapproved risk becomes high. Malformed
values reject rather than being coalesced into a favorable route.

Apply policy in this order:

1. Validate inputs, policy, all runtime/context/source bindings and compatibility.
   Effective minimum is the maximum of compatibility, risk and phase positions.
2. Explicit allocation bypasses classification and selects its containing tier
   and initial alternative. Reject outside-tier, below-minimum, incompatible or
   unavailable choices; never silently substitute a caller's explicit choice.
3. Apply the table. A band route uses its band position or effective minimum,
   whichever is higher, then the first available compatible alternative there.
4. If classification is requested but only one eligible tier remains, choose it
   without classification. If no alternative there is available, pause.
5. Otherwise invoke the enabled classifier once or select fallbackTier when
   disabled. Validate its tier locally, then choose an available alternative.

| Complexity | Ambiguity | Action |
| --- | --- | --- |
| Any | high | Demanding band |
| complex | Any | Demanding band |
| simple | clear | Routine band |
| moderate | clear or bounded | Standard band |
| simple | bounded | Classification |
| Any remaining combination containing unknown | Remaining values | Classification |

The first two rules take precedence; all valid combinations are covered. Phase
sets its configured minimum; expected verification contributes capability tags
and success criteria. The classifier cannot modify these fields or permissions.

A fixture policy uses three opaque tier IDs with distinct declared model/effort
choices; routine/standard/demanding in order; low risk at routine, medium/high at
standard; docs/maintenance at routine and other phases at standard. Low-risk
simple/clear docs and low-risk complex tasks must route differently without a
classifier call. Fixtures are not recommendations of live models or risk rankings.

## Runtime identity and authority

Pin each provider's executable, SHA-256 fingerprint, adapter/transport, exact CLI
version, environment mode, known configuration and subscription route. Bind every
allowed provider/context into the revision before its first operation, not just
the initially selected provider. Changing an allowed binding needs a new revision.

The [handoff evidence contract](system-1-provider-handoff.md) defines exact
admission and typed signals. Codex exec admits 0.154.0/0.155.1 but its JSONL drops
the typed quota cause, so it does not support automatic usage-limit switching.
Codex app-server 0.155.1 exposes usageLimitExceeded separately from rateLimitExceeded;
its adapter still needs native certification. Claude stream-json admits the
fixture-supported exact versions in the protocol; current-provider 2.1.261 is
separate from isolated-native 2.1.292 or admitted later 2.1 patches. Existing native
preparation cannot certify an older Claude binary.

Current-provider mode preserves inherited task policy while rejecting API,
third-party endpoint and unknown authentication routes. Isolated-native reuses
verified homes/generations, restricted environment and source receipts; each home
must already be separately authenticated. Neither mode copies credentials, borrows
ordinary-home authentication, prepares provider homes or changes account settings.
The subscription guard is distinct from native context discovery readiness.

Auth route has mode, method, expectedRouteDigest, observedAt and the explicit
paidExtraUsageDisabled true operator assertion. Revalidate nonsecret route evidence
before each operation and fail closed on unknown/conflicting/API routes. Login
status alone does not prove a requested model is included or available. The paid
extra-usage assertion is a trusted operator statement about existing account
settings, not observed proof or a hard spend cap. Observed overage blocks; a
missing assertion blocks admission. No automatic API/credits fallback is allowed.

Known source/native/config digests are bounded provenance, not full managed or
remote configuration attestation. Record requested model/effort/backend separately
from nullable observed effective values and their source. Argv proves a request,
not effectiveness or entitlement. Bookkeeping normalization must be explicitly
defined and fixture-observed per provider; a benign excluded bookkeeping rewrite
is not silently treated as immutable configuration.

Classifier defaults to disabled. Its optional inherited-authority mode explicitly
acknowledges that read-only/ephemeral requests do not eliminate repository
instructions, hooks, MCP/apps, delegation, extra reads or remote effects. A
classification prompt is advisory. Bounds constrain submitted bytes, direct CLI
runtime and captured output, not total reads, inference calls or whole-task spend.
Certified minimal classification is deferred.

Context proposal is separately allocated, invoked, recorded and charged. It uses
the chosen provider's source/admission contract; provider switching re-resolves the
destination context and any required proposal. No Codex receipt or prior-provider
proposal authorizes Claude content. Task allocation does not silently control
native-child allocation.

## Classifier and provider transport

Submit complete query, effective requirements and eligible tier IDs with bounded
operator descriptors/capabilities. Do not submit loaded workflow bodies or full
repository/transcript. Input is at most 32,768 UTF-8 bytes; overflow rejects,
never truncates. Original query remains at most 8,192 bytes. Inherited tools may
read additional data within their native policy.

Final classifier JSON has exactly tierId and reasonCode; reason is
requirements-match/conservative/uncertain. No free text is accepted or persisted.
Validate exact keys/types, eligibility and floors locally. Controller chooses the
compatible available provider alternative, keeping classification and availability
separate. Proposal retains existing bounded selected-ID admission/decline semantics.

Use the pinned transport through shell-false execution, stdin and explicit canonical
working cwd. Exact model and safely serialized effort are supplied with no arbitrary
config override. Task calls add no permission, approval, hook or tool-policy override.
Transport details, app-server session lifecycle and observation provenance are
owned by the handoff document.

Classifier/proposal ordinary responses require one completed root turn, no failed
or error turn, normal exit zero and valid framing. Task can have multiple turns;
ordinary completion requires completed root work without error/failed events.
Claude is_error true overrides subtype success and process exit zero. Missing or
malformed usage makes accounting unknown, not automatically task failure.
App-server terminal turn and orderly server cleanup are separate observations;
cleanup cannot manufacture root success or erase an interrupted active turn.

After normal exit-zero without recorded provider errors, invalid classifier
response/framing can use the conservative response fallback. Proven no-spawn
classifier failure can also fall back. Other classifier/process errors block;
proposal failure stops before task. Input, integrity and persistence failures never
become response fallback. Timeout, overflow, cancellation, crash or uncertain
execution requires recovery before another provider operation.

A confirmed typed subscription limit is a separate availability category. Plain
text, generic 429/rate_limit/api_retry or an informational limit event alone is
insufficient. For Claude, a terminal error must correlate with a supported rejected
subscription window and non-overage route; observed wire shapes remain version-scoped
and uncertified for native automatic handoff. Classifier quota can establish
fallbackTier before a guarded switch, without another classifier call. Proposal
quota keeps the accepted tier but repeats destination context resolution.

## Limits and shared preflight

Classifier/proposal deadline defaults to 30 seconds, configurable 1–60 seconds.
Task defaults to 300 seconds, configurable 5–1,800 seconds. Each classifier/proposal
stdout/stderr stream is bounded at 65,536 bytes; each task stream at 1 MiB.
Context proposal does not shorten task time. Legacy limits remain unchanged.

Each provider operation follows this sequence:

1. Validate policy/request, canonical working repo/cwd, all runtime/context/source
   metadata and auth-route guards. Do not load selected workflow bodies yet.
2. Claim task/operation and persist intent before provider work. Failed/uncertain
   persistence cannot authorize invocation; execution is outside the transaction.
3. Recheck source/native/executable/config/auth bindings and persist launch-initiated
   before crossing the subprocess boundary.
4. Persist immutable typed process/turn/tool/usage observations. Recheck integrity
   afterward and before any next call; uncertain persistence forbids another call.
5. Before every task launch, revalidate destination selection/admission/source,
   load permitted bounded content, assemble actual input and bind the final receipt.
   This includes explicit, deterministic, declined and noWorkflow selections.

These checks are bounded consistency checks, not an atomic repository snapshot.
Use immutable source artifacts where stronger source guarantees are required.
Dry-run does not create/open/migrate DB state, invoke providers/auth commands,
load selected bodies or manufacture a classifier selection.

## Checkpoints and recovery

Protocol owns immutable IDs, atomic transitions, evidence and errors. Initial run
claims a revision once. Next consumes an accepted capability successor in the next
tier without reclassification or allocation override. Same-tier provider switching
has a separate transition and resume operation; it is never capability escalation.
Pin complete bounded policy/runtime/context snapshots rather than just digests.

Only accepted capability-relevant failure/ambiguity/stall advances one tier.
Environment/requirements/unknown blockers suspend; process failure does not prove
more reasoning helps. Last-tier capability failure exhausts. Success, exhaustion
and abandonment are terminal; provisional verification can receive later evidence.
No automatic same-allocation retry, de-escalation or native conversation transfer.

One active/uncertain owner and one successor of either kind span the task frontier.
Guarantees cover this DB's controller operations, not arbitrary external launches.
Root exit cannot prove descendants or remote effects stopped. Abnormal/missing
completion, unknown tools or uncertain recording blocks all providers until explicit
reconciliation. PID absence, elapsed lease or SIGKILL alone is insufficient.
Recovery records evidence without erasing known abnormal observations and launches
nothing. New revision closure also requires cessation/effect acknowledgement;
terminal outcome alone cannot bypass it.

Checkpoint handoff binds the original task, parent attempt/tier/allocation,
checkpoint/cause, verification IDs and workspace/artifact observations. Supplied
summary is bounded untrusted data, at most 4,096 bytes within an 8,192-byte handoff;
no evidence path/URL is fetched or promoted to authority. Retry acknowledgement
is not idempotency proof. Changed query, phase, risk, scope, policy or runtime needs
a new revision after safe closure.

## Portable progress and provider continuation

Continuation is explicit opt-in to private task prose persistence. Disabled mode
stores no query/journal and rejects progress/switch/resume. Enabled mode keeps the
bounded original task plus plan/decisions/completed/pending notes in a private
capsule with immutable versions/digests. Actual progress API updates use frontier
and journalVersion CAS; prompt advice alone does not enforce journal updates.
Absent updates leave empty/outdated notes. Destination workers inspect current
files and independently verify claimed completed work.

Capsule/journal content is omitted from public status, events and errors. Owner-only
DB/directory permissions and existing private-path checks are required. No hidden
reasoning, native transcript, source bodies, selected-skill bodies or credentials
are intentionally stored. Sensitive task prose is not encrypted by this design;
secret detection is best effort and trusted callers must submit nonsecret notes.
Protocol specifies capsule/journal bounds, atomic publication and retention scope.

After safe cessation, capture bounded tracked/nonignored-untracked file paths,
file digests and deletions without storing bodies. Exclude .git, ignored/build/
dependency/private-home state within an immutable declared scope; reject symlinks
and incomplete/overflowing captures. Capture after the source worker's edits,
then revalidate before successor spawn. Unexpected capture-to-resume drift rejects;
no reset, stash, automatic rollback or arbitrary editor lock is introduced.

Manual switch reserves a compatible, available, unvisited other-provider alternative
in the accepted tier, after completed/proven-not-started source work and explicit
effect acknowledgement. It does not stop an active worker or execute the successor.
Resume consumes the saved capsule/transition without new query or model overrides.

If an unsupported classifier transport fails before a tier is accepted, manual
switch cannot yet reserve a same-tier successor. Safely close that revision and
start a new revision with explicit allocation or disabled classification. Do not
manufacture quota evidence or capability from an ambiguous provider failure.

Automatic switching additionally requires configured consent, a certified typed
subscription limit, normal observed root termination, no pending/unknown tools,
intact bindings/capsule/manifest, remaining budget and a trusted workload assertion.
The assertion names caller/time/policy scope and declares synchronous local work
without detached descendants or external effects. This is a scoped caller trust
model, not universal process-tree quiescence or exactly-once external effects.
Unsupported workloads use manual acknowledgement/recovery.

maxSwitches is 0–4 per revision and never resets on capability escalation.
Each entered tier has its own visited alternatives; reservation immediately marks
the destination visited and consumes budget, including later failure/crash.
No ping-pong, hidden probe or weakening of floors occurs. Provider holdoff is
DB-scoped and bound to runtime/auth identity; trusted native reset time is nullable
and separate from configured local cooldown. Expiry is eligibility to try on a
future explicit task/revision, not proof renewed entitlement. With no destination,
pause and retain the capsule. Status neither polls nor launches work.

## Verification and economics

Exit-zero and model prose remain unverified. Evidence must match expected checks,
task/revision/attempt and artifact/workspace. Controller records caller assertions
and provenance, not independently certified test execution. Operational terminal
success is asserted-success; only a separate trusted grader establishes independent
verified completion. Journal progress is not verification evidence.

Record every actual root operation on either provider, including failed pre-task
work and switches, with phase/allocation/duration/result and usage availability.
Complete/known-subtotal/unavailable are distinct. Root usage cannot certify child
or tool totals. Verification, human delay and recovery are separately observed or
explicitly excluded. Subscription cash allocation is nullable; API-equivalent
estimates require pricing provenance. Retrospective accounting is not a spend cap.

Before economic evaluation, prove allocations survive its adapter: today's evaluator
fixes model/effort and discards launcher argv. Compare preregistered fixed,
deterministic-only and classifier-assisted policies under equivalent task/context/
permission/verification/recovery conditions, including failover conditions.
Use fresh workspaces; bind runtime/source/corpus/order/repeats/margins/stop rules.

Retain scheduled failures, pauses and abandonment; cluster repeated tasks and hold
out graders/calibration. Report quality/completion by risk/phase, end-to-end/provider/
human/tail latency, missingness and cash versus API-equivalent cost. Cost per
independent completion is undefined at zero successes and unavailable if accounting
is incomplete. Quality/safety/completion govern acceptance before cost/latency.
Synthetic providers prove plumbing, not model quality, seamless native handoff or
savings.

## Acceptance and readiness

Use the [protocol matrix](system-1-controller-protocol.md#acceptance-matrix),
[handoff gates](system-1-provider-handoff.md) and
[original adversarial matrix](system-1-controller-review-appendix.md) as behavioral
contracts. Verify actual fixture APIs, commands and environment gates before
writing planned test code. Required cases include tier/floor routing, both-provider
bindings, strict typed quota discrimination, safe manual/automatic transitions,
CAS/replay/race/crash recovery, private capsule/workspace integrity, additive-store
preservation, root accounting, dispatcher stdin and unconfigured legacy behavior.

At original commit 2d515e4fc2ddef97354769812cf3f7b9ec4e5124, current-checkout focused
legacy preflight produced 79 passing Node results, including the store runner's
20 internal checks. Those checks are not additional independent Node tests or
controller certification. Observed fixture names include withFixture, nativeFixture
and skill:feature. Locked dependencies installed offline without lifecycle scripts;
isolated full-suite and 80%+ coverage evidence remain delivery obligations.

Read all three design documents as one contract; design revisions precede
implementer dispatch. The custom two-agent workflow and its gate-profile approval
are retired under the user's current instructions. Native authenticated/quota
behavior, effective settings, delegated authority and economic comparisons remain
uncertified until explicit evidence is recorded in the verification record.
