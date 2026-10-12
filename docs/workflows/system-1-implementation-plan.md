# System 1 implementation plan

Status: ECC implementation plan, 2026-10-11. This plans the complete proposed v3
controller; it is not passing implementation, native subscription certification
or an economic result. Dependencies were installed in this checkout with offline
npm ci and ignore-scripts. Preserve the lockfiles.

## Contract and delivery boundary

Read the [controller design](../design/system-1-controller.md),
[protocol](../design/system-1-controller-protocol.md),
[provider handoff](../design/system-1-provider-handoff.md) and
[verification record](system-1-verification.md) together. These on-disk documents
are the contract supplied to implementers and reviewers. Finish their v3 alignment
before dispatching production changes; review findings that change behavior must
update the documents before a fix-up implementation pass.

Deliver provider, model and effort selection; optional classification; dedicated
durable state; verification checkpoints; capability escalation; subscription-only
Codex/Claude execution; private portable task progress; manual provider switching;
guarded automatic usage-limit switching; recovery; accounting; and outer CLI
integration. A module-only partial build is not completion of this plan.

Use ECC planning, TDD and applicable code-quality/security reviews. The custom
two-agent workflow and Superpowers orchestration are retired. No profile sign-off,
fixed model lanes, external provider execution or deployment is introduced here.
Native evidence remains separately scoped: injected provider tests cannot certify
subscription billing, native transport behavior, seamless handoff or savings.

Ordinary synchronous ecc profile APIs, unconfigured launches, installation defaults
and provider homes retain their existing contracts. Build an additive asynchronous
allocation path. The existing synchronous launcher/proposal functions must not
silently become allocation execution adapters.

## Empirical preflight

The current-checkout focused run recorded 79 passing Node results in the private
log named ecc-system1-focused-preflight.log. Its state-store runner also printed
20 internal checks; those are not 20 additional Node results. The planner's earlier
launcher, Auto launch, selection, proposal and admission run recorded 78/78 Node
results. Neither run exercised the proposed controller or Claude quota transport.

Observed fixture interfaces include withFixture and write in
tests/lib/helpers/context-fixture.js, execute(command, args, options) injection in
launcher/proposal tests, and owned child/cleanup helpers in
tests/lib/helpers/state-store-worker.js. Read and exercise current helper signatures
before reusing them. Do not copy hypothetical tests into an implementation prompt.

Enumerated call sites show launcher/proposal execution in
scripts/lib/context-profile-launch.js, profile integration in
scripts/lib/context-profile-commands.js and dispatch in scripts/ecc.js. The latter
uses spawnSync and pipes generic-command stdin without supplying input; allocation
must explicitly forward inherited caller stdin. tests/run-all.js recursively finds
tests/**/*.test.js, so new suites do not need a hand-maintained test list.

The store initializes asynchronously but exposes synchronous locked transactions.
sql.js export follows commit; statement.run returns no changes count. Normal store
creation migrates and may create paths. Status therefore needs a separate validated
read-only opener. Never use ordinary store creation for status or dry-run.

## Ownership and dependency order

Workers share the checkout. Each owns only its assigned files and tests, must not
revert another worker's edits, and must accommodate concurrent changes. Shared
interfaces below are frozen before parallel work; proposed signature changes go
through the controller and the on-disk contract first.

| Owner | Files and responsibility | Dependencies |
| --- | --- | --- |
| Policy/validation | scripts/lib/allocation/errors.js, validation.js, policy.js; allocation validation/policy tests | Aligned v3 documents |
| Provider/runtime | scripts/lib/allocation/runtime.js, subscription-guard.js, provider-process.js, providers/codex.js, providers/claude.js; runtime/provider tests | Shared errors/normalized records; handoff admission contract |
| Persistence | scripts/lib/state-store/allocation-queries.js and allocation-snapshot.js; additive changes to state-store index, migrations, schema and schemas/state-store.schema.json; allocation-store tests | Shared errors/validation/policy transition invariants |
| Context worker | scripts/lib/allocation/context.js, journal.js, workspace.js and their tests | Aligned v3 source/privacy/workspace contracts |
| CLI worker | scripts/lib/allocation/commands.js; scripts/allocation.js, scripts/ecc.js, package.json; outer CLI tests and usage documentation | Controller API and injected/fake provider fixtures |
| Root/controller | scripts/lib/allocation/accounting.js, controller*.js; controller/accounting tests and QA record | Tested policy, provider and persistence APIs |

