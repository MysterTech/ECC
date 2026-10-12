# System 1 controller protocol and durable state

Status: proposed contract v3, 2026-10-11; not implemented or runtime-certified.
This document, [the controller design](system-1-controller.md) and
[provider handoff](system-1-provider-handoff.md) form one normative contract.
The design owns routing; this document owns schemas, transitions, persistence
and errors. The handoff document owns the subscription and transport evidence
boundary. ECC planning, test-driven implementation and applicable reviews govern
delivery; no retired custom workflow or Superpowers orchestration is required.

## Public operation boundary

Add a separate asynchronous ecc allocation dispatcher. Await initialization,
execution, mutations and closure before setting exit status. Preserve synchronous
ecc profile interfaces and unconfigured Codex/Claude launches.

| Operation | Effect |
| --- | --- |
| run | Claim unseen revision, choose tier/alternative, start its first bounded attempt |
| progress | CAS an explicit portable journal update; no launch or task verification |
| checkpoint | Accept immutable outcome and atomically reserve a capability successor |
| next | Claim that capability successor; no reclassification or allocation override |
| switch | Request a safe manual same-tier provider successor; no launch |
| resume | Claim a saved provider successor using the private original capsule |
| status | Inspect existing published snapshot; no creation, migration or provider call |
| recover | Reconcile completion or abandon safely; no provider call |

An admitted automatic quota transition reserves the same successor as switch and
may claim it through resume within the existing run/next/resume invocation. It
has its own durable ID and safety guards; it is never implicit command replay.

CLI flags select operation, --config where required, explicit absolute --db,
--input (bounded file/stdin), --json, and --dry-run for run only. Reject unknown,
duplicate or conflicting flags. Config is required for run/next/resume;
progress/checkpoint/switch/status/recover use pinned stored policy. No implicit
environment opt-in, DB default, home fallback or extra provider flag is accepted.
Mutations/status require DB. Dry-run may omit DB and never opens it. In-memory
stores are test-only. Outer ecc must forward caller stdin for --input -; exercise
this through ecc, not only the inner module.

Operation envelopes use ecc.allocation-<operation>.v2. Policy uses
ecc.allocation-policy.v2; no reinterpretation of proposed v1 contracts. Unknown
keys reject recursively. Input/config cap is 65,536 UTF-8 bytes; NUL and terminal
controls reject. Shared IDs match `^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$`.
Revisions are positive safe integers; ordinals/frontiers/journal versions are
nonnegative safe integers. Digests are lowercase SHA-256 hex. Timestamp means
valid UTC ISO-8601. Null is accepted only where expressly specified. Materialize
declared defaults before canonical hashing; sort unique unordered sets, preserve
tier preference/ladder order. Files use existing bounded source-reader safety.

Provider/allocation/tier record collections and expected check records are unordered
sets normalized by their IDs. Tier allocationIds, taskLadder and journal arrays
preserve order; capability/include/exclude/reference sets sort unique IDs.

| Envelope | Exact top-level fields |
| --- | --- |
| run | schemaVersion, requestId, task, requirements, repoRoot, cwd, contexts, runtimeBindings, previousClosureAcknowledgement, automaticContinuationAcknowledgement |
| progress | schemaVersion, progressId, identity, attemptId, expectedFrontier, expectedJournalVersion, journal |
| checkpoint | schemaVersion, checkpointId, identity, attemptId, expectedFrontier, supersedesCheckpointId, kind, cause, evidence |
| next | schemaVersion, requestId, identity, originalTask, attemptId, parentAttemptId, checkpointId, expectedFrontier, policyDigest, runtimeSetDigest, effectAcknowledgement, handoffSummary |
| switch | schemaVersion, switchId, identity, attemptId, sourceOperationId, expectedFrontier, expectedJournalVersion, destinationAllocationId, effectAcknowledgement |
| resume | schemaVersion, requestId, identity, attemptId, parentAttemptId, transitionId, expectedFrontier, expectedJournalVersion, policyDigest, runtimeSetDigest |
| status | schemaVersion, identity, operationId |
| recover | schemaVersion, recoveryId, identity, operationId, expectedFrontier, action, recoveryEvidence, observedCompletion |

Identity has exactly sessionId/taskId/revision/phase. Status supplies either
identity or operationId, with the other null. supersedesCheckpointId and
handoffSummary default null. observedCompletion is null except for recovery
attach-task-completion, where null may reconcile cessation of an already committed
result without adding observations. previousClosureAcknowledgement defaults null only where
the closure rule permits. automaticContinuationAcknowledgement is required but
nullable: no assertion/default is manufactured. All other fields are required
unless a domain table explicitly gives a default. This includes explicit journal
version and destinationAllocationId, which is a safe ID or null to choose the
first available eligible unvisited alternative.

task/originalTask retain existing resolver strict keys; query is required,
nonblank and at most 8,192 bytes. Shared requirements identity must match.
originalTask in next must equal the original normalized task digest, including
query/context-control fields. For continuation-enabled revisions its content
must also equal the private capsule. Resume accepts no query/model/risk override.

Repo and cwd resolve to the same canonical existing working repository root in
this slice; subdirectory execution is deferred. The controller derives registryRoot
from its executing ECC installation, not from the task workspace or a caller
override. Pin its canonical identity and compiler/registry/profile/source digests
in contextSetDigest; a trusted injected registryRoot is fixture-only. Calls to
existing resolveTaskContext use that catalog source root, while provider cwd is
the working repository. Installation/source drift rejects; no opportunistic
fallback to a different catalog. Reject changed/symlinked identities
at preflight. contexts and runtimeBindings are records keyed by every policy
provider ID, no missing/extra keys. Runtime binding has exactly runtimeDigest.
contexts entries have exactly mode/stateRoot/nativeRoot/expectedReceiptDigest
for managed mode, or mode/profileId/selectionMode/include/exclude for explicit.
Roots are absolute. Existing context validation applies separately for each
provider's target. Managed target must match the runtime; no Codex receipt may
authorize Claude context. Explicit selectionMode is manual/auto; include/exclude
are unique safe-ID arrays within existing selection limits (include at most 8,
exclude at most 32). Initial selection
may be pending; bind its final provider-specific receipt before each task launch.
expectedReceiptDigest binds the managed-store receipt, distinct from final
selection and native-generation receipts. No context is silently carried across
providers; re-resolve/revalidate the destination's pinned source.

