# Adversarial review of the System 1 allocation controller

Review date: 2026-10-11. Verdict: **revise the contract before implementation**.

The proposed explicit-launch integration is a reasonable first boundary. The draft
does not yet specify enough behavior for independent implementers and reviewers to
agree on a correct controller. Its most serious omissions concern allocation rules,
identity binding, attempt lifecycle, crash recovery, and classifier authority.

This report contains **27 consolidated findings: 9 implementation blockers and 18
important gaps**, followed by an adversarial acceptance matrix and a revision order.
These are design findings; they are not claims that an unimplemented controller has
already exhibited the hypothetical failures below. Concrete existing-code behavior
and executed probes are identified separately.

## Review scope and evidence

The reviewed contract is [system-1-controller.md](system-1-controller.md), lines
1–99. The companion [gate profile](../workflows/two-agent-swe-workflow.md), upstream
context contracts, JavaScript launcher, command interface, state store, native
configuration, and existing AI evaluator were also examined.

The source checkout is at commit `2d515e4fc2ddef97354769812cf3f7b9ec4e5124`.
The reviewed files are uncommitted drafts. Their SHA-256 digests are:

| Artifact | SHA-256 |
| --- | --- |
| Design | `63f2042f7772d4e969baef38108737fc36a0d86c66a5bbfd3c70bdac6314db76` |
| Gate profile | `23a7f31d8a470f8165948dfe4ff7ceb8ec720b191962e9e159607cd7f9dbdf88` |

The review used independent allocation and execution reviewers, a persistence
reviewer's interim evidence, and controller verification of the cited source.
The persistence reviewer could not complete its final pass because of a usage limit;
its supplied findings were checked directly before inclusion. The structural lenses
from the gstack review checklist informed the review. Its PR auto-fix flow was not
used because the requested deliverable is a report.

No design, implementation, provider configuration, or dependencies were changed.
No live inference, paid provider calls, broad repository suite, or benchmark ran.
Only this report and its appendix were added.

Observed checks during this review:

| Check | Observation and limit |
| --- | --- |
| Personal-path validator | Exit 1; exactly three errors in the gate profile. No dependencies required. |
| Local `codex exec --help` | Model, TOML config, sandbox, ephemeral, output-schema and JSONL flags exist. Help inspection does not certify live provider behavior. |
| Benign Node subprocess probe | Direct child returned `SIGKILL`/`ETIMEDOUT`; its descendant was still alive and was immediately killed by the probe. This was observed on the local runtime, not all OSes. |
| Small state-store loading probe | Current checkout cannot load `sql.js`: `MODULE_NOT_FOUND`. No installation was attempted. Store findings therefore use source evidence. |
| Existing focused baselines | The draft reports prior-checkout test success. Those tests predate the controller and were not rerun or promoted to controller certification. |

Severity means:

- **P1:** Decide and write this contract before dispatching an implementer. Correctness,
  safe execution, or reviewability otherwise depends on an undocumented choice.
- **P2:** A material operational, integration, or measurement gap. Resolve it in the
  first-slice contract or explicitly constrain/defer it with truthful acceptance
  criteria. A later economic experiment need not be implemented in this slice.
- **P3:** Useful follow-up work that can remain outside the first slice.

All numbered findings have high confidence in the identified omission or source
behavior. That confidence does not imply a hypothetical failure has already occurred.

## Findings at a glance

| ID | Priority | Gap | Required boundary |
| --- | --- | --- | --- |
| F01 | P1 | Routing inputs and policy have no operational definition | Requirement schema and complete policy |
| F02 | P1 | Ladder, floors, and fallback can conflict | Cross-field configuration invariants |
| F03 | P1 | Requirements can describe a different task | Canonical launch fingerprint |
| F04 | P1 | Fresh retries can reset escalation | Distinct initial and successor operations |
| F05 | P1 | Duplicate/concurrent checkpoints lack semantics | Atomic attempt state machine |
| F06 | P1 | Crash windows leave execution unknowable | Durable intent and explicit recovery |
| F07 | P1 | Classifier authority remains unresolved | Operational classifier trust boundary |
| F08 | P1 | CLI termination does not stop all work | Cleanup or termination-unconfirmed state |
| F09 | P1 | No public controller/DB interface is specified | Reachable API and pure dry-run boundary |
| F10 | P2 | Requested allocation is not effective backend identity | Requested/observed execution provenance |
| F11 | P2 | Root allocation excludes independently configured child work | Honest allocation and accounting scope |
| F12 | P2 | Classifier protocol, limits, and option meanings are incomplete | Bounded typed transport and descriptors |
| F13 | P2 | Classifier is outside the defined preflight sequence | Shared integrity checks and failure taxonomy |
| F14 | P2 | Existing timeout/result flattening defeats diagnosis | Typed termination and allocation deadlines |
| F15 | P2 | Success evidence is not tied to expected verification | Evidence schema, artifact binding, trust label |
| F16 | P2 | Every verification failure/stall implies more reasoning | External-blocker semantics |
| F17 | P2 | Fresh attempts lack a handoff and side-effect contract | Bounded evidence and workspace continuity |
| F18 | P2 | Risk assessments have no authority or revision rules | Trusted assessment source and change protocol |
| F19 | P2 | Model compatibility covers effort but not task/context needs | Capability and context feasibility checks |
| F20 | P2 | Existing store APIs do not provide an allocation event model | Dedicated validated atomic query operations |
| F21 | P2 | Telemetry failure has no reconciliation interface | Recoverable incomplete-record state |
| F22 | P2 | Economic objective can reward low completion quality | Quality constraint and objective priority |
| F23 | P2 | Nullable metrics lack operation-level completeness | Complete totals versus known subtotals |
| F24 | P2 | Existing evaluator discards routed model/effort | Per-operation allocation measurement |
| F25 | P2 | Paired evaluation is insufficiently specified | Preregistered comparable task outcomes |
| F26 | P2 | Gate profile fails a validator and omits coverage gate | Executable project gates |
| F27 | P2 | Free-text telemetry and evidence references lack handling rules | Bounded private data and untrusted display |

