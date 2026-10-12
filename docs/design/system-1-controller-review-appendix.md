# System 1 review: acceptance matrix and evidence

Part of the [adversarial review](system-1-controller-review.md), dated 2026-10-11.
The cases below supplement its 27 consolidated findings.

## Missing adversarial acceptance cases

These are required behaviors to resolve in the contract, not unexecuted test code
presented as a ready implementation plan. Concrete fixture names and commands must
be empirically checked when planning implementation.

| Area | Adversarial case | Required observation |
| --- | --- | --- |
| Requirements | Wrong type, unknown field, invalid enum, overlong UTF-8 input | Stable rejection before any provider call |
| Missing values | Absent complexity/ambiguity/risk | Defined conservative route; no silent easy default |
| Adaptive policy | Clear easy and clear demanding task | Different specified allocations; zero classifier calls |
| Precedence | Multiple deterministic rules match | Defined winner or explicit conflict rejection |
| Explicit choice | Requested allocation below floor | Documented rejection or promotion |
| Config | Unknown/duplicate ID, rank conflict, missing floor | Entire config rejected before classification |
| Fallback | Fallback below a supported risk floor | Invalid config or defined risk-eligible fallback |
| Task eligibility | Allocation exists but is outside task ladder | Rejected according to membership contract |
| Single eligible route | Floor leaves one executable option | Defined classifier-call behavior |
| Input binding | Requirements/task identity, phase, revision, query mismatch | No classified or launched work |
| Repo binding | Selection repo differs from child cwd | No execution in the wrong repository |
| Initial idempotency | Same decision ID submitted twice | No duplicate classifier/task operation |
| Classification | Valid result, malformed JSON, wrong ID, extra key, long reason | Exact accepted response or typed fallback |
| Framing | Plain final-message and chosen JSONL transport | Parser matches documented native mode |
| Prompt injection | Task text requests tools or policy changes | Classifier boundary preserved; no floor/config amendment |
| Classifier scope | Repository instructions, MCP, hooks, delegation present | Certified exclusion or explicit inherited-authority label |
| Preflight | Stale source/native generation/executable | Stop before classifier and task; no ordinary fallback |
| Auth boundary | Isolated home lacks credentials | Typed auth failure; no silent ordinary-home borrowing |
| Provider | Same model name under a different backend/catalog | Drift refusal or explicitly unknown/inherited identity |
| Arguments | Two allocation IDs with distinct model/effort | Exact differing argv reaches real adapter boundary |
| Child scope | Role file sets another model/effort | Root-only scope and accounting completeness reported honestly |
| Context | Declared model cannot meet context/tool need | Defined incompatibility/unknown handling |
| Dry run | No DB exists; older DB would migrate on open | No directory, DB, migration, credential, or prompt writes |
| Dry run | Ambiguous route and context proposal required | No provider call/body load; no fabricated classified choice |
| Checkpoint | Unknown/wrong-task/running attempt | Rejection without frontier change |
| Replay | Same checkpoint ID and same payload | Same result; no second advancement |
| Conflict | Same checkpoint ID, different outcome/evidence | Rejection; immutable original retained |
| Success | Late failure after terminal success | Defined terminal-state rejection |
| Later evidence | Unverified completion later independently verified | Defined update without a fresh task execution |
| Contention | Two callers reserve the same successor | At most one executable successor |
| Retry policy | Saved successor plus fresh explicit/classified low choice | Persisted successor wins or request rejected |
| Drift | Ladder/model/requirements change after checkpoint | Pinned semantics or explicit new-revision requirement |
| Changed risk | New floor is above one-step successor | Defined suspend/new-revision behavior |
| Exhaustion | Failure at top tier | Terminal exhaustion; no hidden wraparound |
| No-spawn error | Invalid executable/auth/model request | Typed process result; no reasoning escalation |
| Limits | Timeout, output overflow, signal, cancellation | Distinct outcomes; no false exit-code certainty |
| Descendants | CLI dies while its child continues | Cleanup proven or termination-unconfirmed blocks normal retry |
| Crash | Before reservation, before spawn, after spawn, after task effects | Defined intent lookup and reconciliation |
| Partial work | Prior attempt modified workspace/external state | Bounded handoff and explicit recovery decision |
| Evidence | Missing, stale, wrong revision, mutable reference | Trust/availability label; no false independent verification |
| Verification | Expected regression check replaced by lint/prose | Insufficient evidence does not satisfy success criterion |
| External blocker | Test DB missing or task needs a human decision | Suspension/cause label instead of unjustified escalation |
| Initial write | DB unwritable before any opted-in execution | No task launch; classifier ordering matches stated boundary |
| Completion write | Execution finished, telemetry write fails | Machine-readable ran/incomplete result; no execution replay |
| Store schema | Ordinary decision API receives allocation fields | No silent field loss; dedicated API/schema exercised |
| Store atomicity | Independent handles race; transaction fails midway | No lost frontier or partial event reservation |
| Migration | Existing sessions/skills/decisions plus new schema | Preserved data, schema validation, reopen and rollback checks |
| Usage | One operation missing usage; failed pre-task call | Incomplete total, known subtotal labeled; failed work retained |
| Metrics | Cached tokens, subscription usage, price-version change | Correct source/estimate labels and no fabricated cash bill |
| Privacy | Secret in reason, credentialed reference, terminal controls | Bounded safe storage/display; no raw provider-output persistence |
| Eval fidelity | Evaluator receives two different routed allocations | Two different native model/effort argument sets executed |
| Eval population | Failures, abandonment, retries, zero completions | Full denominator; undefined/incomplete ratios labeled |
| Legacy | No controller config; Codex and Claude paths | Existing argv, bounds, source/environment checks preserved |
| Delivery | Profile validators, coverage, current-checkout E2E | Gates actually executable and evidenced |