## Policy and requirement domains

The policy has exactly schemaVersion, policyVersion, providers, allocations,
tiers, taskLadder, bands, riskMinimums, phaseMinimums, fallbackTier, classifier,
contextProposals, continuation and limits. policyVersion is a safe ID. Provider
count is 1–2 with distinct targets, allocation count 2–32, tier count 2–8. Each
tier has exactly id and allocationIds (1–2 unique IDs of distinct targets).
Each task allocation belongs to exactly one tier; allocations used only by
classifier/proposal may be outside tiers. taskLadder lists every tier once.
Ordered tier allocationIds choose initial provider preference. Every reference
must exist; capabilities and byte capacity validate per alternative.

bands has exactly routine/standard/demanding tier IDs: routine first, demanding
last, standard between them inclusively (two-tier policies may share a band).
riskMinimums has exactly low/medium/high ordered
nondecreasing tier IDs. phaseMinimums has exactly all eight phases below.
fallbackTier is last and must remain compatible. Compatibility plus capability
and submitted-byte reservation produces a nonempty contiguous suffix of tiers;
each retained tier must have at least one eligible alternative. Incompatible
alternatives are individually recorded as ineligible, never silently launched.
Availability/cooldown does not remove a tier from semantic compatibility or
permit a lower-tier substitute. Exhausted compatible alternatives pause the task.

Each allocation has exactly id, providerId, modelId, effort, descriptor,
capabilities and maxSubmittedBytes. Model string is 1–128 bytes matching
`^[A-Za-z0-9][A-Za-z0-9._:/-]*$`; descriptor is 1–512 nonsecret bytes.
Capabilities are 0–16 unique safe tags. maxSubmittedBytes is 8,192–65,536.
Effort is low/medium/high/xhigh/max/ultra for Codex, low/medium/high/max for
Claude; each runtime/model tuple requires a documented adapter mapping and
declared support. A common label is not evidence of equivalent model capability.
No unsupported effort is dropped or silently changed.

| Requirement field | Domain/default |
| --- | --- |
| sessionId/taskId/revision/phase | Required, equal task; phase explore/plan/implement/debug/review/verify/docs/maintenance |
| complexity | simple/moderate/complex/unknown; missing unknown |
| ambiguity | clear/bounded/high/unknown; missing unknown |
| riskAssessment | Optional nullable object below; absent/null/unapproved becomes high |
| requiredCapabilities | 0–16 unique tags; missing empty; union with check tags capped at 16 |
| expectedVerification | Required 1–16 unique checks; no missing-verification default |
| explicitAllocation | Optional nullable tier-member allocation ID; null/missing means no override; below-floor/incompatible rejects |

Risk has exactly level (low/medium/high), source
(user/operator-policy/agent-proposal), assessmentId and approvedBy (nullable safe
ID). Every source needs non-null approvedBy from the trusted local caller to
lower risk; null is high. Source is provenance, not authenticated human authority.
The API does not resist a hostile DB owner. Classifier cannot modify risk.
Changed assessment needs a new revision. Complexity/ambiguity meanings and
routing precedence are in the main design.

Expected check has exactly checkId, method (unit/integration/e2e/static/
human-review) and requiredCapabilities. No supplied metadata runs commands.
Classifier disabled form has exactly mode (disabled); enabled form has exactly
mode (inherited-authority), allocationId and authorityAcknowledged true.
contextProposals is keyed by every provider ID, each null when proposal cannot
occur, otherwise exactly allocationId/authorityAcknowledged true. Its allocation
must belong to that provider. If a required proposal is null, reject before calls.

Continuation has exactly enabled, automaticOnUsageLimit, maxSwitches and
cooldownMs. Booleans have no default; maxSwitches is 0–4, cooldownMs
1,000–86,400,000. automaticOnUsageLimit requires enabled, two configured targets,
maxSwitches greater than zero and the exact automatic acknowledgement below.
Disabled continuation requires automaticOnUsageLimit false and maxSwitches zero;
progress/switch/resume are unsupported and task prose remains unpersisted.
Enabling explicitly authorizes bounded private capsule/journal persistence.

limits has exactly classifierTimeoutMs (default 30000, 1000–60000),
proposalTimeoutMs (same), taskTimeoutMs (default 300000, 5000–1800000),
taskSubmittedBytes (required, 8192–65536). Missing limits rejects except those
timeout defaults. Classifier/proposal input is at most 32,768 bytes and their
allocation capacity; task input fits reservation and selected capacity. Assembly
includes capsule/handoff/query/context/wrapper, never truncates mandatory content.

## Runtime, authentication and transport binding

Each providers entry has exactly id, target (codex/claude), transport,
adapterVersion, cliVersion, executable, executableDigest, environmentMode,
declaredBackendId, knownConfigBindings, nativeBinding and authRoute.
Executable is absolute. Backend is a safe ID or null. environmentMode is
current-provider/isolated-native; neither mode prepares homes or copies credentials.