The root also owns any minimal extraction from existing context/native modules and
any package/script changes. Coordinate such changes before editing shared files.
Keep new modules focused and below the repository's file/function limits; split
validation or persistence helpers when needed rather than accumulating one large
module. No worker owns the existing design files through this implementation plan.

Sequence:

1. Align and re-read v3 design/protocol/handoff; record exact interface shapes.
2. Write failing requirement-derived tests for normalized records and pure policy.
3. Implement policy/validation while provider and persistence owners write isolated
   failing tests against the same agreed records; integrate the shared library.
4. Complete provider and persistence RED/GREEN, including adverse cases, before
   controller integration depends on them.
5. Implement context, journal and workspace primitives with isolated fixtures;
   integrate every public operation and accounting into the controller.
6. Connect the outer CLI and finish injected-process end-to-end flows, races and
   crash/recovery cases. Independently review against the on-disk contract.
7. Run required regression/security/coverage checks in the validated isolated test
   environment and write actual results in system-1-controller-qa.md.

## Shared records and module APIs

All public arguments are structured objects. Return new normalized objects; do not
mutate caller input. Validation rejects unknown keys recursively, controls, invalid
UTF-8, unsafe integers and invalid cross-references. Missing fields materialize only
the defaults expressly allowed by the protocol. Public errors expose stable safe
codes and sanitized messages, never input bodies or credential contents.

| Module API | Contract |
| --- | --- |
| AllocationError(code, exitCode, safeMessage) | Carries the protocol failure code and CLI classification; no arbitrary provider detail in public messages |
| normalizePolicy(raw) | Returns complete normalized policy with provider/tuple/tier references checked; pure, no filesystem/provider/DB work |
| normalizeOperationInput(operation, raw) | Returns strict normalized envelope; operation-specific policy/binding validation remains explicit |
| canonicalDigest(value) | Hashes normalized canonical JSON; sorts declared unordered sets, preserves preference/ladder order |
| evaluateInitialRoute({policy, requirements, availability, now}) | Returns exact route and nullable pending classifier request; floors precede routing and availability never lowers tier |
| validateClassifierChoice({policy, requirements, pendingRoute, response}) | Returns accepted eligible tier/reason or typed response rejection; cannot change requirements |
| selectTierAlternative({policy, tierId, requirements, availability, visitedIds, now}) | Chooses first eligible available unvisited alternative in preference order, or paused outcome |
| planCapabilitySuccessor({policy, revision, attempt, checkpoint, availability, now}) | Proposes one next-tier successor or exhaustion, without I/O or mutation |
| planProviderSwitch({policy, revision, attempt, sourceOperation, destinationAllocationId, availability, now}) | Proposes guarded same-tier other-target transition; checks budget/visited/compatibility and never authorizes execution itself |

Pure policy may describe a transition, but persistence rechecks all authoritative
frontier, journal, ownership, scope, visited-set and budget invariants inside its
transaction. No caller-created plan can bypass store checks. Availability is a
bounded nonsecret observation record, not a subscription balance or capability rank.

Runtime/provider interfaces:

| Module API | Contract |
| --- | --- |
| inspectRuntime({provider, workingRepoRoot, context}) | Verifies admitted executable/version/config/native/auth bindings using the designated native evidence adapter; returns nonsecret immutable observation and runtime digest |
| inspectRuntimeMetadata({provider, workingRepoRoot, context}) | Static executable/config/native identity verification without CLI version/auth calls; used for pure preview and all-provider preflight |
| validateSubscriptionBinding({provider, observation}) | Rejects API/unknown/conflicting auth routes and stale digest; does not authenticate or alter billing |
| buildOperationRequest({phase, provider, allocation, input, cwd, contextBinding}) | Produces immutable exact native command/argv/stdin/environment request, limits and transport contract; no arbitrary overrides |
| executeOperation(request, {spawn, clock, signal, onEvent, beforeSpawn}) | Async bounded native process execution; awaits beforeSpawn immediately before the process boundary; returns typed observation, usage, quota/quiescence and ephemeral finalText |

