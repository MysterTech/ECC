# System 1 task allocation and provider continuation

This feature adds an operator CLI for coding tasks launched through ECC. The
controller chooses an admitted model and effort, records the task, and can
continue with the other configured provider. It starts a fresh Codex or Claude
Code session in the same repository. Existing work stays on disk.

The first version uses JSON operation files and terminal output. It does not
move an existing Codex desktop chat or Claude conversation into the other app.
Native hidden reasoning, transcripts, session IDs and authentication do not
transfer. Read the [controller design](../design/system-1-controller.md),
[protocol](../design/system-1-controller-protocol.md) and
[subscription boundary](../design/system-1-provider-handoff.md) before configuring
live execution. Fixture tests do not certify native billing or live failover.

## What the user sees

Start a task through the dispatcher using an explicit policy, input and private
database outside the working repository:

```sh
ecc allocation run --config /absolute/path/policy.json \
  --input /absolute/path/task.json --db /absolute/private/path/allocation.db
```

Human output reports safe milestones, the accepted capability tier/allocation,
the task state and next actions. For an admitted automatic switch it can show:

```text
Starting task (codex).
Subscription usage limit reached (codex).
Continuing with another provider (claude).
Starting task (claude).
Task attempt finished (claude).
ECC allocation run: recorded (ECC_ALLOCATION_OK).
Task state: awaiting-checkpoint.
Capability tier: standard; allocation: standard-claude.
Next actions: inspect, checkpoint, switch, progress, abandon.
```

IDs and next actions depend on the configured policy and saved state. Provider
stdout/stderr and task notes are not printed. With --json, stdout contains one
exact redacted ecc.allocation-result.v2 object and no progress lines. The provider
doing work can change, while the task and repository remain the same.

Completion of a provider attempt still requires a verification checkpoint. It
does not automatically mean the code passed tests or that the task is finished.
The successor uses accepted progress, the original task and retained files, then
reinspects and verifies its work.

## Configure the provider boundary

Both native CLIs must already be installed and separately signed into their own
subscription homes. Configuration is a strict ecc.allocation-policy.v2 document
with pinned executable/configuration digests and admitted exact runtime versions.
There is no implicit policy, home, database, API fallback or environment opt-in.
Do not copy provider credentials into policy files or the database.

The current adapter admits Codex app-server 0.155.1, Codex exec 0.154.0/0.155.1
and the protocol's pinned Claude stream-json versions. Codex exec 0.154.0 cannot
currently establish its subscription route and fails closed for actual allocation
execution. Current-provider Claude 2.1.261 is distinct from native-ready isolated
Claude 2.1.292 or admitted later 2.1 patches. Check the exact admission rules;
the feature does not update or prepare native homes.

An operator preparing configuration can use these exported JavaScript APIs:

| API | Purpose |
| --- | --- |
| normalizePolicy(raw) from scripts/lib/allocation/validation.js | Strictly validate/default the policy and its references |
| inspectRuntimeMetadata({provider, workingRepoRoot, context}) from scripts/lib/allocation/runtime.js | Inspect pinned nonsecret executable/config/home metadata without a native auth or inference call |
| computeSubscriptionRouteDigest({provider, observation}) from scripts/lib/allocation/runtime.js | Bind provider home/config/auth class using the protocol's exact nonsecret digest fields |
| canonicalDigest(normalizedProvider) from scripts/lib/allocation/validation.js | Produce the runtimeBindings entry for the normalized descriptor |

The route observation supplied to the digest helper contains method,
executableDigest, providerHome and configDigests from the admitted metadata.
Calculating a digest is not authentication verification: actual execution also
checks the native version and auth route. Provider descriptors must pin every
existing route-bearing config file; API/cloud/backend overrides reject. Native
bookkeeping normalization is admitted only where implemented and documented.
Codex app-server also must report modelProvider openai and the requested model
in its thread-start response before ECC sends the task turn. A mismatched or
unknown effective backend/model blocks rather than being treated as a valid
subscription launch.

authRoute.paidExtraUsageDisabled true is an explicit operator assertion about
existing account settings. OAuth login alone does not prove this assertion. ECC
does not change account settings or provide an account-wide cash cap; observed
overage blocks. Unattributable subscription request cost stays unknown.

Model/effort tiers are operator declarations of adequate capability. The policy
must supply two to eight ordered tiers and individually compatible alternatives.
Provider switching stays in the same tier; capability escalation advances one
tier after accepted evidence. Configure both separately rather than making quota
exhaustion imply harder reasoning or a cheaper model.

## Prepare the initial operation

run input has exactly the following top-level fields. Values below are a template;
replace paths and runtime digests with the bound actual values before execution.
The zero digests are intentionally not live provider credentials or bindings.