Admitted transport/adapter tuples are codex-exec/ecc.codex-allocation.v1 on
Codex 0.154.0 or 0.155.1, codex-app-server/ecc.codex-app-server-allocation.v1
on Codex 0.155.1, and claude-stream-json/ecc.claude-allocation.v1 on pinned Claude
2.1.261 in current-provider mode, or native-ready 2.1.292/later 2.1 patch in
isolated-native mode under the existing ready-receipt validator. Every exact
version still needs its transport fixtures; broad patch admission does not
certify live quota behavior. Automatic mapping admission is the fixed
Codex app-server 0.155.1 rule in the handoff contract; Codex exec and Claude
stream-json are manual-only in this slice. No config-supplied certification
flag can enable them. Version admission
is not native transport certification. No arbitrary executable
args, config overrides, --bare, paid API fallback or inherited auth-route guessing.

authRoute has exactly mode (subscription-only), method
(codex-chatgpt/claude-oauth), expectedRouteDigest, observedAt and
paidExtraUsageDisabled true. Method must
match target. A runtime-specific validated credential-route observation supplies
nonsecret digest/time; caller strings alone do not establish it. Adapter rejects
API credential/environment/endpoint routes, purchased API credits and unknown or
conflicting route evidence before every provider operation. paidExtraUsageDisabled
is an explicit operator assertion about account settings, not a conclusion from
OAuth login. Observed extra usage/overage or a contradictory/unknown billing route
blocks. The harness neither changes those account settings nor promises a hard
cash cap. No secret credential
body is read into telemetry or capsule. Revalidate the route at launch; expired
login stops for authentication, never silently logs in or changes billing.
Details and unverified adapter requirements are in the handoff document.

The route digest is canonical SHA-256 of exactly schemaVersion
(ecc.subscription-route.v1), providerId, target, method, executableDigest,
environmentMode, providerHomeDigest, knownConfigDigest, backendClass
(native-subscription) and authClass (chatgpt/claude-oauth). Home digest binds
the canonical provider-home path; config digest binds the sorted declared known
config records after their admitted normalization. Exclude timestamps, expected
digest, credential bodies and account identifiers. observedAt records the caller's
last inspection, while each launch obtains a fresh route observation. Its timestamp
does not change identity. This binds a provider-home/config/auth-class scope, not a
stable account identity: account changes inside the same home can remain unobserved.
Cooldown is therefore conservative DB/provider-route scoped, not an account-wide
quota oracle. Never imply account-change detection from this digest.

knownConfigBindings is 0–16 records of exactly path/digest/normalization. Path is
absolute; normalization is raw, codex-provider-bookkeeping-v1 or
claude-provider-bookkeeping-v1. The Claude normalization must be defined and
fixture-observed before admission; it is not assumed from Codex. Raw binds known
immutable inputs; bookkeeping exclusions remain explicitly scoped provenance.
nativeBinding is null in current-provider mode. Isolated-native has exactly
target, stateRoot, nativeRoot, revision, receiptDigest, generationId,
generationReceiptDigest, executable and executableDigest. Roots/executable are
absolute; revision positive; IDs/digests validate against ready native status.
Context roots equal generation-bound roots. Managed revision/carrierDigest match
native storeRevision/carrierDigest; distinct receipt types are not equated.
Different stores/targets/generations reject even when individually valid.
Current-provider managed context nativeRoot is null. Neither mode borrows another
provider's home or credentials; each subscription is authenticated separately.

Bind all allowed runtime/context descriptors, not only initial provider, into
runtimeSetDigest/contextSetDigest. Native task permissions/hooks/tools remain
their own provider policy; selection and handoff cannot grant authority. The
destination starts a fresh native session; do not import transcripts or resume
another provider's session ID. Requested model/effort/backend stay distinct from
nullable observed effectiveness. Child/delegated authority and accounting remain
unobserved unless separately captured.

Transport framing, known quota support and native certification are specified in
the handoff document. Preserve immutable raw-observation classifications:
normal root exit with failed/error turn or malformed framing is process/protocol
failure; missing/abnormal root exit is execution-unknown. Invalid usage alone
makes usage unknown, not execution failed. Classifier/proposal require exactly
one completed ordinary root turn, exit 0 and no error event for an ordinary
response; task may have multiple completed turns. One final exact classifier
object has tierId and reasonCode (requirements-match/conservative/uncertain).
Validate tier/floor/compatibility locally. Multiple turns/invalid final object
after ordinary exit-zero can use classifier response fallback; recorded provider
errors/nonzero exits cannot masquerade as invalid response fallback.

Advisory transport supplies transient responseFraming. An ordinary exit-zero with
no provider/error/malformed event and invalid-multiple-turns or unobserved advisory
turn count yields classifier invalid-response fallback; proposal rejects. For Claude,
num_turns must equal one for a valid advisory final response. This field is never
persisted as usage or promoted to task verification.

A confirmed typed usage-limit result is a separate category, not ordinary
completion or malformed-response fallback. Classifier quota may establish the
conservative fallbackTier and then perform a guarded provider switch, counting
toward maxSwitches; no second classifier call. Proposal quota can switch within
the accepted tier, but destination context/proposal must resolve anew. Neither
path may launch a task without quota/safety/capsule/availability guards.

## Canonical ownership and revision closure

Bind normalized task/query/requirements digests, identity, canonical repo/cwd,
bounded policy snapshot/digest, all context/runtime descriptors and final
per-attempt selected-context receipt. Keep policy snapshot for replay; digest
alone cannot reconstruct edited tiers. Continuation-disabled persists no query;
enabled stores only the separate private capsule described below.

Changed query (including rewording), phase, risk/requirements, repo/scope,
policy, allowed runtimes/contexts or authentication route needs a higher revision.
Normal journal updates record progress within those requirements; they cannot
authorize changed task scope. Current frontier must be terminal or safely
abandoned before a new revision. One active/uncertain frontier spans revisions.

