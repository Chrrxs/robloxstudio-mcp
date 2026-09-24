# tests/

Integration tests that drive a live `@chrrxs/robloxstudio-mcp` subprocess via
stdio MCP, exercising real Studio behavior through the plugin. Each test
spawns its own subprocess and is responsible for cleaning up any playtest
state it starts.

## Prerequisites

1. **The built server dist** at `packages/robloxstudio-mcp/dist/index.js` —
   run `npm run build` when it is stale.
2. **Plugin build dependencies** under `studio-plugin/node_modules` — install
   them with `npm ci --prefix studio-plugin`. The managed Studio gates rebuild
   `studio-plugin/MCPPlugin.rbxmx` from the current worktree, then install that
   exact file into an isolated directory; they never download a published
   plugin as a fallback. Run `npm run build:plugin` before individual test
   scripts that reuse an already-open Studio instance.
3. **`HttpEnabled = true`** in Studio Experience Settings (Security tab).

## Run

GitHub Actions runs lint, typechecking, server builds, plugin compilation, and
`npm test` on Windows and Linux with Node 22. These checks do not launch Studio.
Core Jest tests use temporary, suite-specific managed-instance registries and
remove them after the run, so synthetic peers cannot alter a developer's registry.
The live gates below still require the dedicated Studio test profile.

**Feature completion gate:** a feature is not complete until
`npm run test:e2e` passes. This short gate exercises edit-mode tooling plus one
solo playtest covering edit, server, and client execution. Run the targeted
suite for any specialized area the feature changes.

```bash
# Required for every feature
npm run test:e2e

# Release gate; also run affected standalone transport probes listed below
npm run test:e2e:full

# Full managed functional suite, without installer/lifecycle/isolation E2Es
npm run test:studio:runner

# Run an individual regression through the same guarded profile
node scripts/studio-test-profile.mjs run -- tests/run-all.mjs --managed --test execute-luau-error-preservation.mjs
```

The full gate uses one prepared WTI snapshot. It runs functional coverage inside
the main matching auto-install session, then completes variant/mismatch checks,
process identity, lifecycle, and parallel isolation. It does not launch feature
smoke or another functional editor separately. On the current successful path
this schedules 23 Studio processes, including multiplayer servers and clients.
The runner stops at the first failure and reports remaining checks as not run.

| Change area | Required live command |
|---|---|
| Ordinary feature | `npm run test:e2e` |
| Paths, properties, tools, runtime, simulation, or multiplayer | `npm run test:studio:runner` (replaces the smaller feature gate) |
| Installer, package artifacts, variants, or version repair | Feature gate plus `npm run test:e2e:auto-install` |
| Studio launch, takeover, or startup-log lifecycle | Feature gate plus `npm run test:e2e:lifecycle` |
| Port allocation, worker directories, or concurrent Studio isolation | Feature gate plus `npm run test:studio:parallel` |
| Large Luau source staging, hash verification, ownership cleanup, or replay safety | `npm run test:studio:large-input-workflow` |
| Payload admission, property-size rejection, or native response boundaries | `npm run test:studio:payload-boundaries` |
| WebSocket progress, response loss/recovery, or multi-Studio capacity | `npm run test:studio:websocket-recovery` and `npm run test:studio:websocket-capacity` |
| Plugin reconnect, registration deadlines, or listener replacement | `npm run test:studio:websocket-reconnect` |
| Release | `npm run test:e2e:full`, plus affected standalone payload/WebSocket probes above |

When `MCP_INSTANCE_ID` is unset, the runner starts the built MCP server as the
required primary on the configured port and gives it a random, run-scoped auth
token. Through authenticated `POST /mcp/manage_instance` calls, it snapshots
managed launches, stages a uniquely named baseplate, launches it with retained
process identity, authorizes and completes the launch, and waits for its edit
connection. Every child test receives the same port, token, and returned
instance ID. The `finally` cleanup closes the exact `launch_id`; an indeterminate
HTTP launch response is reconciled against the pre-launch snapshot and staged
place path. Supplying `MCP_INSTANCE_ID` instead keeps the caller-owned instance
open and skips all launch lifecycle calls.

For a self-contained run of the complete managed functional suite, including
all edit, playtest, runtime, proxy, simulation, and multiplayer tests, use:

