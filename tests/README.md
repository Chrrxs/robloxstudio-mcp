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

**Feature completion gate:** a feature is not complete until
`npm run test:e2e` passes. This short gate exercises edit-mode tooling plus one
solo playtest covering edit, server, and client execution. Run the targeted
suite for any specialized area the feature changes.

```bash
# Required for every feature
npm run test:e2e

# Required before release; runs every live Studio suite
npm run test:e2e:full

# Full managed functional suite, without installer/lifecycle/isolation E2Es
npm run test:studio:runner

# Reuse a specific already-connected instance for the full functional suite
MCP_INSTANCE_ID=anon:... ROBLOX_STUDIO_PORT=43123 node tests/run-all.mjs

# Run an individual regression while iterating
node tests/execute-luau-error-preservation.mjs
```

The full gate does not launch the feature smoke separately: its complete
functional runner covers those checks in the same Studio session before the
independent auto-install, lifecycle, and parallel-isolation suites.

| Change area | Required live command |
|---|---|
| Ordinary feature | `npm run test:e2e` |
| Paths, properties, tools, runtime, simulation, or multiplayer | `npm run test:studio:runner` (replaces the smaller feature gate) |
| Installer, package artifacts, variants, or version repair | Feature gate plus `npm run test:e2e:auto-install` |
| Studio launch, takeover, or startup-log lifecycle | Feature gate plus `npm run test:e2e:lifecycle` |
| Port allocation, worker directories, or concurrent Studio isolation | Feature gate plus `npm run test:studio:parallel` |
| Release | `npm run test:e2e:full` (replaces all commands above) |

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

Independent worktree workers receive distinct leased ports instead of
accidentally proxying through each other's servers. Roblox Studio processes and
the installed plugin folder are global to the OS user, so destructive live
suites also take a cross-platform, heartbeating worktree lease. Multiple
worktrees may start the commands together; one waits while the other owns that
global mutation boundary, preventing plugin backup/restore and close-all races.
The lease keeps durable copies of the installed plugins and lifecycle fixture,
so a successor restores them before proceeding even if the prior test process
was killed.

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
two representative live tests used by the feature gate. `npm run
test:studio:runner` omits `--smoke` and runs all twelve functional tests. Both
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
RSMCP_E2E_CLOSE_ALL_STUDIO=1 npm run test:studio:tools
```

## Release E2E: auto-install + Studio restart

`tests/auto-install-plugin-e2e.mjs` is a destructive release verification that
requires Studio to be closed first, installs the main and inspector plugins,
launches Studio through `manage_instance`, checks version/variant metadata,
verifies mismatch warnings, closes the explicit launched `instance_id`, and
restores the original plugin files.
Its subprocess runner bypasses the Windows `npm.cmd`/`npx.cmd` shims and invokes
their Node CLI entry points directly. It drains output through process close,
terminates the whole process tree on timeout, and turns pre-exit spawn failures
into immediate, causal errors instead of waiting indefinitely.

```bash
RSMCP_E2E_CLOSE_ALL_STUDIO=1 npm run test:e2e:auto-install
```

## Lifecycle regressions: fast relaunch and edit startup logs

`tests/studio-lifecycle-regressions.mjs` launches the same unpublished local
place twice with a persisted anonymous instance ID. It force-closes the first
Studio process, guarantees that the replacement receives an initial duplicate
409, and verifies automatic takeover and edit-tool routing. A temporary repro
plugin also emits errors before the MCP plugin installs its log listener so the
test can verify current-launch history seeding and prior-launch exclusion.

```bash
RSMCP_E2E_CLOSE_ALL_STUDIO=1 npm run test:e2e:lifecycle
```

The E2E defaults to freshly built local packed tarballs and prints
`artifactSource: local-pack`, so unpublished changes are what reach Studio.
Set `RSMCP_E2E_ARTIFACT_SOURCE=latest` to test the published release instead.
The self-contained auto-install, lifecycle, and tooling commands each lease an
open port and install a plugin configured for that port, so an unrelated MCP
server on the default port does not block targeted or full verification.
All destructive E2Es still require no Studio windows to be open and the
close-all environment variable remains an explicit opt-in.

Studio lifecycle helpers are available directly:

```bash
node scripts/studio-lifecycle.mjs status
RSMCP_E2E_CLOSE_ALL_STUDIO=1 node scripts/studio-lifecycle.mjs close-all
node scripts/studio-lifecycle.mjs launch
node scripts/studio-lifecycle.mjs wait-connected --variant main --version <expected-version>
```

## What each test exercises

| File | What it checks |
|---|---|
| `codex-wsl-environment.mjs` | The supported Codex wrapper validates Windows interop and advertises the retained process-identity launcher from a sanitized WSL environment without launching Studio |
| `eval-bridge-error-preservation.mjs` | `eval_server_runtime` / `eval_client_runtime` surface actual user errors instead of Roblox's generic `"Requested module experienced an error while loading"` wrapper for explicit errors, nil derefs, parser errors, and nested `require()` module-load failures |
| `eval-context-routing.mjs` | `execute_luau target=server/client-N` runs in plugin context on the selected peer, while `eval_server_runtime` / `eval_client_runtime` run through the server Script and client LocalScript eval bridges |
| `runtime-bridge-lifecycle.mjs` | Runtime eval bridges are created inside play DataModels, stay out of edit mode, work for managed and manually-started playtests, and direct multiplayer logs get peer attribution |
| `execute-luau-error-preservation.mjs` | `execute_luau` surfaces user error messages, parser errors, and nested `require()` module-load failures without leaking plugin-internal paths or Roblox's generic module-load wrapper |
| `proxy-mode-peer-fanout.mjs` | `get_runtime_logs target=all`, `get_connected_instances`, and `get_memory_breakdown target=all` return non-empty capture/peer data when invoked from a proxy-mode subprocess (the multi-session path) |
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

## Layout

- `lib/mcp-client.mjs` — shared utility for spawning + driving subprocesses
  via stdio JSON-RPC, plus minimal assertion helpers.
- `lib/mcp-http-client.mjs` — explicit-token authenticated direct calls to
  `/mcp/<tool>`, including structured HTTP/tool error handling.
- `lib/managed-studio-session.mjs` — owned-primary launch, process-identity
  handoff, lost-response reconciliation, reuse, and strict cleanup.
- `lib/studio-test-lease.mjs` — heartbeating, stale-owner-aware serialization
  and crash-recoverable plugin backups for parallel WSL/Windows worktrees.
- `<feature>.mjs` — one test file per concern, each runnable directly with
  `node`.
- `run-all.mjs` — manages a baseplate and runs the live suite sequentially.