If any previous root operation started or remains uncertain, run supplies
previousClosureAcknowledgement with exactly revision, expectedFrontier and
effectAcknowledgement. It names latest closed revision/frontier; stale values
reject atomically. Null is allowed only for the first revision or predecessor
with proven no root invocation. Recover uncertain work before closure; terminal
asserted-success/exhausted alone does not establish cessation. Record closure
safety separately from outcome.

Create controller session adapter ecc-allocation.v2, harness ecc-allocation,
canonical repo and minimal snapshot, or verify identical ownership. Individual
operation target is Codex/Claude. Refuse conflicting ordinary sessions; migration
preserves their harness/schema values and never overwrites their snapshots.

## Idempotency, progress and successor reservations

Caller request/progress/checkpoint/switch/recovery IDs are globally unique in DB;
controller operation/transition IDs are likewise globally unique. Store scope and
canonical payload digest. Same ID/payload returns original receipt/status after
frontier changes; different payload/scope is ECC_ALLOCATION_CONFLICT. Replay
never calls providers, even if incomplete; report busy/recovery. New requestId
cannot repeat a bound revision or relaunch an attempt.

Initial run claims revision/capsule/first attempt atomically before classifier.
Every progress mutation checks attempt, frontier and journalVersion together.
It is allowed while active or awaiting-checkpoint/verification, and before
reserving a successor; never while recovery-required, terminal or another
successor owns the frontier. Active progress does not advance frontier, but does
increment journalVersion and stores a complete journal replacement, not a merge.
It records caller assertions, not model completion. Explicit CAS conflicts reject.

Capability checkpoint plus successor creation and frontier advance are one
transaction. Next consumes the saved next-tier allocation, pinned bindings and
checkpoint. Provider availability chooses an eligible alternative in that next
tier, never moves another tier or reroutes the original task. Every entered tier
has its own visited-alternative set; global successful provider-switch count does
not reset on escalation. Capability escalation itself is not a quota switch.

Manual/automatic provider transitions reserve a distinct same-tier successor
with transitionId, parent attempt, source operation, reason (manual/usage-limit),
destination allocation, capsule/workspace digests and journalVersion. Reservation
increments frontier and switch count, marks destination visited immediately and
prevents duplicate claims. No unvisited alternative or remaining switch budget
means provider-paused, not capability escalation or restart. A failed reserved
successor remains visited; crash cannot reset budget. Only one successor of any
kind may own a frontier. Reservation is not execution; claim once through resume.
No transparent same-allocation retry exists within a revision.

## Portable capsule and workspace observation

With continuation enabled, claimInitial privately stores original normalized
task (including query), requirements, policy/context/runtime digests and initial
empty journal. Capsule contains exactly schemaVersion (ecc.task-capsule.v1),
identity, originalTask, requirementsDigest, policyDigest, contextSetDigest,
runtimeSetDigest, journalVersion, journal and workspaceManifestDigest (nullable
until a safe boundary capture). Total originalTask query cap is 8,192 bytes;
journal serialized cap is 32,768. Capsule whole serialized cap is 49,152.
The outer 65,536-byte operation input and launch reservation still apply.

Journal has exactly plan, decisions, completed and pending arrays, each 0–24
nonblank strings of at most 1,024 bytes, with combined UTF-8 serialized cap
32,768. These are visible work notes, not chain of thought. No native transcript,
hidden reasoning, source-file body, selected-skill body, credentials or credentialed
URL may be intentionally included. Unknown/control-bearing content rejects;
secret detection is best effort, so trusted caller must submit nonsecret notes.
Each update is an immutable version bound to identity/attempt and digest.
A worker may request progress updates, but this API does not make prompt advice
an enforced journal hook. Controller integration must actually submit them.
No update means empty/outdated notes; successor must inspect workspace and
verify claimed completed work before trusting it.

Capsule/journal is explicitly sensitive task prose. It is private state, omitted
from status/event/result/error output. Store digest and IDs in public events,
content only in the private capsule entity. DB/directory permissions are owner-only
(or verified platform-equivalent ACL); refuse insecure/shared/symlinked paths.
This implementation admits POSIX owner/mode verification only. Windows allocation
stores fail closed until an equivalent ACL adapter exists; ordinary ECC stores
retain their existing behavior. Windows parsing/policy tests alone do not certify
Windows private persistence.
Snapshot publication and capsule/event version are atomic. No remote sync, provider
credential copying, encryption claim or automatic purge is implied. Bounded
capsule retention/deletion is an explicit later operator action; disabled
continuation cannot secretly persist prose.

At a known safe root boundary capture a manifest with exactly schemaVersion
(ecc.workspace-manifest.v1), repoIdentityDigest, head (nullable commit ID),
indexDigest (nullable only when the Git index does not yet exist),
entries, exclusionSetDigest, excludedScope and digest. excludedScope is a unique
array of compiled safe exclusion IDs, not caller-controlled paths;
exclusionSetDigest binds that fixed set. Entire serialized manifest is capped at
2 MiB. Entries are sorted unique records of exactly path, kind
(file/deleted), digest (null only for deleted), bytes (null only for deleted) and
tracking (tracked/untracked). Paths are normalized repository-relative, at most
1,024 bytes, no traversal/control components. Enumerate tracked plus nonignored
untracked regular files under bounded source-reader checks: 10,000 paths,
128 MiB aggregate bytes hashed and 16 MiB per file. Reject symlinks, .git/private
controller/provider-home files and unsafe ancestors. Never copy bodies into DB.
An allowlisted immutable exclusion set binds known build/dependency/ignored paths;
its compiled IDs are git-metadata, dependency-output, build-output, test-cache,
private-harness and git-ignored. They exclude path components .git, node_modules,
.venv, venv, dist, build, __pycache__, .pytest_cache, .cache and coverage; private
harness paths are .ecc-allocation and .ecc-state. Git supplies ignored scope.
Only this fixed set is accepted, with no arbitrary exclusion paths. The controller
DB and actual provider homes must be outside the working repository in this slice,
so publication and credentials cannot enter the captured workspace. A repository's
tracked .codex/.claude project configuration is not automatically a provider home.
report excluded scope, not whole-filesystem integrity. These limits admit the
empirically inspected ECC baseline (4,553 tracked paths, 61,103,109 bytes, largest
file 5,690,873 bytes); they are prototype limits, not universal repository support.
Overflow pauses automatic
handoff; no partial manifest is advertised as complete.