beforeSpawn is controller-owned and commits claimOperationLaunch only after the
final runtime/context/workspace checks. Failure means no invocation. onEvent emits
bounded normalized transport observations for transient processing; raw tool/body
events are not public telemetry. finalText is transient classifier/proposal parsing
input, never a persisted result. Process observation preserves actual nullable exit,
signal, abnormal category, source and known quota fields. Auth failures, generic
rate limits, prose and malformed framing cannot manufacture certified usage limits.

Adapters select provider-specific exact effort mappings, request framing, error
classification and quiescence evidence. Reject unsupported combinations; no effort
drop, paid API fallback, native session import or credential borrowing. Codex exec,
Codex app-server and Claude stream-json remain distinct admitted transports. Only
the fixed Codex app-server 0.155.1 usage-limit mapping supports automatic transitions
in this slice; implementation fixtures do not certify live behavior. Codex exec
and Claude stream-json are manual-only sources. A mixed policy may enable automatic
continuation from supported Codex source to Claude destination; destination transport
does not need automatic-source support. No injected certification flag or policy
override may admit an unsupported production mapping.

runtimeDigest is canonicalDigest(normalizePolicy(raw).providers[providerId]), using
the normalized provider descriptor, not the current observation timestamp. Verify
executable/version/config/native/auth independently. inspectRuntime returns exactly
runtimeDigest, routeDigest, subscriptionVerified, observedAt and provenance; the last
is bounded nonsecret evidence IDs/digests. validateSubscriptionBinding compares the
observed routeDigest with provider.authRoute.expectedRouteDigest. The route-digest
helper hashes only the admitted nonsecret authentication-route subset, excluding
secrets, timestamps and expectedRouteDigest itself; no circular hash or auth probe
command is introduced. Expose this helper to prepare configuration consistently.

Store interfaces:

| Module API | Contract |
| --- | --- |
| createAllocationStore({dbPath}) | Explicit-path asynchronous mutable opener wrapping the existing store and allocation query API; returns protocol atomic methods, close and bounded lookup/snapshot methods |
| openAllocationSnapshot({dbPath}) | Opens only existing safe published bytes, validates required schema/entities and exposes redacted reads; never creates, locks for writing, migrates or exports |
| claimInitial(input) | Atomically claims immutable revision/session ownership, idempotency record, first attempt, initial capsule when enabled and prospective root intents |
| acceptRoute(input) | CAS records one accepted route after classifier processing; pending initial route becomes immutable before proposal/task reservation |
| reserveOperation(input) | CAS reserves a bounded phase/allocation root intent before claimOperationLaunch; later proposal/task allocation may be unknown at initial claim |
| claimOperationLaunch(input) | CAS owner/frontier and current input/receipt binding, mark launch-initiated once |
| recordOperationCompletion(input) | Appends immutable typed observation/metrics; quota availability and any automatic successor reservation commit together |
| recordProgress(input) | CAS identity/attempt/frontier/journalVersion; complete private journal replacement plus public digest receipt atomically |
| acceptCheckpointAndReserveSuccessor(input) | Immutable evidence/outcome plus any next-tier successor and frontier increment in one transaction |
| reserveProviderSwitch(input) | Manual same-tier transition with source result, safe manifest/capsule version, visited alternative and global switch budget guards |
| claimNext(input), claimResume(input) | Claims exactly its saved successor once; no reclassification or override; preserves saved transition/capsule/manifest binding |
| recordProviderAvailability(input) | Append/update bounded runtime/auth-bound cooldown evidence without probing providers or shortening holdoff |
| reconcileOperation(input) | Appends recovery assertions, retains known observations and closes/reconciles safely; never launches |

Each mutation receives identity, applicable event/request IDs, canonical payload
digest, expectedFrontier and expectedJournalVersion when required, plus ownerId and
normalized operation records as applicable. Return a bounded committed receipt
containing replayed, frontier, journalVersion, task/attempt state and applicable IDs.
Replay returns the original outcome; unresolved work returns busy/recovery without
execution. New operation IDs are globally unique within the DB. Public methods own
one short synchronous transaction. Internal quota/transition helpers may share that
transaction; never invoke a public transactional method inside another.