## Implementation blockers

### F01 — There is no executable definition of allocation policy

**Contract:** design lines 42–50 and 80–83.
**Evidence:** [context-selection.js](../../scripts/lib/context-selection.js), lines
12–49 and 51–73, defines strict inputs and concrete context-routing thresholds;
none of those thresholds determine model allocation.

The draft names complexity, ambiguity, risk, phase, and expected verification but
defines neither their domains nor how they affect a route. “Clear cases” and
“classification needed” cannot be tested without inventing requirements. Missing,
unknown, malformed, and contradictory values also need distinct treatment.

**Adversarial case:** implementation A routes every task to the highest allocation
without calling System 1. Implementation B routes every explicitly low-risk task
to the lowest allocation. Both can satisfy the listed acceptance checks. Neither
has to adapt to complexity, phase, ambiguity, or verification requirements.

**Minimum revision:** choose a complete deterministic decision table or a bounded,
operator-configured rule format. Define matching, precedence, default rules,
classifier triggers, floor enforcement, and rejection versus promotion of a low
explicit request. Specify input types, enum values, unknown-field behavior, byte
limits, and canonicalization. At least one easy and one demanding fixture must
reach different allocations without classifier calls. When only one eligible
allocation remains, define whether classification is useful enough to invoke.

### F02 — Configuration has conflicting sources of escalation order

**Contract:** design lines 32–36, 44–50, and 62.
**Evidence:** [context-profile-launch.js](../../scripts/lib/context-profile-launch.js),
lines 20–23, supplies no existing allocation ordering to resolve this ambiguity.

Each allocation has an escalation order while configuration also has an ordered
ladder. The authoritative representation, membership rules, uniqueness, and floor
comparison are unspecified. The design correctly says order is operator policy;
it therefore cannot silently infer a capability ordering from model names.

**Adversarial cases:** an explicit task allocation exists outside the ladder; a
ladder repeats an ID; an allocation's rank conflicts with its ladder position;
the fallback is below the high-risk floor; a floor references an unknown ID; the
System 1 allocation is accidentally treated as a valid task successor.

**Minimum revision:** select one authoritative order. Define classifier-only and
task-eligible allocations, unique IDs/ranks, all cross-references, effort domains,
and fallback eligibility for every supported risk. Require all initial routes and
successors to respect the same floor. Validate the entire configuration before
any provider invocation, including a classifier. State whether a floor is an
ordinal policy restriction or an explicit set of eligible allocations.

### F03 — Requirements are not bound to the task that receives the allocation

**Contract:** design lines 42–44, 68–70, and 85.
**Evidence:** [context-selection.js](../../scripts/lib/context-selection.js), lines
217–220, binds context selection to session/task/revision/phase, query digest,
profile plan, routing-policy version, and triggers. The upstream
[delivery contract](context-profile-delivery.md), lines 43 and 57, invalidates reuse
when the query changes.

The new requirements duplicate identity/revision/phase but no equality rule joins
them to the current task. A requirements digest alone does not identify the query,
repository, selected context, or execution directory.

**Adversarial case:** the requirements describe a documentation typo while the
task object requests an authorization change. Both objects are individually valid.
The controller routes the wrong work cheaply. A changed query under the same
caller-assigned revision can also reuse an obsolete risk assessment.

**Minimum revision:** define one canonical joined launch identity. Require equality
of shared fields, bind the query and context receipt, and identify the actual repo
and working directory. The current launcher accepts `repoRoot` for selection but
does not pass an explicit child `cwd`; see launcher lines 76–78. Specify that
boundary rather than assuming selected repository equals executed repository.
Reject mismatches before classification. Define which changes require a new task
revision and revalidate bindings before execution.

### F04 — Next-attempt semantics can undo the escalation decision

**Contract:** design lines 46–50 and 62–64.
**Evidence:** launcher lines 33–36 resolve context anew for each explicit launch;
[context-profile-commands.js](../../scripts/lib/context-profile-commands.js), lines
125–135, already rejects managed-state drift.

A fresh explicit launch is specified for retries, but the relationship between
initial routing and a saved successor is absent. A policy digest is recorded
without saying whether policy contents remain pinned across attempts.