Git index/head and files must remain stable across capture/revalidation, with
before/after file/ancestor identity checks. This is a bounded consistency check,
not an atomic filesystem snapshot or proof against hostile concurrent writers.
Persist safe-boundary manifest atomically with transition; recheck it immediately
before successor spawn. Worker edits during its turn are expected: capture the
resulting workspace after cessation, rather than demand equality to initial code.
Unexpected drift between capture/resume rejects; recover/close/new revision,
never silently rewrite the saved manifest. Manual switch still needs safe capture
and a usable capsule. No automatic rollback, stash, Git reset, commit or lock on
arbitrary external editors is introduced.

## Task lifecycle and switching guards

A transition stores the accepted capsule version/digest and safe manifest separately
in one transaction. It never overwrites that immutable capsule version to attach a
new manifest. Continuation input may assemble a transient copy carrying the separately
validated manifest digest; this copy is not a newly persisted journal version.

Projection states are deciding, active, awaiting-checkpoint, awaiting-verification,
blocked, provider-paused, successor-reserved, recovery-required, asserted-success,
exhausted and abandoned. Last three are terminal. Events append; only guarded
projections mutate. Outcome success remains caller-asserted.

| Trigger | Transition/effect |
| --- | --- |
| Valid initial run | Claim deciding and first attempt; no second initial route |
| Completed invalid classifier response or proven no-spawn classifier failure | Record; remain deciding; eligible conservative fallback |
| Other classifier/proposal failure | Block before task; no response fallback/retry |
| Task launch intent committed | Active; exclusive controller owner |
| Ordinary task exit-zero and valid completion | Awaiting-checkpoint; unverified |
| Unverified completion checkpoint | Awaiting-verification; no successor |
| Complete expected-check success assertion | Asserted-success |
| Capability failure/ambiguity/stall | Reserve next tier or exhausted at last |
| Environment/requirements/unknown cause | Blocked; no escalation |
| Known no-spawn/completed process failure | Blocked; process-failure checkpoint allowed |
| Confirmed quota + all automatic guards | Reserve bounded same-tier provider successor; resume may launch |
| Confirmed quota without safe/available destination | Provider-paused; preserve capsule; no launch |
| Safe manual switch | Reserve same-tier provider successor; resume separately |
| Uncertain execution/result recording | Recovery-required; block all providers |
| Valid recovery | Append reconciliation and await checkpoint, or abandon; no launch |

Automatic acknowledgement has exactly assertedBy, timestamp,
workspaceSynchronousOnly true, noDetachedOrExternalEffects true and policyScopeId
(safe ID equal pinned policyVersion). It is a trusted caller declaration that
this workload uses synchronous local work without detached descendants or external
effects. It is not a process-tree/remote-effect proof, inherited permission
override or default. Unsupported workloads must use manual acknowledgement and
reconciliation. Enabled automatic policy alone supplies no safety assertion.

An automatic transition requires all of: configured consent and remaining budget;
admitted typed subscription usage-limit signal attributed to current provider/
root operation; normal observed root termination with actual exit status zero;
no pending/unknown tool
observations; unchanged accepted tier (classifier exception establishes
fallbackTier first); intact bound runtimes/context/auth; latest usable capsule and
safe workspace manifest; matching automatic acknowledgement; eligible unvisited
destination outside its holdoff. A tool start without terminal observation, broken
framing, descendant/external-effect uncertainty or abrupt termination blocks
automatic switching. Root process exit alone is insufficient. Event-level
quiescence plus trusted workload assertion is the scoped safety model, not
universal exactly-once proof. Never guess quota from prose, HTTP 429 or generic
rate_limit/api_retry; unsupported mappings require manual/recovery.

Manual switch requires enabled continuation, completed/proven-not-started source
operation, known ceased relevant work with effect acknowledgement, intact capsule/
bindings/manifest, remaining budget and eligible unvisited other-target
alternative in accepted tier. It can switch after ordinary task completion,
blocked process failure or pre-task quota; cannot reinterpret terminal success/
exhaustion, accepted capability successor or uncertain effects. A manual switch
while active must stop/reconcile first; switch itself does not kill a worker.
Source routing/proposal may be named only after accepted tier is established.
Manual destination cannot override a tier, floor or compatibility.

Provider availability is DB-scoped per provider ID with runtime/auth binding,
recorded observation time, reason (confirmed-usage-limit/local-holdoff),
resetAt (nullable trusted native timestamp), and holdoffUntil. On confirmed limit,
holdoffUntil is at least observedAt + cooldownMs; trusted later reset can extend
it. Invalid/untrusted reset remains null. Clock rollback cannot shorten persisted
holdoff. Expiry means eligible to try once on a future explicit task/revision,
not renewed subscription certainty. Same-tier visited alternatives remain visited
after expiry; no ping-pong or hidden repeated probe. If both unavailable, task
stays provider-paused with reset/holdoff observations. Status is passive; no
availability polling/provider probe is implied. Another DB has no shared limit
oracle; same configured runtime does not prove account-wide coverage.

