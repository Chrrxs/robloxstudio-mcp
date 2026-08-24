# tests/

Integration tests driving a live `@chrrxs/robloxstudio-mcp` subprocess via stdio MCP. Each test spawns its own subprocess and cleans up its state.

## Prerequisites
1. **Studio Plugin Installed.** Studio itself does not need to be open.
2. **Matching Port.** Ensure server and plugin use the same port (default `58741`). Override with `ROBLOX_STUDIO_PORT`.
3. **Built dist.** Run `npm run build` if `packages/robloxstudio-mcp/dist/index.js` is stale.
4. **`HttpEnabled = true`** in Studio Security Settings.

## Run

**Feature completion gate:** Features must pass `npm run test:e2e`.

```bash
# Required for every feature
npm run test:e2e

# Required before release (runs all live suites)
npm run test:e2e:full

# Full managed functional suite (no installer/lifecycle/isolation E2Es)
npm run test:studio:runner

# Reuse an existing instance for the functional suite
MCP_INSTANCE_ID=anon:... ROBLOX_STUDIO_PORT=43123 node tests/run-all.mjs

# Run an individual regression
node tests/execute-luau-error-preservation.mjs
```

| Change area | Required live command |
|---|---|
| Ordinary feature | `npm run test:e2e` |
| Paths, tools, runtime, multiplayer | `npm run test:studio:runner` |
| Installer, variants, versions | `npm run test:e2e` + `npm run test:e2e:auto-install` |
| Studio launch, lifecycle | `npm run test:e2e` + `npm run test:e2e:lifecycle` |
| Concurrent Studio isolation | `npm run test:e2e` + `npm run test:studio:parallel` |
| Release | `npm run test:e2e:full` |

### Managed Run Behavior
If `MCP_INSTANCE_ID` is unset, the runner launches a uniquely named baseplate, authorizes it, and manages its lifecycle. Supplying `MCP_INSTANCE_ID` reuses an existing instance and skips lifecycle calls.

Independent worktree workers receive leased ports and serialize destructive suites via cross-platform worktree leases to prevent race conditions.

### Codex Environment Regression
The non-destructive Codex/WSL wrapper test validates interop without launching Studio:
```bash
npm run build
npm run test:codex-wrapper
```

### Creator Store Sanitizer Unit Test
Tests the multi-pass asset sanitizer without requiring Studio:
```bash
npm run test:asset-security
```

## Tooling Smoke Tests
`tests/studio-tooling-smoke.mjs` verifies edit-mode tools (read, write, tag, execute). It auto-installs the plugin and launches a temporary place.
```bash
RSMCP_E2E_CLOSE_ALL_STUDIO=1 npm run test:studio:tools
```

## E2E: Auto-Install & Restart
`tests/auto-install-plugin-e2e.mjs` requires Studio to be closed. It installs variants, checks version metadata, and verifies mismatch warnings.
```bash
RSMCP_E2E_CLOSE_ALL_STUDIO=1 npm run test:e2e:auto-install
```

## E2E: Lifecycle Regressions
`tests/studio-lifecycle-regressions.mjs` tests fast relaunches and guarantees automatic takeover routing.
```bash
RSMCP_E2E_CLOSE_ALL_STUDIO=1 npm run test:e2e:lifecycle
```

Studio lifecycle helpers:
```bash
node scripts/studio-lifecycle.mjs status
RSMCP_E2E_CLOSE_ALL_STUDIO=1 node scripts/studio-lifecycle.mjs close-all
node scripts/studio-lifecycle.mjs launch
node scripts/studio-lifecycle.mjs wait-connected --variant main --version <version>
```

## Lifecycle and Cleanup
- Tests call `solo_playtest action=start` and cleanup with `solo_playtest action=stop`.
- Tests are non-destructive to persistent place state.
- `run-all.mjs` only closes the exact `launch_id` it spawned.