Capsule/manifest content remains private. getRevision(identity) and getOperation(id)
return validated redacted stored records; getRevision(identity, {private: true}) is
controller-only and also returns capsule/journal/workspace material. Read-only status
always uses its sanitizer and never enables private access. No query, notes, manifest
paths or original operation envelope may reach status/error/result. Reopen validates
stored entities rather than trusting JSON.

Root-owned integration:

| Module API | Contract |
| --- | --- |
| resolveContextPreview({provider, context, task, workingRepoRoot, registryRoot}) | load false, provider-specific source/native receipts and pending proposal metadata; no home preparation |
| revalidateContext(binding), assembleTaskInput(input) | Recheck admission/source/selected bodies, destination context and total byte reservation before every task call |
| normalizeJournalUpdate(input), buildPortableContinuation(input) | Bounded public notes plus original task bindings; no native reasoning/transcript/session IDs; enabled-only private persistence |
| captureWorkspaceManifest({repoRoot, exclusions}), assertWorkspaceManifest(input) | Safe bounded tracked/nonignored-untracked manifest and pre-spawn revalidation; reject incomplete/unsafe capture |
| summarizeAccounting({operations, timingObservations}) | Nullable observed/subtotal/complete metric series; no invented child populations or subscription task price |
| runAllocationOperation({operation, input, policy, dbPath, dryRun}, dependencies) | Awaits full lifecycle and close; sequences pure preflight, durable intent, native execution, persistence and permitted continuation |
| parseArgs(argv), readOperationInput(inputPath), main(argv, dependencies) | Strict operation flags, bounded file/stdin, sanitized exact result and exit mapping; wrapper dispatch forwards stdin |

Controller dependencies include store openers, provider inspection/execution,
clock/ID factories and context/workspace helpers. Production entrypoints choose real
adapters; test injection is a module API, not an unvalidated external CLI flag.
Dry-run branches before either DB opener or any auth/provider/capsule writes and
reports pending classifier choice honestly. Progress, checkpoint, switch, status and
recover never infer; resume/next claim their saved transition before execution.

The public task repoRoot/cwd becomes workingRepoRoot at the context module boundary.
registryRoot defaults to the
existing context source DEFAULT_REPO_ROOT, not the working repository. Tests inject
a fixture registryRoot explicitly; destinations re-resolve the same pinned registry
projection for their own provider. Never require arbitrary user repositories to
contain ECC's registry, profiles or skills.

## Exact internal DTOs for parallel integration

These are internal structured module contracts, separate from the public operation
envelopes. All listed fields are required; expressly nullable fields retain null.
Use the public protocol's strict domains for IDs, digests, timestamps, results,
metrics, evidence, route and acknowledgements. Store derives mutable projection
fields and rechecks transitions inside transactions; caller fields cannot set state,
frontier, switch counts or visited sets directly.

| DTO | Exact fields and nullability |
| --- | --- |
| binding | taskDigest, queryDigest, requirementsDigest, policyDigest, contextSetDigest, runtimeSetDigest, repoIdentityDigest, repoRoot, cwd, contexts, contextSourceBindings, runtimeBindings, requirements; no raw task/query/notes |
| operation intent | operationId, attemptId, phase, providerId, tierId, allocationId, runtimeDigest, requested, finalContextDigest, workspaceManifestDigest, inputDigest; tierId null only pre-route, finalContextDigest/workspaceManifestDigest null until applicable; inputDigest hashes assembled transient input |
| requested | modelId, effort, runtimeDigest; exact declared tuple |
| completion | result, observed, metrics; exact protocol schemas, no finalText/stdout/stderr/input |
| automatic transition proposal | transitionId, successorAttemptId, destinationAllocationId, expectedJournalVersion, workspaceManifest, acceptedRoute; acceptedRoute null except pending-classifier quota establishing fallback tier |
| mutation receipt | replayed, finalized, receiptId, outcomeCode, frontier, journalVersion, taskState, attemptId, operationId, transitionId, checkpointId; nullable IDs/version only when inapplicable; original replay outcome retained |
| provider execution return | result, observed, metrics, finalText, responseFraming, eventCount; finalText nullable transient bounded string; responseFraming single-turn/invalid-multiple-turns/unobserved is transient; all quota/quiescence facts inside typed result |
| runtime observation | runtimeDigest, routeDigest, subscriptionVerified, observedAt, provenance; provenance contains only safe evidence IDs/digests and admitted mapping identity |

