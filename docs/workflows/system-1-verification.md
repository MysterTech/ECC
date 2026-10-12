# System 1 ECC verification record

Status: design revision, 2026-10-11. No controller implementation or native model
certification exists. This records evidence and required validation, not a custom
workflow gate profile or approval prerequisite.

Use ECC planning, TDD and applicable code-quality/security reviews under the current
AGENTS instructions. The custom two-agent workflow is retired. Read the
[design](../design/system-1-controller.md) and
[protocol](../design/system-1-controller-protocol.md) together before planning.

## Scope and environment

First slice: JavaScript asynchronous allocation dispatcher, explicit Codex/Claude
root launches, dedicated SQLite allocation state, checkpoints, subscription
continuation and recovery. No UI, Rust, provider-home installation or live
economics experiment. The v3 design extends the original Codex-only slice.

Observed local baseline: macOS, Node 26.8.1, npm 11.19.0, Codex CLI 0.155.1 and
Claude Code 2.1.261. CI tests Node 18/20/22 on macOS/Linux/Windows. The old local
runtime is evidence of one environment, not certification of those CI combinations.
Record actual runtime versions again when implementation begins.

Locked dependencies are now installed in the current checkout using
`npm ci --ignore-scripts --no-audit --no-fund --offline` (exit 0, 220 packages).
The earlier design-only checks below predate that installation. Preserve lockfiles;
their prior unavailability is historical, not an outstanding execution blocker.

## Executed command evidence

Run commands from repository root. Historical results below came from the previous
checkout before this controller existed. They are regression starting points, not
current-checkout or new-controller results.

| Previously exercised command | Historical result |
| --- | --- |
| `node --test tests/lib/context-profile-launch.test.js tests/lib/context-profile-auto-launch.test.js tests/lib/context-selection.test.js tests/lib/state-store.test.js` | 66 passing Node results; store runner also reported 20 internal checks, not 20 additional Node tests |
| `node --test tests/lib/context-profile-proposal.test.js tests/lib/context-selection-admission.test.js` | 13 passing proposal/admission results |
| `./node_modules/.bin/eslint scripts/lib/context-profile-launch.js scripts/lib/context-profile-proposal.js scripts/lib/state-store` | Exit 0, two pre-existing complexity warnings |
| `./node_modules/.bin/markdownlint docs/design/context-profile-delivery.md docs/design/context-profiles.md` | Exit 0 |
| `npm test` | Interrupted after loopback/home-isolation failures; no passing full-suite baseline |

Focused baseline logs were named system1-focused-baseline.log,
system1-routing-baseline.log, system1-combined-baseline.log and
system1-full-baseline.log in the previous project's private work directory. Their
personal machine location is not part of this portable record. An existing test
rewrote yarn.lock; it was restored and no baseline lockfile change was retained.

Current revision observations:

| Command/check | Observation |
| --- | --- |
| `npm run coverage` | Exit 127: c8 missing; no suite or coverage measurement began |
| `./node_modules/.bin/markdownlint docs/design/system-1-controller.md docs/design/system-1-controller-protocol.md docs/design/system-1-controller-review-resolution.md docs/workflows/two-agent-swe-workflow.md` | Exit 127: local binary missing; no documents checked by this invocation |
| `node scripts/ci/validate-no-personal-paths.js` | Exit 0 after revision; original review's three old-profile errors resolved |
| `node scripts/ci/check-unicode-safety.js` | Exit 0 in current revision |
| `node scripts/ci/validate-context-profiles.js` | Exit 1 in current checkout: js-yaml missing; historical declaration success is not current validation |
| `npm run catalog:check` | Exit 0 in current revision; counts match |
| `npm run command-registry:check` | Exit 0 in current revision; registry current |
| `git diff --check` | Exit 0; untracked-document whitespace separately checked |

Implementation preflight on the current checkout:

| Command/check | Observation |
| --- | --- |
| `npm ci --ignore-scripts --no-audit --no-fund --offline` | Exit 0; local locked dependencies installed without lifecycle scripts or network fetches |
| `node --test tests/lib/context-profile-launch.test.js tests/lib/context-profile-auto-launch.test.js tests/lib/context-selection.test.js tests/lib/state-store.test.js tests/lib/context-profile-proposal.test.js tests/lib/context-selection-admission.test.js` | Exit 0; 79 Node results, including the store runner's 20 internal checks |
| Bounded loopback bind on 127.0.0.1 with ephemeral port | Sandbox denied bind; approved local-test execution succeeded and closed the socket |
| Isolated `node tests/run-all.js` | Running with private temporary home/config/cache directories and inherited provider credentials/configuration removed; result not yet recorded |

The feature branch is `codex/system1-failover`. The working-tree baseline before
implementation has no tracked product changes; design artifacts remain untracked.

The controller may use the prior checkout's existing markdownlint binary to check
these documents without installing anything. Record that borrowed-tool result
separately; it does not make the unavailable local binary executable. This revision
checked the design, protocol, resolution, this record and retirement note with that
borrowed binary: exit 0. A bounded local Markdown-link/anchor and whitespace check
also passed for all five revised documents (52 relative links).

## Implementation verification requirements

Before writing the implementation plan's test code, execute the actual target
tests, observe helpers/selectors and enumerate call sites. Prior observed fixture
names include withFixture, nativeFixture and skill:feature; validate their current
signatures rather than copying hypothetical test code. New filenames and command
lines must be checked empirically when introduced.

Use real behavioral RED/GREEN for production changes. Acceptance includes unit
policy/transport validation, integration store/reopen/race/recovery cases and
outer-CLI E2E with injected providers and --input -. Independently review code
against the on-disk contract and check test quality. Verify 80%+ lines/functions/
branches/statements using the repository's coverage command; unavailable c8 is
unmeasured coverage, not a waiver or a failed percentage.

Refresh locked dependencies and rerun relevant focused regressions in the current
checkout during implementation. Pure fixture tests and source validators can be
delegated. The controller owns tests involving a user database/home, external
service, real provider or environment permissions. Inspect fixture isolation before
broadening test scope.

The previous full-suite run hit listen EPERM for loopback servers and EPERM while
tests attempted learned-skill directories in the real Claude home. It was stopped.
Before full-suite/coverage execution, provide validated dedicated test homes and
necessary loopback access, and exercise that environment once. Do not rerun against
the real provider home or treat an environment error as a controller regression.
Record any remaining blocker explicitly; no green full-suite claim currently exists.

Review additive migrations, existing-data preservation, read-only status, pure
dry-run and independent-handle/process contention. Include lost-result/commit/
lock-release windows and phase-specific fallback/recovery. Check unconfigured
Codex/Claude/profile regressions. No Rust verification is claimed: if scope crosses
into ECC2, update the design first and exercise the other language's suite.

## Isolation, runtime evidence and records

No application stack needs seeding. Use temporary fixture repositories, injected
provider processes and private temporary SQLite files. Choose an explicit private
run directory outside the repository for logs/diffs when implementation starts;
record its path in local run metadata rather than public docs. No custom WIP-ref
namespace, Sonnet/Opus lane or gate-profile sign-off is required.

Codex help inspection confirms argument availability only. Native provider version,
model/effort support, actual root JSONL transport, requested/effective identities
and economics remain unobserved. Live runs and credential/provider configuration
are separately scoped work; mocks never certify native execution or savings.

Visual QA is N/A because this slice has no UI. Record actual implementation results
in docs/workflows/system-1-controller-qa.md when that work occurs; do not create a
passing QA record from design assertions. Keep design-first sequencing, concise
conventional commits and explicit staging. This documentation pass makes no commit,
push, installation or provider configuration change.
