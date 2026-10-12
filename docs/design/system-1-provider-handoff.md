# Subscription provider handoff

Status: proposed v3 companion, 2026-10-11. No live automatic failover is certified.
Read with [controller design](system-1-controller.md) and
[protocol/state contract](system-1-controller-protocol.md).

## What continues across providers

ECC can preserve a coding task across separately authenticated Codex and Claude
Code subscriptions by starting a fresh destination session against the same
working repository. It supplies the original requirements, admitted destination
ECC context, portable public progress and bounded workspace observations.
Hidden reasoning, native conversation IDs, provider transcripts and pending
native tool state do not migrate. Native resume interfaces resume their own
sessions; they are not a cross-provider memory format. See official
[Codex noninteractive execution](https://developers.openai.com/codex/noninteractive)
and [Claude headless execution](https://code.claude.com/docs/en/headless).

The continuation contract has three separate controls:

| Control | Meaning |
| --- | --- |
| Capability tier | Required model/effort/capability floor for this task phase |
| Provider alternative | Admitted Codex/Claude allocation within that tier |
| Availability transition | Safe same-tier switch, independent of capability escalation |

A quota failure does not show that stronger reasoning is needed. A capability
failure does not show that the subscription is exhausted. Keep those causes,
durable transitions and economic populations distinct. Ordered alternatives are
operator assumptions of adequate capability, not equivalent-model certification.

## Subscription boundary

Each target uses its own preexisting authenticated home and native configuration.
Neither ordinary nor isolated mode copies credentials, borrows the other home,
logs in automatically or selects paid APIs. Subscription-only execution rejects
known API key/endpoint/provider routes and unknown/contradictory authentication
provenance before a root operation. Child/native tool billing is not universally
observable; inherited authority cannot justify an account-wide spend guarantee.

Codex account/read distinguishes ChatGPT login from API-key and other account
types. That proves authentication class, not current usable entitlement or a
remaining-token balance. Revalidate the native backend/config route rather than
infer it solely from logged-in account type. Avoid persisting account email,
account ID, tokens or account response bodies. Official
[Codex authentication](https://developers.openai.com/codex/auth) describes its
separate login routes; the pinned protocol's
[account response](https://github.com/openai/codex/blob/rust-v0.155.1/codex-rs/app-server-protocol/src/protocol/v2.rs)
is the source for adapter validation.

Claude authentication can prefer configured credentials/provider routes over
subscription OAuth. Validate the active route and bound configuration, not
merely an auth-status success exit. The adapter must reject alternative API/
cloud-backend selectors instead of silently labeling them subscription. Official
[authentication precedence](https://code.claude.com/docs/en/authentication#authentication-precedence)
and [auth CLI commands](https://code.claude.com/docs/en/cli-reference#cli-commands)
provide the current public boundary. A pinned CLI's exact nonsecret observation
and config admission still require fixtures/native evidence.

OAuth subscription login can coexist with account-enabled paid extra usage.
authRoute.paidExtraUsageDisabled true is an explicit operator assertion about
that account setting. Observed overage or contradictory billing state blocks;
the harness does not change settings or promise a hard cash cap. Unknown per-task
subscription cash cost remains null. See
[Claude extra usage](https://support.claude.com/en/articles/12429409-extra-usage-for-paid-claude-plans).
Claude --bare is not a subscription-isolation mechanism: the documented headless
path disables OAuth in bare mode. It is excluded from this contract.

## Admitted transport and actual evidence

| Runtime | Proposed transport | Automatic subscription-quota capability |
| --- | --- | --- |
| Codex 0.154.0/0.155.1 | codex exec JSONL | Unsupported: pinned error event exposes message without typed quota code |
| Codex 0.155.1 | Experimental app-server stdio | Fixed typed usageLimitExceeded mapping admitted for implementation; live behavior unobserved |
| Claude 2.1.261 current-provider | Print stream-json | Manual-only: named-window telemetry observed, terminal quota semantics not guaranteed |
| Claude native-ready 2.1.292+ in admitted 2.1 series | Print stream-json with bound native plugin | Manual-only: native receipt does not establish quota mapping |

Capability is a built-in adapter/version allowlist. The only automatic mapping in
this slice is codex-app-server-0.155.1-usage-limit-v1; implementing its schema and
fixture guards does not claim live quota certification. There is no user-provided
certification flag. Config cannot override unsupported automatic capability.
Manual switch remains useful where native quota is
unknown, but still needs cessation/effect acknowledgement and intact capsule.
Codex 0.154.0 exec parsing remains admitted, but its native subscription-route
observation is unverified in this slice; actual allocation execution fails closed
until that observation is supported. Existing profile execution is unchanged.
Dry-run reports unsupported/unobserved states without trying a paid call.

Pinned Codex exec JSONL's ThreadErrorEvent exposes only message; an error string
is insufficient even if it looks like a familiar usage-limit message. The typed
information exists upstream but this exec projection discards it. See
[exec events 0.155.1](https://github.com/openai/codex/blob/rust-v0.155.1/codex-rs/exec/src/exec_events.rs)
and [JSONL projection](https://github.com/openai/codex/blob/rust-v0.155.1/codex-rs/exec/src/event_processor_with_jsonl_output.rs).
Do not add substring matching, HTTP 429 interpretation or a guessed balance.

### Codex app-server adapter

Use the pinned executable's app-server stdio transport with bounded newline JSON
requests/responses/notifications and request IDs. The version-generated JSON
schemas, not a generic JSON-RPC client's defaults, own wire shapes. The minimal
sequence is initialize, initialized notification, subscription-route observation,
thread/start, turn/start, correlated terminal notifications, then graceful stdin
closure and observed root exit. See official
[app-server overview](https://developers.openai.com/codex/app-server)
and [pinned protocol source](https://github.com/openai/codex/blob/rust-v0.155.1/codex-rs/app-server-protocol/src/protocol/v2.rs).

thread/start supplies pinned cwd/model, ephemeral true and
allowProviderModelFallback false.
Before turn/start, require the returned modelProvider to be exactly openai and
the returned model to equal the requested exact model ID. Missing or mismatched
observations fail closed without starting inference; ChatGPT auth class alone
cannot prove the per-thread backend or prevent a native allocation fallback.
Task permission/approval/sandbox overrides,
dynamic tools and instruction-replacement fields are omitted. Classifier/proposal
request read-only sandbox as the existing advisory boundary, not complete
authority isolation. turn/start supplies returned threadId, one text input,
exact requested model and effort. No native thread resume or extra automatic
turn is introduced. Bind thread/turn/item IDs transiently to the operation;
persist only allowlisted observations/digests, not native history.

Accept a confirmed Codex subscription quota only when the same thread/turn has
turn/completed with turn.status failed and turn.error.codexErrorInfo exactly
usageLimitExceeded, known ChatGPT subscription route, no pending/unknown tool
items, and normal root shutdown. Correlated error notifications must not contradict
that terminal error, and no later retry/active turn may remain. Terminal failed
turn is required; error notification alone, including willRetry false, cannot
authorize a switch. rateLimitExceeded is different and never confirms subscription
exhaustion. willRetry true is nonterminal. Missing/conflicting observations block.
Account rate-limit snapshots/reset timestamps are supplementary availability
observations; absent snapshots remain null and never replace typed failure.

Project item/started/item/completed for command execution, file changes, MCP calls
and any other effect-bearing item. Unknown effect-bearing item type or unmatched
start is unknown quiescence. Do not treat agent-message or reasoning output as a
tool completion, and never persist reasoning events. Native approval/elicitation/
input requests require their actual caller workflow; this adapter cannot invent
approval. An unhandled request blocks continuation and bounded stop/recovery.
No forced signal is relabeled graceful normal exit. This is a proposed bounded
adapter, not evidence of support for every interactive app-server capability.

### Claude stream-json adapter

Use pinned Claude --print with stream-json and required verbosity, explicit
model/effort and bounded stdin/cwd. Proposal uses existing tool-disabled and
session-persistence-disabled behavior; task permissions/hooks/tools retain native
policy. Effort vocabulary/support must be admitted for that exact CLI/model;
never drop an unsupported effort to make the process succeed.

Correlate stream assistant tool_use starts with terminal tool_result observations;
parallel/nested/task tool states require complete attributable completion, otherwise
quiescence is unknown. A result event is not task verification. Preserve terminal
is_error, subtype, process status and usage separately. Missing terminal result,
malformed stream or abnormal root termination blocks automatic failover.

Official [headless API-retry handling](https://code.claude.com/docs/en/headless#handle-api-retries)
describes system/api_retry with generic rate_limit. That event is not a confirmed
subscription quota. A rate_limit_event can be informational. The observed
rate_limit_info fields status, rateLimitType, resetsAt, isUsingOverage and
overageStatus are not a formally guaranteed 2.1.261 contract. The SDK changelog
records [CLI/SDK parity](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md);
an official-repository [observed event report](https://github.com/anthropics/claude-agent-sdk-python/issues/599)
is telemetry evidence, not an API guarantee.

A candidate strict mapping requires a rejected named five_hour/seven_day
subscription window, correlated terminal is_error true, explicit non-overage
state and the validated subscription route. Allowed/warning/unknown status,
generic retry, conflicting overage fields, ambiguous terminal correlation or
missing values never authorizes failover. Newer quotaLimits/unified-window fields
reported on later CLIs must not be retrofitted into 2.1.261 admission.
This candidate is not admitted for automatic switching in v3. Claude quota-like
telemetry can be reported as unavailable/ambiguous availability provenance, but
quotaObservation remains null and tool errors remain provider errors. Return
AUTOMATIC_UNSUPPORTED/blocked with manual switch available after safe cessation;
never label a generic failure confirmed quota. A future contract revision must
admit a precise stable mapping before this policy can execute it automatically.

A manual-only classifier failure before a capability tier has been accepted cannot
use switch/resume in this slice. Safely reconcile or abandon that revision, then
start a new revision with a disabled classifier or an explicit allocation. Generic
Claude failure is never promoted to a confirmed quota just to make handoff possible.
The default disabled classifier avoids this pre-task boundary for ordinary routing.

## Safe continuation and durable progress

Progress comes from actual CAS journal submissions, not a hoped-for final summary
after quota exhaustion. Initial run stores original query plus empty bounded
journal only when continuation is explicitly enabled. Root/controller integration
can submit visible plan/decisions/completed/pending updates while active. Prompt
instructions requesting such updates are advisory until the integration invokes
the API. If notes are absent or stale, destination reinspects retained files and
reruns verification; it does not invent the missing work.

Automatic failover from the admitted Codex app-server mapping is limited to
workloads the trusted caller explicitly declares
synchronous/local with no detached or external effects. It also requires typed
quota, ordinary root termination, complete tool quiescence, intact pinned bindings,
capsule, safe workspace capture, available unvisited same-tier alternative and
remaining switch budget. These jointly define scoped safety; they do not prove
that every inherited descendant or remote effect in arbitrary coding work stopped.
Unknown safety blocks. Manual switching requires explicit broader cessation/effect
acknowledgement, and active/abnormal work must stop/reconcile first.

One DB frontier excludes another controller owner. It does not lock the workspace
against user edits or outside agents. Tracked/nonignored untracked manifests bind
bounded file digests after cessation and are rechecked before destination spawn.
They reject symlinks/private files/overflow and expose excluded scope. Files stay
in place; no stash/reset/rollback/copy of entire repository is automatic.

Capability escalation advances the tier; subscription/manual failover keeps it.
Every visited alternative is finite, persisted and replay guarded. Cooldown/reset
does not grant a repeated same-tier attempt. If both providers are unavailable,
preserve a provider-paused task and surface holdoff/reset observations; do not
probe, switch to API credits, lower capability or retry indefinitely.

## Certification before claiming seamless operation

Fixture tests establish framing, strict schemas, allocation propagation,
idempotency, crash handling and negative quota cases. They cannot establish
subscription billing, native event semantics or real tool cessation. Native
certification must separately bind exact executable/CLI/config/auth route and
exercise a consenting test workload in each direction. Never manufacture quota
exhaustion by spending a user's allowance merely to obtain evidence.

Required observations include ordinary work plus manual handoff; typed confirmed
quota where available; generic retry/overage/prose negatives; terminal errors and
pending tools; no normal exit on forced cancellation; both unavailable; retained
edits and verification; auth/API route rejection; no transcript/credential leakage;
and unchanged native permission policy. Record unobserved cases explicitly.
When native quota is not reproducible, automatic capability remains uncertified;
manual continuation can be certified separately. No mock success claims savings
or universal interruption recovery.

Implementation must read this source-bound contract on disk. ECC quality/security
reviews must check adapter mappings, private capsule permissions, CAS boundaries,
subscription guard and inherited-authority limits before advertising capability.