Operation intent has no caller state/result fields. reserveOperation derives reserved;
claimOperationLaunch derives launch-initiated. finalContextDigest is the selected
context receiptDigest, not managed/native receiptDigest. Store completion updates
that operation once, preserving immutable observed facts through later recovery.
The root strips transient strings before constructing any store/event argument.

| Atomic method | Exact argument fields |
| --- | --- |
| claimInitial | requestId, payloadDigest, identity, ownerId, now, policy, binding, route, attemptId, capsule, previousClosureAcknowledgement, automaticContinuationAcknowledgement |
| acceptRoute | identity, expectedFrontier, ownerId, route, now |
| reserveOperation | identity, expectedFrontier, ownerId, operation, now |
| claimOperationLaunch | identity, expectedFrontier, ownerId, operationId, finalContextDigest, workspaceManifestDigest, inputDigest, now |
| finishRequest | receiptId, identity, ownerId, expectedFrontier, outcomeCode, now |
| recordOperationCompletion | identity, expectedFrontier, ownerId, operationId, completion, automaticTransition, now |
| recordProgress | progressId, payloadDigest, identity, attemptId, expectedFrontier, expectedJournalVersion, journal, now |
| acceptCheckpointAndReserveSuccessor | checkpointId, payloadDigest, identity, attemptId, expectedFrontier, supersedesCheckpointId, kind, cause, evidence, successorAttemptId, now |
| reserveProviderSwitch | switchId, payloadDigest, identity, attemptId, sourceOperationId, expectedFrontier, expectedJournalVersion, destinationAllocationId, transitionId, successorAttemptId, effectAcknowledgement, workspaceManifest, now |
| claimNext | requestId, payloadDigest, identity, attemptId, parentAttemptId, checkpointId, expectedFrontier, policyDigest, runtimeSetDigest, taskDigest, ownerId, effectAcknowledgement, now |
| claimResume | requestId, payloadDigest, identity, attemptId, parentAttemptId, transitionId, expectedFrontier, expectedJournalVersion, policyDigest, runtimeSetDigest, ownerId, now |
| recordProviderAvailability | availability, now |
| reconcileOperation | recoveryId, payloadDigest, identity, operationId, expectedFrontier, action, recoveryEvidence, observedCompletion, now |

now is a valid UTC observation timestamp supplied by the controller's injected clock.
claimInitial route is null while classification is pending; capsule is null when
continuation is disabled, otherwise the private strict capsule. Closure/automatic
acknowledgements retain their protocol nullable rules. acceptRoute requires a concrete
accepted route; identical already accepted value is safe, a different value conflicts.
Store derives ordinal zero and subsequent ordinals from its own frontier history.

contextSourceBindings is keyed by every provider ID and contains exactly metadataDigest
and registryIdentityDigest from the initial context preview. contextSetDigest hashes
exactly {contexts, contextSourceBindings}; descriptor hashes alone cannot bind registry
sources. Re-resolve and compare these digests before subsequent launches.

Request receipts for run/next/resume begin finalized false. finishRequest binds their
final code/frontier/state once after execution; identical finalized receipts replay,
and conflicting finalization rejects. An incomplete receipt is never re-executed.
Other mutation receipts are finalized immediately. Recovery abandon may name null
operationId for an unlaunched/no-operation pause, with all closure assertions.

recordOperationCompletion automaticTransition is null unless all automatic guards
hold. Its internal transaction records quota, availability and successor together;
pending-classifier acceptedRoute must be the conservative fallbackTier route and is
validated inside that transaction. Normal classification first records its result,
then acceptRoute records the locally validated route. Failed persistence never
authorizes task/proposal execution. An automatic proposal is not trusted merely
because the caller supplied it; built-in mapping/quiescence/consent/budget/capsule/
availability checks still run in the store transition.

Nullable successorAttemptId is allowed for a checkpoint that cannot reserve a
successor; otherwise root supplies a new safe ID and store derives next-tier choice.
supersedesCheckpointId, destinationAllocationId and observedCompletion retain public
nullable domains. RecoveryEvidence passed to storage replaces nonpersistent summary
with nullable summaryDigest and keeps the remaining exact protocol fields; raw summary
is never stored. claimNext receives taskDigest instead of originalTask and never stores
handoffSummary. Public input payloadDigest is computed before this deliberate stripping.