## Evidence appendix

### Confirmed gate-profile validator failure

Command executed from the current repository root:

```sh
node scripts/ci/validate-no-personal-paths.js
```

Observed: exit 1, three personal-path errors, all in
`docs/workflows/two-agent-swe-workflow.md`. The offending locations are lines 5,
45, and 63. The exact private machine path is deliberately not reproduced here,
so this report does not introduce another validator violation.

### Confirmed descendant-survival probe

This benign probe launched only Node timers. Its final cleanup killed the surviving
descendant. It did not invoke a provider, mutate the repository, or run task code.

```sh
node -e 'const {spawnSync}=require("node:child_process"); const childCode="const p=require(\"node:child_process\").spawn(process.execPath,[\"-e\",\"setTimeout(()=>{},900)\"],{stdio:\"ignore\"});process.stdout.write(String(p.pid));setTimeout(()=>{},10000)"; const r=spawnSync(process.execPath,["-e",childCode],{encoding:"utf8",timeout:80,killSignal:"SIGKILL",maxBuffer:65536}); const pid=Number(r.stdout); let descendantSurvives=false; if(pid>0){try{process.kill(pid,0);descendantSurvives=true;process.kill(pid,"SIGKILL")}catch{}} process.stdout.write(JSON.stringify({signal:r.signal,error:r.error?.code,descendantSurvives})+"\n");'
```

Observed result:

```json
{"signal":"SIGKILL","error":"ETIMEDOUT","descendantSurvives":true}
```

The probe establishes a limitation of direct-child termination on the observed
runtime. It does not certify process-tree cancellation on macOS, Linux, or Windows,
nor prove that every real Codex timeout leaves a descendant.

### Native output and control documentation

Primary documentation was checked on the review date, after examining local code
and CLI help. Current documentation can differ from the pinned native versions;
live compatibility is still unobserved. The citations next to F07, F10, F11, and
F12 support the specific runtime distinctions made there, not a claim that all
current features are available on every supported CLI version.