```bash
npm run test:studio:runner
```

WTI workers keep separate plugins, ports, working directories, and registries,
but the dedicated account's authentication and Studio installation are shared.
Public profile commands therefore use an account-global safety guard:

- Only one harness invocation may run per dedicated account. Concurrent commands
  are rejected, not queued for a later surprise launch. The explicit parallel
  isolation test still keeps two worker Studios open within its one invocation.
- Launch requests have a rolling budget of 10 native-process launch-cost units
  per 2 minutes. Multiplayer starts count
  the server and requested clients; adding players counts the additional
  clients. Solo play reuses its editor process. Engine-created children can
  still start together.
- Requests with available capacity dispatch without a fixed delay once the
  active launch lease is free. Otherwise, they wait before dispatch until enough
  cost reservations expire. The harness reports the requested cost, available
  units, and capacity wait duration on stderr. Waiting for admission does not
  retry a launch or consume its RPC timeout; each admitted operation dispatches
  only once. Capacity alone does not create a failure stop condition.
- Failed or interrupted runs leave a persistent stop condition across worktrees.
  Cleanup/status calls remain available; new launches do not. No automatic
  replacement launch or whole-suite retry is performed.

These are conservative harness limits, **not a documented Roblox threshold or
guarantee against rate limits**.
Use offline fixtures first and only the smallest affected live gate. Do not
repeat a full gate to turn a flaky result green. If Studio reports login,
rate-limit, or missing/corrupt-file errors, stop and address the environment
before attempting another launch. After checking the failure and confirming
owned Studio processes are closed, explicitly acknowledge recovery:

```bash
npm run studio:test-safety:reset -- --reason "Describe the checked failure and recovery"
```

Reset does not launch Studio, change credentials, or replenish the launch budget.
Existing `launch_budget` stop conditions from older harness versions also
require a reviewed explicit reset; waiting out the window does not clear them.
Use the public profile commands rather than direct internal test entrypoints so
these safeguards apply.

For installation failures, these fixed maintenance commands remain available
while the safety block is set:

```bash
npm run studio:test-diagnose
npm run studio:test-repair
```

When the account's updater explicitly requests a different channel, use that
observed channel for the one supervised repair attempt, for example:

```bash
npm run studio:test-repair -- --channel zbuck2release-739-control
```

Channel names are limited to 1–64 alphanumeric characters separated by hyphens.
Only the verified installer's `-channel <name>` switch is forwarded; arbitrary
installer flags, paths, and mixed repair/suite commands are rejected before
dispatch. Omitting `--channel` retains the official installer's zero-argument
default behavior.

Diagnosis reads a bounded installation inventory and redacted startup-log
indicators from the dedicated account; it launches no Studio process. Explicit
repair downloads the official Roblox Studio installer, checks its Windows
signature, and supervises one installation attempt under that same account.
It does not reset the safety block, delete authentication data, or launch a test.
Do not interrupt an active update merely because its original Studio process
exited: the installer may still be writing its version folder. Automatic
executable discovery rejects the newest folder if it contains a `.crdownload`
or lacks a nonempty `AppSettings.xml`, rather than silently launching an older
version and triggering another update.

Repair completion requires fresh installer success and a complete newest
installation. The newest executable is selected by modification time, not by
channel or semantic version. A default-channel downgrade can coexist with a
different channel's complete folder, so these checks alone do not prove that
the selected executable matches the account's requested version. Review the
fresh installer log's channel/version evidence against the diagnosed folder
before resetting safety or running the live gate; repair never resets that
state or automatically launches Studio to check it.

If a completed official repair leaves an old zero-byte download marker, first
let its supervisor finish and close dedicated-account Studio/installer processes.
After reviewing the diagnostic metadata and successful installer log, finalize
that exact completed attempt without downloading or launching anything:

```bash
npm run studio:test-repair -- --finalize-log RobloxStudioInstaller_A600A.log
```

Use the actual `RobloxStudioInstaller_HEX.log` basename, never a path.
Finalization and `--channel` are mutually exclusive. Under the maintenance
lease, finalization requires an idle account, a log less than one hour old with
both installer success and terminal thread completion, one version GUID, and no
terminal failure. It checks regular, nonempty executable/settings files and
quarantines only regular zero-byte `.crdownload` files older than the log's start.
Reparse points, new or nonempty markers, and changing evidence are rejected.
Markers are preserved in a unique profile-global maintenance quarantine, never
deleted; if normal unchanged executable discovery does not select the completed
target, moves are rolled back. Neither safety state nor launch quota is reset.