**Adversarial cases:** low fails, a checkpoint schedules medium, and the next
launch classifies back to low; an explicit next request jumps two steps; editing
the ladder changes the meaning of a recorded successor; a newly discovered high
risk floor lies above the one-step successor.

**Minimum revision:** distinguish initial decision from next-attempt operations.
A successor must consume an accepted parent checkpoint and its persisted allocation,
without rerunning initial classification or lowering the active task. Pin policy
and requirements for the revision; retain a bounded policy snapshot or require an
exact configuration match, because a digest cannot reconstruct an edited ladder. Define drift rejection and a separate new-revision
operation for changed risk/task scope. The conflict between “one step” and a changed
risk floor must have an explicit answer.

### F05 — Uniqueness does not define a concurrency-safe lifecycle

**Contract:** design lines 58–64, 68, and 85–86.
**Evidence:** [state-store/index.js](../../scripts/lib/state-store/index.js), lines
255–295, supports locked synchronous operations. That mechanism does not itself
define atomic domain transitions across separate reads and writes.

The draft has outcomes but no attempt/checkpoint transition table, duplicate
semantics, conflict rules, terminal states, or ownership of successor reservation.
“Do not run parallel attempts” is a requirement without an enforcement boundary.

**Adversarial cases:** the same failure checkpoint is replayed and advances twice;
two callers read the same frontier and each launch a successor; a late failure
follows success; a checkpoint is accepted while its attempt is still executing;
unverified completion is followed by verification, but the implementation cannot
tell whether this is a legitimate update or a conflicting second checkpoint.

**Minimum revision:** specify legal transitions, immutable checkpoint IDs, exact
duplicate replay, conflicting replay rejection, completed-attempt eligibility,
terminal success/exhaustion, and later-verification semantics. Reserve a unique
successor and advance the frontier in one short transaction. Test contention with
two independent store handles/processes. Keep provider execution outside the
database lock; otherwise a long task blocks the entire shared state store.

### F06 — A decision write does not solve the crash-before/after-spawn problem

**Contract:** design lines 64, 68–76.
**Evidence:** launcher lines 71–80 spawn and return a process result;
state-store lines 271–280 persist complete snapshots atomically. SQLite cannot
atomically commit a database transition together with an external subprocess or
remote tool side effect.

The draft handles returned write errors but does not define recovery when the
controller dies. A persisted decision may precede no execution, partial execution,
finished execution, or an active surviving process.

**Adversarial case:** the decision is written; the CLI applies a migration; the
controller crashes before completion recording. A restarted caller sees no result
and launches the same task again. The alternative failure window is a crash after
reservation but before spawn, leaving a permanently blocked attempt.

**Minimum revision:** distinguish durable intent/reservation, launch initiated,
process observed, completion, and unknown execution. Document that exactly-once
external effects are not guaranteed. Persist operation IDs before provider calls,
define abandoned reservation recovery, and require reconciliation of uncertain
execution before a successor. A lease expiry alone is not evidence that old work
has stopped. Specify how known no-spawn failures differ from possible execution.

### F07 — The classifier's operational trust boundary is unresolved

**Contract:** design lines 46–50 and 76.
**Evidence:** delivery contract line 61 explicitly records inherited Codex tools and
configuration. [.codex/config.toml](../../.codex/config.toml), lines 4–7 and 20–40,
does not certify tool isolation, requests use of MCP servers, and enables delegation.

The draft accurately acknowledges that read-only and ephemeral flags do not prove
tool/network isolation. It stops short of deciding what authority a classifier may
actually inherit. This matters before the task decision is persisted, because the
classifier is itself an agent invocation.

**Adversarial case:** an ambiguous task embeds an instruction to inspect extra files
or invoke an available MCP operation. The classifier does so, then returns a valid
allocation. The initial decision write fails and the task is refused, although
classification already incurred inference or external effects. Output validation
does not constrain actions performed before the output.

**Minimum revision:** choose a certified minimal classifier environment or an
explicit inherited-authority mode. Define repository-instruction loading, hooks,
MCP/apps, delegation, filesystem access, and credential source in that mode. If
authority is inherited, record an operation intent before invoking it and describe
the bound as submitted prompt bytes and direct CLI runtime, not total information
access or internal model calls. Never silently borrow ordinary-home credentials
when an isolated classifier cannot authenticate.