The availability DTO is exactly the protocol's stored availability record, including
provider/runtime/auth scope and observed holdoff/reset evidence. It cannot independently
reserve a successor. Source usage-limit completion uses the combined completion
transaction; standalone availability recording must not create a split quota claim.
Bounded lookups expose stored receipt by global ID, revision by identity and operation
by ID. Query/journal content exists only in the explicit private capsule/progress store.

## Requirement-derived TDD and verification

New test filenames below are planned and not yet executed. Introduce each suite,
run its exact command, inspect the failure, and retain meaningful RED evidence
before production behavior. Missing-module/import failure may establish the initial
scaffold failure; once a stub exists, require behavioral failures proving guards
and state transitions. Do not edit assertions to absorb a failing implementation.

| Owner/suite | Planned command | Required behavioral evidence |
| --- | --- | --- |
| Validation/policy | node --test tests/lib/allocation-validation.test.js tests/lib/allocation-policy.test.js | Complete routing domains; floors; unsupported effort/provider tuples; safe null/defaults; contiguous tier suffix; cooldown without downgrade; finite switch plans |
| Runtime/providers | node --test tests/lib/allocation-runtime.test.js tests/lib/allocation-provider.test.js | Exact both-provider requests; API/unknown auth rejection; typed quota versus prose/429; bounded framing/output/termination; pending tools; effort preserved |
| Persistence | node --test tests/lib/allocation-store.test.js | Existing-data migration; strict entities; reopen; global replay/conflict; independent handles/process contention; quota/availability/transition atomicity; commit/lock-release ambiguity |
| Context/journal/workspace | node --test tests/lib/allocation-context.test.js tests/lib/allocation-journal.test.js tests/lib/allocation-workspace.test.js | Destination source projection; private prose opt-in; CAS progress; manifest limits/deletion/untracked/drift; no hidden reasoning/session transfer |
| Controller | node --test tests/lib/allocation-controller.test.js | Entire lifecycle; no transparent retry; both-direction manual switch; guarded quota auto; pre-task quota; exhaustion/pause/recovery; redacted accounting |
| Outer CLI | node --test tests/scripts/allocation.test.js | ecc stdin forwarding; async initialization/close; pure preview; read-only status; invalid/duplicate flags; reopened complete flows with injected native processes |

Use temporary fixture repositories, owner-only SQLite paths and injected owned
provider processes. No unit/integration test contacts a native subscription or
touches ordinary provider homes. Include crash windows at reservation, launch marker,
spawn, result capture, publication, capsule update, transition reservation and claim.
Retain abnormal observations during recovery. Independent race fixtures must own
and clean up child processes rather than leave background workers running.

Each module pass runs its suite plus affected legacy regressions. Relevant observed
legacy files are context-profile-launch, context-profile-auto-launch,
context-selection, context-profile-proposal, context-selection-admission and
state-store tests under tests/lib. Native Claude regressions need a fresh fixture
read and isolated execution before any shared native helper changes.

After all integration is complete, independently review correctness against all
three design documents, security boundaries and test quality. Run local lint,
source validators, the relevant focused regressions, isolated npm test and npm run
coverage. The repository requires at least 80% lines/functions/branches/statements;
record actual global results and any unresolved baseline issue without waiving the
requirement or claiming missing measurement passes. First exercise dedicated test
homes and loopback permissions; previous full-suite runs failed at that boundary.

At each task-batch boundary, compare this plan and shared APIs with files on disk
and report drift before dependent work. This plan contains no implementation/test
code blocks. Native certification, auth/quota fixtures and economic experiments
retain their explicit evidence boundary; no live savings claim follows a mocked
controller pass.

## Completion record

system-1-controller-qa.md must name actual environment, RED/GREEN commands/results,
focused legacy results, isolation/full-suite/coverage results, reviews addressed,
known unsupported native combinations and remaining certification boundaries.
Every public operation and complete v3 acceptance matrix must be implemented and
tested before reporting the controller built. Keep the design and QA record
consistent with delivered behavior; do not rewrite the contract to conceal drift.