Checkpoint kinds: verified-success, verification-failure, unresolved-ambiguity,
stalled, process-failure and unverified-completion. Causes: capability/environment/
requirements/unknown/none. Failure/ambiguity/stall require non-none; only capability
escalates. Success/unverified/process-failure use none. Quota is an operation
availability classification, never a capability checkpoint or model-quality fact.
A stall cannot checkpoint active/uncertain work.

Substantive success/capability outcome is final for that attempt. Unverified
completion and external blockers are provisional; replacement checkpoint names
exact prior ID/current frontier. Wrong-scope/active/unlaunched/uncertain/terminal
events reject; process-failure alone may attach to proven not-started task root.
Routing/proposal roots never receive task checkpoints. Reserved successor prevents
late evidence from changing its accepted cause.

## Root operation lifecycle and recovery

Every classifier/proposal/task root has operation ID, phase, allocation/tier,
provider, runtime binding, owner and intent. Operations are sequential within the
frontier. States are reserved, launch-initiated, completed, not-started and
execution-unknown. Reserve then CAS owner/frontier and commit launch-initiated
before invoking outside transaction. A crash marker may mean no spawn, live work,
completion or partial effects; exactly-once subprocess/remote effects are not
promised. Old owner must be unable to initiate before reserved work is abandoned.

Typed result has exactly spawnState (not-started/started/unknown), exitStatus
(null/nonnegative safe integer), signal (null/safe signal ID), category
(none/spawn-error/auth-error/model-unavailable/provider-error/protocol-error/
usage-limit/timeout/output-limit/cancelled/controller-lost), rootCompletion
(observed/unknown), cessation (root-only/caller-reconciled/scoped-automatic/
unknown), observationOrigin (controller-observed/recovery-asserted), nativeErrorCode
(null/safe ID), quotaObservation (null/object below), and toolQuiescence
(observed-clear/pending/unknown/not-supported). Actual exit stays actual; no
null-to-1 flattening or fabricated normal completion.

quotaObservation has exactly source (typed-native), providerId, signalId,
scope (subscription/five-hour/seven-day), observedAt, resetAt (nullable timestamp)
and mappingVersion (safe ID). Only the fixed admitted adapter mapping produces
it; its mappingVersion is codex-app-server-0.155.1-usage-limit-v1. A generic
transport rate limit has no quotaObservation and category provider-error.
An observed-clear tool projection is separate from scoped cessation consent.

Timeout/overflow/cancel/crash/missing result retains execution-unknown and blocks
every next provider operation, including after classifier. Bounded direct-child
cancellation is not portable process-tree cleanup. Normal root exit proves root
completion only. Manual next/switch and new revisions need cessation/effect
acknowledgement; automatic uses only the narrower guards above.

Recovery actions are attach-task-completion or abandon. recoveryEvidence has
exactly assertedBy, timestamp, oldOwnerCannotLaunch true, relevantWorkStopped
true, effectsDisposition (none/retained/reconciled), references (0–16 safe IDs)
and summary (null/at most 4,096 nonpersistent bytes). No boolean default; PID
absence/lease expiry cannot supply assertions. Stop old live owners first.

Attach-task-completion only names task root. observedCompletion uses typed result
with recovery-asserted/caller-reconciled. A null observedCompletion is permitted
only when that named task operation already has a committed result; the recovery
records cessation/effect assertions separately and retains every original fact,
including a controller-observed quota. It cannot authorize an automatic transition.
Append provenance; never overwrite
committed exit/signal/category/quota or invent missing observed values. Existing
abnormal result can receive cessation reconciliation but remains abnormal, allowing
process-failure checkpoint or abandonment. Lost ordinary result may be caller
assertion, never controller-observed/certified quota. Conflicting non-null
observations reject. Only started/exit 0/no signal/category none/root observed can
restore awaiting-checkpoint. Other completion permits process-failure/abandon.
Uncertain classifier/proposal or unlaunched successor safely abandons, not resumes.
Recovery never emits automatic quota permission, invokes providers or undoes effects.

For abandon only, operationId may be null to close a safely unlaunched or paused
frontier without a source operation. The same explicit recovery assertions and CAS
apply; any live/uncertain root must first be reconciled by its actual operation ID.
An initial no-available-provider claim persists provider-paused with a null allocation
and usable capsule. It cannot manufacture a provider successor; safe closure and a
new revision are required when no saved successor exists.

A mutation exception may follow successful snapshot publication/lock-release
failure; it does not prove no commit. Lookup ID/frontier before identical replay.
Post-execution record failure returns ran-recording-incomplete, operationId and
typed observation. Durable intent remains discoverable; unavailable DB cannot
guarantee another durable failure marker. No fallback DB, task replay or ordinary
checkpoint before reconciliation. Leases never steal locks. Preserve STATE_STORE_BUSY:
stop all DB users, inspect leftover lock and follow existing explicit procedure;
no force-unlock or PID-only deletion.

## Verification, effects and successor input

Evidence has exactly assertionOrigin (human/agent/external-runner), assertedBy,
timestamp, artifactDigest, workspaceBinding, checks and references. Checks have
exactly checkId/method/result (pass/fail/unavailable)/evidenceDigest/referenceId;
digest/reference nullable, at least one present. Arrays cap 16. Opaque references
are safe IDs, never paths/URLs/commands; no fetching. workspaceBinding has exactly
head (nullable Git commit ID), artifactDigest and source (caller-asserted).
Correspondence does not independently certify workspace or checks.

All expected checks need asserted pass/matching methods for verified-success.
Missing/unavailable/failing checks cannot yield success. Even external-runner
origin is caller-asserted until separate trusted preregistered grading. Never
merge trust populations. Journal completed notes are not verification evidence.