Ephemeral mode suppresses session rollout persistence; it is not a guarantee that
all runtime/provider state is untouched. See the
[official non-interactive documentation](https://learn.chatgpt.com/docs/non-interactive-mode).

### F08 — Killing the CLI does not establish that task work has stopped

**Contract:** design lines 50 and 58–64.
**Evidence:** launcher lines 76–80 and
[context-profile-proposal.js](../../scripts/lib/context-profile-proposal.js), lines
14–18, use `spawnSync`, timeout, and `SIGKILL` for the direct child. The local
descendant probe in the evidence appendix established this limitation.

**Adversarial case:** a task starts an editing subprocess, build, server, or external
operation. The CLI times out. The caller sees process-failure and explicitly retries,
while original work continues. The no-parallel-attempt promise is violated despite
the absence of automatic retry.

**Minimum revision:** define whole-process-tree cancellation and bounded cleanup
for supported OSes, or record termination-unconfirmed and block a normal successor
until recovery is explicitly established. Remote effects need their own uncertainty
state; local process termination cannot undo them. Include descendant survival,
user cancellation, and controller crash in acceptance. Do not claim that `spawnSync`
necessarily hangs: the observed probe returned promptly.

### F09 — The public operation and async store boundary are missing

**Contract:** design lines 13–15, 42, 52, 56, and 68.
**Evidence:** command parsing in context-profile-commands lines 7–52 has no allocation
configuration, requirements, checkpoint, or DB selector. Its `run` is synchronous,
lines 167–176, as is [scripts/profile.js](../../scripts/profile.js), lines 169–194.
`createStateStore` is asynchronous and applies migrations at open, state-store
lines 427–445. Its default path comes from the controller's home, lines 194–204,
independently of the isolated Codex child's home.

An opt-in integrated controller needs a reachable operation, not only a tested
library. Keeping requirements separate protects the strict resolver schema but
does not specify how both inputs arrive. Dry-run purity can be violated merely by
opening the existing store.

**Adversarial cases:** an implementation adds a library no supported command calls;
a synchronous CLI serializes a Promise or exits before recording; dry-run creates
directories or migrates a database; isolated execution writes telemetry into the
ordinary Claude-home DB without an explicit storage choice.

**Minimum revision:** define supported initial/checkpoint/next/status/recovery APIs
or CLI operations, versioned input and response envelopes, option precedence,
stable error/exit semantics, and the DB ownership/path contract. Choose a separate
async entry point or a tested async extension preserving existing behavior. Put
dry-run before any store creation/migration or other persistent initialization.
Specify filesystem nonwrites, not merely no event inserts.

## Important gaps

### F10 — Exact argv establishes a requested allocation, not an effective backend

**Contract:** design lines 32–38, 50, 70, and 80.
**Evidence:** project config line 17 intentionally leaves `model_provider` unset;
launcher lines 45 and 76–78 inherit provider configuration outside native isolation.
[context-profile-native.js](../../scripts/lib/context-profile-native.js), lines
25–33, admits specific Codex versions for native preparation.

**Adversarial case:** identical allocation IDs and model strings run through different
user-level inference gateways or CLI catalogs. Effective effort differs, while the
ledger presents the calls as comparable.

**Minimum revision:** record adapter/runtime version, executable identity, backend
identity or explicitly unknown/inherited status, and relevant configuration binding.
Separate requested from observed model/effort. An operator's capability declaration
is a configured assumption, not live entitlement or effectiveness certification.
Bind known metadata and leave unobservable values unknown. The
[official configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)
distinguishes provider selection from model selection and documents user/managed
provider controls.

### F11 — The controlled allocation ends at the root CLI session

**Contract:** design lines 7, 38, 46–50, 56, and 70–74.
**Evidence:** project config lines 22–40 enables roles with their own files;
[explorer.toml](../../.codex/agents/explorer.toml), lines 1–2, and
[reviewer.toml](../../.codex/agents/reviewer.toml), lines 1–2, pin different model/effort
combinations. The selection proposal's arguments, proposal lines 9–10, do not set
the new task allocation.

**Adversarial case:** a cheap root delegates to a costly reviewer; a high-risk root
delegates substantive work to a cheaper role; classification runs multiple internal
model turns; an ambiguous context proposal uses the inherited expensive default.
Root argv and one controller invocation do not establish task-wide intelligence or
one underlying provider request.

**Minimum revision:** explicitly scope floors and allocations to root calls unless
child enforcement is implemented. Separately record classifier, context proposal,
task root, and known descendant scope. Unknown descendant usage must prevent a
complete whole-task cost claim. Define the proposal allocation or label it inherited.
Custom role configuration can override parent model/effort; see the
[official subagent documentation](https://learn.chatgpt.com/docs/agent-configuration/subagents).
Whole-task allocation enforcement can be deferred; scope honesty cannot.

### F12 — Classifier transport, bounds, and option semantics are unspecified

**Contract:** design lines 46–50 and 81–82.
**Evidence:** proposal lines 9–26 parses plain final-message JSON;
[ai-eval-lib.js](../../docker/context-profiles/ai-eval-lib.js), lines 173–197, instead
extracts messages and completion usage from JSONL.

“One ID and a bounded reason” lacks exact key names, unknown-field behavior, byte
limits, response framing, timeout, output limits, and treatment of truncated task
text. Allowed opaque IDs alone also do not explain their suitability to a classifier.
The instruction cannot assume an ID named `a3` communicates a model's intended role.

**Adversarial cases:** adding `--json` for usage causes a raw JSON parser to reject
all otherwise successful classifications; a model returns a correct ID plus huge
reason text; truncation removes a security requirement; two eligible opaque IDs
have no descriptors from which to make a meaningful choice.

**Minimum revision:** define a strict response schema and transport; input, output,
reason, list-count, and UTF-8 byte bounds; truncation or rejection semantics; and a
bounded policy descriptor for each eligible option. Descriptors may convey declared
roles/capabilities and order without inventing empirical quality. Plain Codex stdout
can contain the final message; `--json` changes it to events, and `--output-schema`
can request structured output. See the
[official non-interactive documentation](https://learn.chatgpt.com/docs/non-interactive-mode).
Validate locally regardless of native schema assistance. Include a valid response
transport test, not only fallbacks.

### F13 — The classifier has no shared preflight and integrity-failure sequence

**Contract:** design lines 46–50, 56, 76, and 88.
**Evidence:** launcher lines 40–52 verify state/executable before a selection proposal,
line 63 checks source binding afterward, and line 71 checks again before task launch.
Command lines 118–135 checks native readiness and stored-generation drift.

**Adversarial case:** a separately implemented classifier resolves another executable
from PATH before checking the pinned native generation. A stale source, invalid
task, or invalid configuration incurs a paid call. Broad “classification error”
fallback treats executable/source integrity failure as an ordinary invalid response.

**Minimum revision:** define a common execution descriptor and preflight ordering
for every provider operation. Validate tasks, allocation config, provider binding,
native generation, and writable telemetry boundary before calls; recheck integrity
after calls and before launch. Recoverable response/transport failures may fall back.
Invalid input/configuration and integrity drift must stop. The existing launcher's
final guard is useful but cannot undo a wrongly authorized earlier classifier call.

### F14 — Existing deadlines and flattened results undermine escalation diagnosis

**Contract:** design lines 56–62 and 70.
**Evidence:** launcher lines 76–80 allows 90 seconds after context proposal or 120
seconds otherwise, with a 1 MiB buffer, then flattens null exit status to 1 and omits
structured signal/error codes. Evaluator lines 615–616 explicitly overrides the
task timeout because coding tasks outgrow that default.

**Adversarial case:** a legitimate three-minute high-effort task is killed. Whether
context selection needed a proposal changes its runtime allowance. Timeout, spawn
failure, output overflow, and a real native exit 1 become hard to distinguish.

**Minimum revision:** define validated classifier/proposal/task deadlines and output
bounds for opt-in execution, while retaining legacy behavior when unconfigured.
Record nullable exit status, signal, stable error category, spawned/no-spawn state,
and termination certainty separately. Treat resource termination as distinct from
reasoning inadequacy. A process-failure checkpoint must not erase the possibility
of partial changes or surviving work.

### F15 — Caller assertions do not yet establish the required success denominator

**Contract:** design lines 7, 42, 58–60, and 86.
**Evidence:** launcher lines 66–80 intentionally leaves taskSuccess unverified;
the evaluator's independent grading contract appears in
[context-profile-ai-evaluation.md](context-profile-ai-evaluation.md), lines 31–42.

The draft correctly rejects exit-zero as verified success and acknowledges that
caller assertions are not independent certification. Expected verification has no
schema or correspondence with the supplied evidence.

**Adversarial cases:** a formatting check is supplied for an authorization task;
evidence comes from another revision; a test passed before later code changes;
the implementing model labels its own prose as verification. A nonempty reference
can satisfy all of these unless more semantics are specified.

**Minimum revision:** define verification method, required checks, observed result,
task/revision and workspace/artifact binding, assertion source, and trust category.
Separate caller-asserted success from independently graded success in receipts and
economics. Offline references may remain opaque in the first slice, but must be
labeled unvalidated rather than promoted by the controller. Define verification
updates to a previously unverified attempt and invalidation after artifact changes.

### F16 — External blockers are treated as capability failures

**Contract:** design lines 58–62.
**Evidence:** the listed outcomes have no bounded failure-cause taxonomy. Current
launch tests exercise unsuccessful timeout/spawn results but provide no checkpoint
cause interpretation; [context-profile-launch.test.js](../../tests/lib/context-profile-launch.test.js),
lines 147–155.

**Adversarial cases:** verification fails because PostgreSQL is unavailable; a task
stalls while awaiting a product decision; tests fail because dependencies were not
installed. Advancing effort cannot supply those missing conditions.

**Minimum revision:** distinguish capability-relevant failure, external environment
blocker, missing requirements, and unknown cause. Define suspend/same-tier recovery
versus escalation. A caller-directed coarse policy is acceptable if explicitly
labeled; “failure means more reasoning helps” is not supported. Clarify how a
reported stall relates to the prohibition on interrupting an active attempt.

### F17 — Fresh-launch handoff and partial side effects have no contract

**Contract:** design line 64 and evidence requirements at line 70.
**Evidence:** launcher lines 72–75 sends the task and selected context; there is no
existing checkpoint envelope or continuation protocol in that stdin contract.

**Adversarial cases:** the next model receives only an opaque evidence path it
cannot access in an isolated home; it repeats a partially completed migration;
it starts in another cwd; new instructions describe a subtly changed task while
reusing the old parent; a reference points to mutable evidence changed since the
checkpoint.

**Minimum revision:** define a bounded fresh-attempt handoff: original task identity,
prior allocation, allowed evidence summary/reference, failure category, artifact
binding, and workspace continuity. Decide whether the controller resolves evidence
or only passes it through. Treat evidence content as untrusted reference data.
Require caller acknowledgement of partial/external effects when relevant; explicit
retry is authorization to retry, not proof of idempotency. Do not add automatic
rollback or native conversation continuation by implication.

### F18 — Risk has no assessment authority or change protocol

**Contract:** design lines 44, 48, and 62–64.
**Evidence:** requirement inputs are caller-controlled; the current resolver merely
validates task shape, context-selection lines 51–73. The draft supplies no trusted
assessment source or rule for updating it.

**Adversarial cases:** a model-generated envelope marks an authentication change
low-risk, bypassing a missing-risk high default; a caller lowers risk on the next
attempt to reach a cheaper tier; a task discovers sensitive scope and its new floor
conflicts with the previously pinned one-step ladder.

**Minimum revision:** state who may assert/change risk and what the floor protects.
An operator-declared quality policy is not a security authorization boundary.
Retain assessment provenance, reject silent risk lowering on an active revision,
and define new-revision or suspension behavior for scope changes. Security remains
governed by inherited task permissions and mandatory verification, not a model tier.

### F19 — Supported effort does not prove task and context compatibility

**Contract:** design lines 32–38, 48, 56, and 88.
**Evidence:** context-selection lines 9–11 caps selected skill count and injected
bytes; lines 59–61 caps task text. These are not per-model token-window or tool
capability checks. Native startup instructions and inherited history/config can
add content beyond the explicit reference block.

**Adversarial case:** a configured model accepts an effort value but cannot handle
the task's language/tools or effective context size. Classification selects it
validly and the attempt fails before producing useful reasoning evidence.

**Minimum revision:** specify the first slice's capability dimensions and unknown
handling. At minimum state whether context feasibility, tool support, and adapter
compatibility are declared assumptions or checked conditions. Preserve existing
context bounds; do not expand them silently for a supposedly stronger model.
Record injected bytes separately from effective native context, and avoid equating
byte caps with an observed token total. Calibrated empirical capability profiles
can be subsequent work.

### F20 — The existing store needs domain operations, not generic decision reuse

**Contract:** design lines 68–70 and 87.
**Evidence:** [queries.js](../../scripts/lib/state-store/queries.js), lines 320–332,
normalizes ordinary decisions to existing fields; lines 608–615 overwrites conflicts.
[migrations.js](../../scripts/lib/state-store/migrations.js), lines 136–147, currently
contains only initial and work-item migrations. Store index lines 268–270 rejects
async transaction work, lines 322–336 returns no statement mutation result, and
lines 449–462 exposes transactions through its internal database wrapper.

**Adversarial cases:** adding allocation fields to insertDecision silently drops
them; duplicate IDs overwrite historical evidence; a read-then-write successor
operation races despite individually locked queries; code assumes a SQLite driver's
changes count that this wrapper does not return; an async transaction callback
fails; caller-assigned session IDs have no existing session owner.

**Minimum revision:** specify dedicated entities, validated public atomic operations,
foreign keys, unique attempt/successor/checkpoint keys, parent scope constraints,
bounded fields, immutable-event versus mutable-frontier semantics, and session
creation/ownership. Update SQL, JSON schema, normalizers, and query APIs together.
Preserve prior data and test rollback/concurrent handles, not only close/reopen.
The file-lock/snapshot mechanism already exists; the missing piece is the controller
domain contract. Full-database export on each mutation also warrants a bounded
retention/load assumption before production scale.

### F21 — Completion-recording failure lacks a reconciliation operation

**Contract:** design line 76.
**Evidence:** launcher lines 79–80 returns an observed result; state-store persistence
can throw while replacing its snapshot. The draft says to report telemetry failure
and never retry, but defines no durable or machine-readable degraded state.

**Adversarial case:** the task finishes successfully, its final DB write fails, and
the response is lost. A later caller sees only the initial decision. A checkpoint
may be rejected for lack of a completed attempt, or a second initial launch may be
allowed. Report-only error handling is insufficient once the process exits.

**Minimum revision:** define structured `execution-ran/recording-incomplete` output,
durable intent lookup, recovery/reconciliation by operation ID, and allowed
checkpoint behavior while completion is uncertain. If the DB is unavailable,
acknowledge that persistence cannot be guaranteed and do not invent a second
automatic store or replay. Tests should distinguish initial-write refusal,
post-classifier recording failure, post-task failure, and failure during reconciliation.

### F22 — Cost per success can improve by abandoning harder tasks

**Contract:** design lines 7, 36, and 89.
**Evidence:** the existing evaluation contract, lines 91–116, retains failures and
uses a preregistered quality comparison. The controller has no equivalent objective
priority or completion constraint.

**Adversarial case, hypothetical prices:** a policy costs $1 per requested task and
completes 10%: $10 per success. Another costs $20 and completes all tasks: $20 per
success. The first wins on the proposed ratio while leaving 90% of work unresolved.
These numbers illustrate a mathematical issue; they are not provider prices.

**Minimum revision:** describe the first slice as an operator-governed allocation
heuristic. Define completion/quality and safety constraints first, then evaluate
cost and latency subject to those constraints. Define their tradeoff or report a
Pareto comparison without claiming a single optimum. A finite operator ladder is
not a measured capability or cost ordering. No learning/automatic policy update
mechanism should be implied by the controller name.

### F23 — Honest nulls do not yet produce honest aggregate economics

**Contract:** design lines 56 and 70–74.
**Evidence:** proposal lines 14–27 returns selected IDs, not operation usage;
launcher lines 66–80 returns process output and a routing count. Evaluator lines
710–716 already distinguishes unavailable aggregate usage.

**Adversarial case:** task tokens are observed, classifier tokens are unknown, and
the report totals only task tokens as the controller's cost. Failed classifier or
proposal work occurs before a task attempt exists and disappears from the history.
Subscription usage is converted to an invented cash bill, or cached inputs receive
the wrong price basis.

**Minimum revision:** identify every provider operation and its phase, allocation,
duration, observed usage/source, and task/decision linkage, including failed pre-task
work. Define known subtotals, complete totals, and unavailable totals; one missing
constituent prevents a complete aggregate claim. Include failed and abandoned tasks
in the attempted population. Specify token categories, currency, pricing source and
timestamp, estimate version, rounding, and subscription-versus-API-equivalent
meaning. Verification/recovery cost and child work must be either counted or
explicitly outside measured scope. Do not double-count completion and checkpoint
observations as separate inference operations.

### F24 — The existing evaluator would execute the wrong allocations unchanged

**Contract:** design line 89.
**Evidence:** evaluator lines 604–619 accepts launcher argv but sends only phase,
input, cwd, environment, and bounds to its provider. Lines 329–344 constructs a
Codex provider with one fixed preregistered model and effort.

**Adversarial case:** a future controller experiment reports different routed IDs
while the reused adapter executes every call with the same model and effort. The
experiment measures neither policy fidelity nor the proposed allocation tradeoff.

**Minimum revision:** add a subsequent-evaluation requirement for per-operation
allocation pins and proof that two route choices reach two distinct native argument
sets. Bind classifier, proposal, and task allocations in experiment registration.
This is a trap in future reuse, not a current evaluator bug: the existing experiment
intentionally holds the provider fixed to compare context modes. No live benchmarking
needs to be added to the first local build.

### F25 — “Subsequent paired evaluation” leaves essential study decisions open

**Contract:** design line 89.
**Evidence:** the existing evaluation document, lines 10–29 and 84–116, fixes tasks,
fresh workspaces, order, registration, quality margins, and population limits.
Those choices are for context selection, not automatically for model allocation.

**Adversarial cases:** controller tasks start from a previous arm's solved workspace;
only successes enter latency statistics; cheap and expensive policies use different
verification; repeated tasks are counted as independent cases; the router sees
holdout grader information; policy thresholds are tuned on the evaluation set;
the same task is rerun until a favorable result is retained.

**Minimum revision:** preregister a named fixed-model/effort baseline and at least a
deterministic-only versus System-1-assisted comparison. Hold task inputs, context,
permissions, verification, workspace state, and allowed recovery rules comparable.
Specify scheduled-request denominators, quality noninferiority requirements,
independent verification, risk/phase strata, task-cluster sampling, missingness,
order/cache effects, and stop rules. Report end-to-end latency, provider runtime,
checkpoint/human delay, and tail latency separately. Small fixture success proves
plumbing; it does not prove production generalization or model quality.

### F26 — The gate profile is currently neither portable nor complete

**Contract:** design lines 93–99; gate profile lines 5, 19–45, and 63.
**Evidence:** executed `node scripts/ci/validate-no-personal-paths.js` returned exit
1 with three errors in the gate profile. The validator scans docs, lines 17–28;
the profile embeds a real user's paths at lines 5, 45, and 63. Package scripts at
[package.json](../../package.json), lines 527–533, include this validator and an
80% coverage command. The profile does not include the latter. Its full-suite
baseline is explicitly unresolved, and this checkout lacks locked dependencies.

**Adversarial case:** focused tests pass and the draft is approved, but `npm test`
fails before exercising the controller because the gate document itself violates
repository rules. Another implementation declares completion after the allowlisted
tests despite the required 80% coverage having no executed gate. The run directory
still names a different checkout and may be unavailable in the current environment.

**Minimum revision:** use portable references in versioned docs and keep actual
machine/run paths in a local run record. Add the personal-path and coverage gates;
define meaningful controller unit, integration, and explicit-launch E2E coverage.
Revalidate locked dependencies and gates in this checkout. Resolve the full-suite
home/loopback isolation before claiming it passes. The profile already admits those
failures; this review does not treat them as newly discovered product regressions
or as approval to use the real provider home.

### F27 — Free-text reasons and evidence references can retain sensitive data

**Contract:** design lines 48 and 68–74.
**Evidence:** the design excludes raw prompts/output by default but requires a
reason/evidence reference. Existing profile display sanitizes control characters,
profile.js lines 160–166, demonstrating an established untrusted-display concern.

**Adversarial cases:** a classifier's short reason echoes a task secret; an evidence
URI contains credentials or sensitive local identifiers; control characters alter
a terminal report; a reference contains instructions which are promoted into a
fresh task prompt; evidence retention deletes an object still required for audit.

**Minimum revision:** define bounded reason codes versus optional text, privacy and
redaction rules, reference types, control-character handling, retention/deletion,
and whether references are ever dereferenced. Prompt hashes are provenance, not
encryption of low-entropy sensitive text. Do not persist raw error output to satisfy
typed process results. Keep classifier reasons and evidence content as data rather
than execution instructions. This is a handling-contract gap, not evidence that
the current draft or repository exposed a secret.

## The economics test the design should eventually satisfy

The controller should not be assumed beneficial just because its first attempt is
cheaper. A simple two-tier comparison illustrates the needed measurement:

`expected routed cost = classification + context proposals + low attempt + failure probability × (verification/recovery overhead + high retry)`

Compare that with a direct high-tier attempt under equivalent task and verification
conditions. Extra prompts, fresh-session work, retry context, abandoned attempts,
and reduced cache reuse can erase the initial saving. This is an explanatory model,
not an asserted distribution or current benchmark result.

For a fixed population of requested tasks, a useful reported ratio is total measured
cost of all those requests divided by independently verified completions. Zero
completions makes that ratio undefined. Missing operation cost makes a complete
ratio unavailable, although a clearly labeled known subtotal can still be shown.
Completion rate and safety/quality constraints must accompany the ratio and govern
whether a policy is acceptable. Reporting only the cheapest solved tasks invites
survivorship bias.

The first slice can establish faithful allocation, bounded operation scope, and
usable evidence. It cannot establish economic superiority from mocked providers
or static ladder order. The draft already rejects that claim; preserve that boundary.

The [acceptance matrix and probe evidence](system-1-controller-review-appendix.md)
form part of this report.

## What the draft already handles correctly

Preserve these choices through revision:

- Explicit opt-in launches provide a useful integration boundary. Claude, Rust,
  dashboards, Obsidian, and ordinary interactive-turn interception remain separate.
- Deterministic policy before classification can avoid unnecessary overhead.
- Allocation IDs and deterministic validation prevent the returned model response
  from directly amending configuration or task permissions.
- Model IDs are operator supplied; the design makes no unsupported current price,
  availability, entitlement, or universal quality-ranking claims.
- Process completion stays distinct from task verification; unknown metrics remain
  unknown; failures stay in history.
- Explicit inspection before a fresh attempt is a sound default. Preserve the
  prohibition on automatic mutating retries.
- Refusing execution when initial recording fails and reporting post-execution
  recording failure are correct foundations. Add lifecycle/recovery semantics.
- Mocked provider tests validate control flow, not savings or model quality.
- Existing context source bindings and isolated-environment checks are important
  contracts to reuse, rather than reimplement loosely.

No defect was established in the existing use of argv/stdin rather than a shell,
and no live exploit, model-output guarantee, or actual economic regression was
demonstrated. The report should not be read as evidence of those claims.

## Deferrable enhancements and explicit scope decisions

The following need not block a bounded first local build once the findings above
have precise answers:

- A calibrated classifier confidence/abstain protocol and measured model capability
  profiles. A syntactically valid route can still be unsuitable.
- Cause-aware learned escalation, branching allocation graphs, automatic policy
  learning, and phase-specific resets. The present linear ladder is a policy choice;
  define task/phase boundaries so a hard diagnosis does not silently force every
  later formatting step to the same tier.
- Cost/deadline budgets per request and across retries. A finite ladder limits
  upward steps, but does not limit repeated initial decisions, same-tier recovery,
  internal agent turns, or total billed work. A hard spend-cap claim would require
  separate enforcement and observability, not nullable retrospective metrics.
- Task-wide child allocation enforcement, richer production task corpora, and
  broader provider/OS certification.
- Packaging and rollout beyond the local opt-in API. Before publishing, decide
  whether configuration/schema assets ship with the npm/plugin installers, provide
  compatibility/version diagnostics, and define disable/rollback behavior without
  deleting audit history. A local developer module alone is not a released feature.

These should be stated as scope boundaries. Deferral should not leave present
claims of whole-task control, complete accounting, or measured optimization intact.

## Recommended revision sequence

1. **Define policy and identity:** requirements/config schemas, routing table,
   floor/fallback invariants, canonical task/repository/query/context binding.
2. **Define lifecycle:** initial versus successor operations, transition table,
   immutable events, atomic reservation, policy pinning, crash and telemetry recovery.
3. **Define runtime authority:** classifier environment, shared preflight, backend
   provenance, root/child scope, timeout/cancellation and termination uncertainty.
4. **Define evidence:** verification schema/trust, bounded fresh-attempt handoff,
   operation accounting, privacy, quality-first economic interpretation.
5. **Define the public integration and gates:** async entry point, opt-in/DB ownership,
   pure dry-run, adversarial acceptance cases, portable profile, isolated full-suite
   environment, required coverage.
6. **Prepare subsequent measurement:** fix allocation fidelity in the evaluator and
   preregister comparable baseline/policy experiments before live savings claims.

Refresh referenced contracts before editing the authoritative design. Keep design
revisions ahead of implementer dispatch, as required by the project's workflow.
This report does not itself revise the spec, approve the gates, or authorize a
provider call. A reviewed revision should make each acceptance result independently
decidable from the on-disk contract.