```json
{
  "schemaVersion": "ecc.allocation-run.v2",
  "requestId": "task-start-1",
  "task": {
    "sessionId": "coding-session",
    "taskId": "example-task",
    "revision": 1,
    "phase": "implement",
    "query": "Implement the requested change and verify it."
  },
  "requirements": {
    "sessionId": "coding-session",
    "taskId": "example-task",
    "revision": 1,
    "phase": "implement",
    "complexity": "moderate",
    "ambiguity": "clear",
    "riskAssessment": null,
    "requiredCapabilities": [],
    "expectedVerification": [
      { "checkId": "unit-tests", "method": "unit", "requiredCapabilities": [] }
    ],
    "explicitAllocation": null
  },
  "repoRoot": "/absolute/path/to/repository",
  "cwd": "/absolute/path/to/repository",
  "contexts": {
    "codex": { "mode": "explicit", "profileId": "lean@1", "selectionMode": "manual", "include": [], "exclude": [] },
    "claude": { "mode": "explicit", "profileId": "lean@1", "selectionMode": "manual", "include": [], "exclude": [] }
  },
  "runtimeBindings": {
    "codex": { "runtimeDigest": "0000000000000000000000000000000000000000000000000000000000000000" },
    "claude": { "runtimeDigest": "0000000000000000000000000000000000000000000000000000000000000000" }
  },
  "previousClosureAcknowledgement": null,
  "automaticContinuationAcknowledgement": null
}
```

Provider keys must equal the policy's IDs. repoRoot/cwd must be the same canonical
existing Git repository root. A null risk assessment conservatively means high;
an approved lower risk assessment needs the protocol's explicit provenance. The
expected checks are declarations, not shell commands run by the input parser.

Preview without opening or creating a database, invoking native auth/providers,
or loading selected workflow bodies:

```sh
ecc allocation run --config /absolute/path/policy.json \
  --input /absolute/path/task.json --dry-run --json
```

Preview may report a pending classifier. It does not invent the model response.
All files/stdin are bounded at 65,536 UTF-8 bytes. --input - accepts JSON from
stdin through the outer dispatcher. --config accepts a file, not another stdin
consumer. Unknown/duplicate flags and extra JSON fields reject.

## Save progress and switch manually

Enable continuation explicitly in policy to authorize bounded private task
capsule/journal persistence. Progress is saved only when the caller submits a
progress operation; requesting notes in a model prompt does not implement this
integration. Without journal updates, the destination still receives the original
task and must reexamine retained files.

Use the last result's identity, attemptId, frontier and journalVersion in a
progress envelope. Its journal has ordered plan, decisions, completed and pending
arrays under the protocol's prose limits. Each update replaces the complete
journal and uses compare-and-swap checks; stale versions reject.

For a manual switch, submit switch with the exact source attempt/operation IDs,
expected frontier/journal version, destinationAllocationId (or null), and an
effectAcknowledgement. That acknowledgement explicitly asserts the relevant work
stopped and explains whether effects were retained, reconciled or absent. Never
acknowledge while an old provider or external effect remains active or unknown.
switch reserves the successor and does not launch it:

```sh
ecc allocation switch --input /absolute/path/switch.json \
  --db /absolute/private/path/allocation.db --json
ecc allocation resume --config /absolute/path/policy.json \
  --input /absolute/path/resume.json --db /absolute/private/path/allocation.db
```

Build resume from the saved transition's destination attempt, parent attempt,
transitionId, frontier, journalVersion, policyDigest and runtimeSetDigest. It reads
the private original capsule; do not resupply a task query, model or risk override.
The input schemas and exact allowed acknowledgements are in the
[protocol](../design/system-1-controller-protocol.md).

Changed policy, requirements, scope or allowed runtimes require a new task
revision after safe closure. Stale/repeated/conflicting IDs do not relaunch work.
Saved identical replay returns the earlier outcome.

## Enable automatic continuation carefully

The implemented automatic source mapping is pinned Codex app-server 0.155.1.
It requires a correlated terminal usageLimitExceeded result, normal shutdown,
complete observed tool quiescence, intact bindings/capsule/workspace and an
available unvisited same-tier alternative with remaining switch budget.
The policy must enable automaticOnUsageLimit, and run must supply a matching
explicit workload acknowledgement of synchronous local work with no detached or
external effects. This is trusted caller scope, not universal descendant proof.

Claude stream-json and Codex exec are manual-only sources in this version. Plain
text quota messages, generic rate-limit/429/retry signals, pending tools, forced
stops and unknown effects do not trigger an automatic second provider. Native
live automatic handoff remains uncertified; fixtures establish the adapter's
control flow and negative guards only.

When both providers are unavailable, ECC preserves the task and reports a paused
state. A cooldown/reset is an observation, not a guaranteed usable allowance.
The controller does not ping-pong, repeatedly probe, lower the capability floor
or choose API credits. inspect/status and, where needed, recover preserve the
evidence before any later continuation.

## Inspect and interpret outcomes

status reads an existing validated published snapshot without creating/migrating
state or contacting providers. Supply exactly one selector: identity or
operationId, with the other null. Queries, journal prose, workspace manifest paths
and native transcripts are absent from the result.

| Exit code | Meaning |
| --- | --- |
| 0 | Valid preview/read/completed mutation or successful saved replay |
| 1 | Provider failure, blocker, exhausted alternatives or failed checkpoint |
| 2 | Input/config/binding/capability/auth validation or unsupported operation |
| 3 | Conflict, stale state or busy owner |
| 4 | Persistence/integrity/recovery required |

Use code, taskState and nextActions together. A valid status read can exit zero
while describing a paused or recovery-required task. ran-recording-incomplete
means provider work occurred but recording is uncertain: inspect/recover before
retrying. Recovery reconciles or abandons; it never launches a provider.

The CLI E2E fixtures compile a private native launcher with cc to preserve the
production executable fingerprint boundary. A C compiler is a test prerequisite;
there is no weaker script-executable fallback. These launchers execute fake
protocol streams only, with isolated homes and no real subscriptions.