The Codex/WSL environment regression is non-destructive and does not launch
Studio. It starts the real source wrapper with `WSL_INTEROP` and
`WSL_DISTRO_NAME` removed, then verifies the broker's live lifecycle capability:

```bash
npm run build
npm run test:codex-wrapper
```

Each test prints `✅ PASSED` or `❌ FAILED` plus the failing assertion. On
failure the test's MCP subprocess stderr tail is dumped for context.

## Creator Store sanitizer unit test

The Creator Store import sanitizer has a separate Node-side behavioral suite
that does not require Studio. It covers 2,048-level nesting, Unicode and
zero-width names, `LuaSourceContainer`, `PackageLink`, preserved visual
instances, and fail-closed second-scan behavior:

```bash
npm run test:asset-security
```

## Managed runner profiles

`npm run test:studio:smoke` invokes `run-all.mjs --managed --smoke`; it runs the
representative live tests used by the feature gate. `npm run
test:studio:runner` omits `--smoke` and runs the functional regression set. Both
ignore inherited instance or Studio worker selection, lease an isolated port,
install the matching main plugin, and own the primary server and Studio
lifecycle.

## Release smoke: regular Studio tools

`tests/studio-tooling-smoke.mjs` is the focused release smoke for the normal
main-plugin edit-mode tool surface. It auto-installs the local main plugin,
launches a temporary place through `manage_instance`, and verifies read, write,
script, tag, attribute, and execute tools. It does not rerun `run-all.mjs`.
Both managed runner profiles execute these assertions inside their existing
Studio session, avoiding a second install and launch. The focused command
remains available for iteration:

```bash
npm run test:studio:tools
```

## Release E2E: auto-install + Studio restart

`tests/auto-install-plugin-e2e.mjs` installs the main and inspector plugins into
its isolated worker directory, launches Studio through `manage_instance`, checks
version/variant metadata and mismatch rejection, and closes only its explicitly
owned launches before removing the worker directory.
Its subprocess runner bypasses the Windows `npm.cmd`/`npx.cmd` shims and invokes
their Node CLI entry points directly. It drains output through process close,
terminates the whole process tree on timeout, and turns pre-exit spawn failures
into immediate, causal errors instead of waiting indefinitely.

```bash
npm run test:e2e:auto-install
```

## Lifecycle regressions: same-place process coexistence and edit startup logs

`tests/studio-lifecycle-regressions.mjs` launches the same unpublished local
place twice with one persisted anonymous place key. It force-closes the first
Studio process, holds its stale Peer transport open, and verifies that the
replacement registers immediately as a distinct process Instance. The test
then routes explicitly to the replacement. A temporary repro plugin also emits
errors before the MCP plugin installs its log listener so the test can verify
current-launch history seeding and prior-launch exclusion.

```bash
npm run test:e2e:lifecycle
```

The E2E defaults to freshly built local packed tarballs and prints
`artifactSource: local-pack`, so unpublished changes are what reach Studio.
Set `RSMCP_E2E_ARTIFACT_SOURCE=latest` to test the published release instead.
The launch manager must advertise the current worker-job containment capability
before any Studio process is created. Older published artifacts without it are
rejected; use local worktree artifacts rather than running without containment.
The self-contained auto-install, lifecycle, and tooling commands each lease an
open port and install a plugin configured for that port, so an unrelated MCP
server on the default port does not block targeted or full verification.
These public commands use the dedicated test account and close only their owned
Studio launches. They do not require a close-all opt-in or closing personal Studio.

Diagnostic helpers remain available directly; launches require the guarded profile:

```bash
node scripts/studio-lifecycle.mjs status
node scripts/studio-test-profile.mjs run -- scripts/studio-lifecycle.mjs launch
node scripts/studio-lifecycle.mjs wait-connected --variant main --version <expected-version>
```

## What each test exercises