effectAcknowledgement has exactly assertedBy, timestamp, relevantWorkStopped
true, effectsDisposition (none/retained/reconciled) and references (0–16 IDs).
It asserts cessation/effect disposition, not rollback/idempotency proof.
Next handoffSummary is null or at most 4,096 bytes; total compact checkpoint
handoff cap 8,192. It is not persisted unless explicitly submitted as a bounded
journal item with enabled continuation. Changed requirements/artifacts outside
task binding need closure/new revision, not retroactive evidence.

Successor input contains original query, admitted destination ECC context,
portable original bindings/public journal, parent allocation/attempt/outcome,
verification IDs and workspace/artifact digests. Treat notes/evidence as untrusted
reference data; never execute their paths/commands or grant authority. Capacity
includes whole assembled input. Reinspect retained edits and rerun relevant
verification before continuing; no hidden reasoning/native transcript is migrated.

## Dedicated SQLite operations

Add validated entities for allocationPolicies, allocationRevisions,
allocationAttempts, allocationOperations, allocationCheckpoints,
allocationRecoveries, allocationTransitions, allocationAvailability,
allocationCapsules, allocationProgress, allocationWorkspaceManifests and guarded
frontiers. Extend schema/migrations/normalizers/mappings together; preserve
ordinary sessions/skills/decisions. Generic insertDecision drops extra fields and
upserts history; do not use it for controller events or capsules.

Enforce parent scope, unique attempt ordinal/successor/global idempotency identity,
one active frontier, tier-specific visited alternatives and global switch budget.
Final context receipt binds task operation. Events reject conflicting duplicate IDs;
only guarded projections mutate. Capsule/progress privacy applies to snapshots
and export paths as well as events.

Atomic methods: claimInitial, acceptRoute, reserveOperation, claimOperationLaunch,
finishRequest,
recordOperationCompletion,
recordProgress, acceptCheckpointAndReserveSuccessor, reserveProviderSwitch,
claimNext, claimResume, recordProviderAvailability and reconcileOperation.
Quota result, availability update and automatic successor reservation are one
transition transaction; never leave a successor claim based on uncommitted
quota/capsule state. Each method owns one short synchronous transaction checking
frontier/journal version within it. acceptRoute binds the immutable tier/initial
alternative once a validated route is available; it checks pinned policy/floors
and completed classifier result or deterministic rule, never an arbitrary override.
It rechecks the selected alternative's capabilities, byte reservation and matching
runtime/auth-scoped holdoff inside that same transaction. Tier membership alone is
insufficient, including after valid classifier selection or conservative fallback.
Deterministic routing may bind during claimInitial; pending classifier route has
null tier until acceptRoute. reserveOperation commits a later proposal/task intent
after allocation/context receipt is known, checking owner, exclusive frontier,
phase sequentiality and global IDs before claimOperationLaunch. Neither method
invokes a provider. No split read/write CAS, nested transaction,
await in callback or assumed statement.run changes count. Provider calls,
filesystem hashing and long work remain outside lock; revalidate inputs at claim.

Preserve sql.js lock/reload/commit/export/atomic-publication order; export follows
commit. Status needs validated read-only opener, not migrating createStateStore.
Dry-run branches before openers/dirs/locks/provider/auth/prompt/capsule writes;
selection uses load false. Registry hashing may read bodies for provenance but
does not emit/load selected bodies as model input.

Policy snapshot cap 65,536; event cap 16,384. Public records omit prose, raw output,
credentials and credentialed URIs. Capsule is sole explicit prose persistence
exception. Stable reason codes, safe IDs, digests and typed observations only.
Escape display controls; reject stored controls. Digests are integrity, not
signatures, encryption or authentication. Use nonsecret IDs/descriptors.

No automatic audit deletion. Refuse new execution before exceeding 100,000
controller events or 64 MiB published DB; status/recovery remain available.
Prototype bounds are not measured performance. An oversized shared DB needs an
explicit dedicated DB, never old-data deletion. Recovery may append bounded
closure records past execution limit. Capsule/workspace overflow stops execution,
never truncates journal/task/manifest. Retention/load benchmarking is later work.

## Accounting, responses and errors

Record every invoked root, including failed classifier/proposal and both providers,
with requested allocation/model/effort/runtime and nullable effective observations.
A checkpoint/progress/recovery is not an inference call. Proven no-spawn is zero
root invocations; never invent billed usage. Quota transition itself is not a call,
while actual destination proposal/task roots are separately attributable.

Nullable safe counts: input/cached-input/output/reasoning, duration and costMicros.
Cached input cannot exceed input; don't double-count reasoning included in output.
Cash/subscription and API-equivalent estimates are separate series. A subscription
quota event is availability evidence, not token balance or per-task cash price.
Counts/cost remain unknown without attributable native observation.

Result has exactly schemaVersion (ecc.allocation-result.v2), success, operation,
status, code, replayed, identity, requestId, progressId, checkpointId, switchId,
recoveryId, transitionId, operationId, attemptId, frontier, journalVersion,
taskState, route, execution, operations, availability, accounting and nextActions.
IDs/identity/frontier/journalVersion/taskState are null until applicable/observed.
Success is operation success, never task verification. operation is one public
operation, or null only for input rejection before an operation is recognized;
status is proposed/read/recorded/rejected/ran-recording-incomplete.
Preview has no claim/frontier/execution/operations/capsule content.

route has exactly source (explicit/deterministic/classifier/fallback/persisted/
provider-switch or null), reasonCode, classifierReasonCode, tierId, allocationId,
eligibleTierIds, eligibleAllocationIds, classifierStatus, policyDigest and
runtimeSetDigest. Eligible arrays are ordered unique tier/task IDs within declared
caps; selected IDs null only before selection. classifierStatus is
not-needed/disabled/would-call/completed/failed/quota-limited. reasonCode is
explicit-choice/routine-band/standard-band/demanding-band/sole-eligible/
classifier-selection/classifier-disabled/classifier-invalid/classifier-no-spawn/
classifier-quota/saved-successor/manual-switch/usage-limit-switch, or null.
classifierReasonCode is null/requirements-match/conservative/uncertain. A would-call
preview reports eligible IDs without fabricated classifier selection.

operations is 0–64 ordered summaries for revision or named operation. Each has
exactly operationId, attemptId, phase (classifier/proposal/task), providerId,
tierId (nullable only pre-route), allocationId, state, result, requested, observed
and metrics. requested has exactly modelId/effort/runtimeDigest. observed has
exactly backendId/modelId/effort/nativeContextTokens/childUsageTokens (nullable)
and source (provider-observed/caller-asserted/unavailable). State/result use
lifecycle/typed schemas; source label cannot turn missing values into facts.
availability is 0–2 records with exactly providerId/runtimeDigest/reason/
observedAt/resetAt/holdoffUntil; unknown availability is absence, not balance zero.

Metric records have exactly name (inputTokens/cachedInputTokens/outputTokens/
reasoningTokens/durationMs/costMicros), value (nullable safe count), scope (root),
series (observed/cash/API-equivalent), currency (null/ISO code), source
(provider-observed/controller-observed/API-equivalent-estimated/unavailable),
pricing (null/object sourceId/version/timestamp/rounding). Price source/version
are safe IDs; rounding nearest-micro-half-up. Non-null cost requires currency;
unavailable null cost may retain null currency. Estimated
API-equivalent cost requires pricing provenance. Subscription cash not attributable
to request remains null. Durations use monotonic clock; stored timestamps UTC.

Accounting has exactly name, scope (root/whole-task/verification/human/recovery),
series, currency, observedOperations, missingOperations, knownSubtotal,
completeTotal and completeness (complete/known-subtotal/unavailable). Counts and
totals are nullable safe nonnegative integers. No observations means null subtotal/
total, unavailable; unknown population is null count, never zero. Missing
constituents mean null completeTotal. Root counts include started/uncertain
operations, exclude proven not-started. Unknown child/tool population makes
whole-task completeness unavailable even with complete roots. Timing constituents
are not inference calls. Include failures, switches, pauses and abandonment in
economic populations; a partial provider total cannot claim whole-task savings.

nextActions is a unique subset of progress/checkpoint/next/switch/resume/recover/
abandon/new-revision/inspect/authenticate/wait; no action executes automatically
because it is listed. Status valid read has success true even when task blocked.

| Exit | Meaning |
| --- | --- |
| 0 | Valid proposed/read/completed operation or saved successful replay |
| 1 | Observed provider failure, blocker/exhaustion or failed checkpoint |
| 2 | Input/config/capability/binding/auth-route validation or unsupported operation |
| 3 | Conflict/stale frontier/journal version/active owner busy |
| 4 | Persistence/integrity/recovery required, including ran-recording-incomplete |

Stable ECC_ALLOCATION_ codes are OK, PROPOSED, INVALID_INPUT, INVALID_CONFIG,
INCOMPATIBLE, BINDING_CHANGED, AUTH_ROUTE_UNVERIFIED, SUBSCRIPTION_REQUIRED,
AUTOMATIC_UNSUPPORTED, CONFLICT, BUSY, PROCESS_FAILED, BLOCKED, PROVIDER_PAUSED,
SWITCH_BUDGET_EXHAUSTED, CAPSULE_UNAVAILABLE, WORKSPACE_CHANGED, EXHAUSTED,
PERSISTENCE_FAILED, RECOVERY_REQUIRED and STORAGE_CAPACITY. STATE_STORE_BUSY
remains busy cause. Valid status read returns 0 for paused/recovery snapshots;
mutations use table. Saved replay retains original outcome code.

## Acceptance matrix

| Boundary | Required cases |
| --- | --- |
| Routing/policy | Complete domains/defaults/floors; tier preference; classifier tier IDs; individually incompatible alternatives; contiguous compatible suffix; no availability downgrade |
| Auth/runtime/context | Both targets; exact CLI/adapter admission; route guard rejects API/unknown; all-runtime pinning; source/native drift; destination projection; no credential borrowing |
| Transport | Actual typed quota versus prose/429/retry; malformed events; event quiescence; ordinary/abnormal exit; input/output bounds; requested/effective separation |
| Preview/legacy | No DB/capsule/auth writes/provider call/selected-body load; stdin forwarding; unconfigured profile/Codex/Claude preservation |
| CAS/replay | Global identical/conflicting IDs; active journal version races; independent handles/processes; one successor; finite visited set; global switch budget |
| Handoff | Manual both directions; confirmed quota auto for admitted Codex app-server mapping; unsupported Claude/exec auto; classifier/proposal quota; fresh session; same tier; destination context; original-query/capsule digest; retained work reinspection |
| Availability | Both exhausted; nullable reset; clock rollback/cooldown; expiry not balance; no silent probes/ping-pong/escalation/API fallback |
| Workspace/privacy | Tracked/untracked edits; deletion; symlink/private/ignored scope; byte/path overflow; between-capture drift; atomic private journal and omitted public prose |
| Recovery | Crash at reserve/spawn/result/capsule/transition/claim/publication; pending tools/descendants; lost response; immutable abnormal observations; no recover launch |
| Evidence/economics | Expected checks and trust separation; journal not verification; both-provider root accounting; missing constituents and pricing provenance; quality before cost |
| Store/integration | Additive multi-harness migration; reopen/rollback/private permissions/capacity; dispatcher end-to-end; no use of generic decision upsert |

Behavioral contract only: exercise actual fixture APIs, filenames, commands and
environment gates before writing implementation test code or claiming runtime
certification. Neither native quota behavior nor seamless handoff is certified
by this document.