| File | What it checks |
|---|---|
| `studio-websocket-reconnect.mjs` | Replaces the owned bridge process on its isolated port and injects stale registration, held `/ready`, silent upgrade, and between-registration-and-upgrade loss. Repeats faults through a full solo Play cycle and verifies edit/server/client tool round-trips. Run with `npm run test:studio:websocket-reconnect`. |
| `codex-wsl-environment.mjs` | The supported Codex wrapper validates Windows interop and advertises the retained process-identity launcher from a sanitized WSL environment without launching Studio |
| `eval-bridge-error-preservation.mjs` | `eval_server_runtime` / `eval_client_runtime` surface actual user errors instead of Roblox's generic `"Requested module experienced an error while loading"` wrapper for explicit errors, nil derefs, parser errors, and nested `require()` module-load failures |
| `eval-context-routing.mjs` | `execute_luau target=server/client-N` runs in plugin context on the selected peer, while `eval_server_runtime` / `eval_client_runtime` run through the server Script and client LocalScript eval bridges |
| `runtime-bridge-lifecycle.mjs` | Runtime eval bridges stay out of edit mode, managed and manually-started solo Peers share one process Instance, and a managed Multiplayer Group returns isolated per-process logs without synthetic Peer attribution |
| `execute-luau-error-preservation.mjs` | `execute_luau` surfaces user error messages, parser errors, and nested `require()` module-load failures without leaking plugin-internal paths or Roblox's generic module-load wrapper |
| `proxy-mode-peer-fanout.mjs` | A proxy-mode subprocess discovers nested Instance/Peer topology, reads an exact process log buffer, and fans a Peer-scoped memory request through the primary |
| `execute-luau-output-capture.mjs` | `execute_luau target=server` captures user `print()` and `warn()` calls in the response `output` array, matching the `target=edit` baseline; live structured `LogService` context is returned as `get_runtime_logs` entry `data` |
| `multiplayer-add-player-end-regression.mjs` | Starts one multiplayer client, adds a second client, and verifies `EndTest` disconnects both runtime peers |
| `multiplayer-test-lifecycle.mjs` | `multiplayer_test_start`, add-player, client-leave, state, and end-test flow against real StudioTestService multiplayer peers |

## Lifecycle and cleanup

- Most tests call `solo_playtest action=start` once at the top and `solo_playtest action=stop` in a
  `finally` block. The multiplayer lifecycle test uses `multiplayer_test_*`
  lifecycle tools and performs best-effort end-test cleanup in its `finally` block.
- Tests do not modify the place's persistent state — they only print, eval,
  and read from the runtime log buffer.
- `run-all.mjs` closes only the exact managed `launch_id` it created; a
  supplied `MCP_INSTANCE_ID` remains caller-owned and is not closed.
- Each owned worker retains a separate Windows job across Studio launch,
  authorization, and release. Helpers remain owned even after Studio exits.
  Cleanup allows an owned installer up to ten minutes to finish, then terminates
  remaining worker-job members and confirms they have exited before removing
  the directory. An unconfirmed drain leaves the directory intact and fails.
  This never performs account-wide process-name kills.
- The outer harness also allows owned installers to finish after an ordinary
  harness exit. Explicit cancellation still closes containment immediately.
- To exercise worker cleanup without Studio, run
  `npm run test:studio-worker-native` from native Windows Node/npm. It builds
  the core and runs controlled Node fixtures for orphaned helpers, installer
  completion, and isolation from unrelated processes.

## Layout

- `lib/mcp-client.mjs` — shared utility for spawning + driving subprocesses
  via stdio JSON-RPC, plus minimal assertion helpers.
- `lib/mcp-http-client.mjs` — explicit-token authenticated direct calls to
  `/mcp/<tool>`, including structured HTTP/tool error handling.
- `lib/large-input-workflow.mjs` — shared Luau step generator for the
  [documented large-input workflow](../docs/large-inputs.md) and its native regression.
- `lib/managed-studio-session.mjs` — owned-primary launch, process-identity
  handoff, lost-response reconciliation, reuse, and strict cleanup.
- `lib/studio-test-lease.mjs` — heartbeating, stale-owner-aware serialization
  and crash-recoverable plugin backups for parallel WSL/Windows worktrees.
- `<feature>.mjs` — one test file per concern, each runnable directly with
  `node`.
- `run-all.mjs` — manages a baseplate and runs the live suite sequentially.
