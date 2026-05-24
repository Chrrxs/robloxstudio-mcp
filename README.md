# Roblox Studio MCP Server

**Connect AI assistants like Claude and Gemini to Roblox Studio. Per-peer `execute_luau` and `stop_playtest` actually work.**

[![NPM Version](https://img.shields.io/npm/v/@chrrxs/robloxstudio-mcp)](https://www.npmjs.com/package/@chrrxs/robloxstudio-mcp)

> This is a fork of [boshyxd/robloxstudio-mcp](https://github.com/boshyxd/robloxstudio-mcp) v2.7.0 with four plugin-side fixes baked in. The fixes target Roblox engine constraints around per-peer HTTP access and cross-DataModel signaling that the upstream plugin didn't account for.

## Why you should use this over other MCP servers

Two independent Roblox Studio MCP servers exist today: the [official Roblox one](https://create.roblox.com/docs/studio/mcp) and [boshyxd's](https://github.com/boshyxd/robloxstudio-mcp). This package is a fork of boshyxd's, picking up his 43-tool surface (now 46 tools with v2.11.0's `export_rbxm`, `import_rbxm`, and `get_memory_breakdown`) and adding the playtest-driving pieces that neither alternative ships out of the box.

What you get here that you don't get from either of those:

1. **46-tool surface** — boshyxd's original 43 plus this fork's `export_rbxm` / `import_rbxm` (`SerializationService` round-trip) and `get_memory_breakdown` (per-peer `Stats` snapshot). Full file-tree browsing, mass property reads/writes, script search-and-replace, attribute/tag management, build import/export, asset insertion, screenshot capture, ScriptEditorService integration, .rbxm bundling, runtime memory inspection. The official Roblox MCP exposes a much smaller surface.
2. **Game-VM eval bridges for playtest debugging** — `eval_server_runtime` and `eval_client_runtime` run inside the running game's Script / LocalScript VMs, not a sandboxed plugin VM. This is the only way to inspect runtime-mutated module state during a playtest (e.g., a networking lib's cached counters, an ECS world's tick state, a datastore wrapper's batch queue). Both the official MCP's `execute_luau` and boshyxd's `execute_luau target=client-N` run in isolated VMs where `require(SomeModule)` returns a fresh table every call. Bridge scripts are ported from [chrrxs/roblox-mcp-primitives](https://github.com/Chrrxs/roblox-mcp-primitives), auto-installed at `start_playtest`, auto-removed at `stop_playtest`. Zero manual setup.
3. **Auto-connect across every DataModel** — boshyxd's plugin only registers with MCP when you click a button in its dock widget, but that widget is *invisible in play DMs*, so `target=server` and `target=client-N` never worked out of the box. This fork auto-activates on plugin load in every DM (edit, play server, every play client), uses a server-peer broker to route `target=client-N` past the engine's "client can't `HttpService:RequestAsync`" restriction, and adds an edit-proxy so `stop_playtest` calls `StudioTestService:EndTest` from the play server DM where it's actually legal.

If you only need to read scripts and inspect static instance trees, the official Roblox MCP is fine. If you need to drive a *running* game from an AI agent — start playtests, inspect peer-specific state, mutate live globals, end playtests cleanly — this is the only one that ships those workflows working out of the box.

## Fork fixes

| # | Bug upstream | Fix in this fork |
|---|---|---|
| 1 | `detectRole` uses `IsRunMode()`, so every play-mode peer reports as `edit` | One-line swap to `IsRunning()` in `Communication.ts:21` |
| 2 | Plugin only registers with MCP when user clicks Connect - invisible in play DMs | Auto-activate on load via `task.delay(2, ...)` orchestrator in `server/index.server.ts` |
| 3 | `target=client-N` is structurally impossible - client peer can't `HttpService:RequestAsync` | Server-peer **broker pattern**: per-player proxies registered with role=`client`, dispatched via `ReplicatedStorage.__MCPClientBroker` `RemoteFunction:InvokeClient` ([ClientBroker.ts](studio-plugin/src/modules/ClientBroker.ts)) |
| 4 | `stop_playtest` warns `__MCP_STOP__` hoping a `LogService.MessageOut` listener catches it - never works cross-DM | Server-peer **edit-proxy** registered with role=`edit-proxy`. MCP routes `/api/stop-playtest` to it exclusively so it can call `StudioTestService:EndTest` from the play server DM. Edit DM only handles stop as a "no active playtest" fallback (v2.8.1 fix) |

All four are implemented in TypeScript under [studio-plugin/src/](studio-plugin/src/). The compiled `MCPPlugin.rbxmx` is attached to GitHub releases.

## New in v2.9.0: game-VM eval bridges

`execute_luau target=server/client-N` runs in the plugin VM with a fresh `ModuleScript` each call — clean isolation, but means `require(SomeModule)` returns a fresh table, so runtime-mutated module state in the user's game scripts is invisible. The new `eval_server_runtime` / `eval_client_runtime` tools fix that by routing through bridge scripts (ported from [chrrxs/roblox-mcp-primitives](https://github.com/Chrrxs/roblox-mcp-primitives)) that the plugin auto-installs at `start_playtest` and removes at `stop_playtest`.

| Tool | Runs in | Shares require cache with | Needs LoadStringEnabled? |
|---|---|---|---|
| `execute_luau target=server` | Server peer plugin VM | None (fresh per call) | No |
| `eval_server_runtime` | Server peer **Script VM** | Running game's server scripts | No (v2.10.1+) |
| `execute_luau target=client-N` | Client peer plugin VM | None (fresh per call) | No |
| `eval_client_runtime` | Client peer **LocalScript VM** | Running game's LocalScripts | No |

Use the new tools when you need to inspect runtime-mutated module state (e.g., a `Net` library's cached internal counters). Use the originals when you want a clean sandbox or no playtest is running.

## New in v2.10.0: cross-peer runtime log capture + auto-reconnect

`get_runtime_logs` reads an in-memory ring buffer the plugin maintains on every peer's `LogService.MessageOut`. Each peer (edit, server, every client) gets its own 64 KB buffer with drop-oldest semantics, so the recent tail is always available — fixing the official Roblox MCP's `get_console_output` 10 KB drop-newest cap (loses recent messages after a busy boot) and boshyxd's `get_playtest_output` cross-peer routing issues. Default `target=all` fans out to every peer, merges by timestamp, and dedups same-message entries captured within a 2 s window across different peers (LogService reflects prints across DMs in Studio Play). Incremental polling via `since` returns only new entries.

Same release fixes a long-standing reconnect issue: when the MCP server process restarts (e.g., Claude Code reconnects mid-session), the plugin now auto re-registers with the new server within ~500 ms via a `knownInstance` poll-response signal. No more manual Disconnect+Connect button-clicking in the plugin dock widget.

`client-N` allocation is also now stateless lowest-unused — the first connected client is always `client-1` regardless of how many playtest cycles or Claude restarts you've done since. Verification recipes can hardcode `target=client-1`.

## New in v2.11.0: `export_rbxm` / `import_rbxm` and `get_memory_breakdown`

**`export_rbxm` / `import_rbxm`** wrap engine v668's `SerializationService:SerializeInstancesAsync` / `DeserializeInstancesAsync` (PluginSecurity). `export_rbxm` serializes DataModel paths to a `.rbxm` on disk; `import_rbxm` reads bytes (local path, URL, or inline base64), deserializes, and parents the result under a chosen instance. Parenting is all-or-nothing — partial imports roll back. `target=edit` wraps the import in `ChangeHistoryService:TryBeginRecording` so one Ctrl+Z reverses the bundle. Non-creatable instances and services are rejected by the engine itself; the plugin surfaces the engine's error verbatim. No `read_rbxm_metadata` tool — the `.rbxm` format has no stability contract outside `DeserializeInstancesAsync`.

**`get_memory_breakdown`** iterates `Enum.DeveloperMemoryTag` and calls `Stats:GetMemoryUsageMbForTag` per item, returning a per-peer `{ total_mb, categories, timestamp }`. `target=all` (default) fans out to every connected peer except `edit-proxy`, including clients via an added `ClientBroker` route. The per-tag loop is the workaround for `Stats:GetMemoryUsageMbAllCategories` being gated by `Capabilities: InternalTest` and therefore not callable from plugin context — `GetMemoryUsageMbForTag` is `Security: None` and works. In Studio Play mode all three peers (edit/server/client-N) share one OS process and report identical totals; in `mode=run` or Team Test the numbers diverge.

## New in v2.10.1: `eval_server_runtime` no longer needs `LoadStringEnabled`

The server eval bridge now uses the same `ModuleScript + require` shape as the client bridge, removing the dependency on `ServerScriptService.LoadStringEnabled`. `eval_server_runtime` works in fresh places out of the box (LoadStringEnabled defaults to false). Require-cache sharing with the running server's Scripts is unchanged.

---

## Setup

1. Install the [Studio plugin](https://github.com/chrrxs/robloxstudio-mcp/releases) to your Plugins folder (or run `npx -y @chrrxs/robloxstudio-mcp@latest --install-plugin`)
2. Enable **Allow HTTP Requests** in Experience Settings > Security
3. Connect your AI:

> **Custom Plugins folder?** Set `MCP_PLUGINS_DIR` before running `--install-plugin` to override the auto-detected path (custom Studio install, network share, etc.). Works on Windows, macOS, and WSL.
>
> ```bash
> MCP_PLUGINS_DIR='/path/to/Roblox/Plugins' npx -y @chrrxs/robloxstudio-mcp@latest --install-plugin
> ```

**Claude Code:**
```bash
claude mcp add robloxstudio -- npx -y @chrrxs/robloxstudio-mcp@latest
```

**Codex CLI:**
```bash
codex mcp add robloxstudio -- npx -y @chrrxs/robloxstudio-mcp@latest
```

**Gemini CLI:**
```bash
gemini mcp add robloxstudio npx --trust -- -y @chrrxs/robloxstudio-mcp@latest
```

Plugin shows "Connected" when ready.

<details>
<summary>Other MCP clients (Claude Desktop, Cursor, etc.)</summary>

```json
{
  "mcpServers": {
    "robloxstudio-mcp": {
      "command": "npx",
      "args": ["-y", "@chrrxs/robloxstudio-mcp@latest"]
    }
  }
}
```

**Windows users:** If you encounter issues, use `cmd`:
```json
{
  "mcpServers": {
    "robloxstudio-mcp": {
      "command": "cmd",
      "args": ["/c", "npx", "-y", "@chrrxs/robloxstudio-mcp@latest"]
    }
  }
}
```
</details>

## What Can You Do?

Ask things like: *"What's the structure of this game?"*, *"Find scripts with deprecated APIs"*, *"Create 50 test NPCs in a grid"*, *"Optimize this movement code"*

<details>
<summary><strong>Inspector Edition (Read-Only)</strong></summary>

### robloxstudio-mcp-inspector

[![NPM Version](https://img.shields.io/npm/v/@chrrxs/robloxstudio-mcp-inspector)](https://www.npmjs.com/package/@chrrxs/robloxstudio-mcp-inspector)

A lighter, **read-only** version that only exposes inspection tools. No writes, no script edits, no object creation/deletion. Ideal for safely browsing game structure, reviewing scripts, and debugging without risk of accidental changes.

**33 read-only tools:** `get_file_tree`, `search_files`, `get_place_info`, `get_services`, `search_objects`, `get_instance_properties`, `get_instance_children`, `search_by_property`, `get_class_info`, `get_project_structure`, `mass_get_property`, `get_script_source`, `grep_scripts`, `get_attributes`, `get_tags`, `get_tagged`, `get_selection`, `get_playtest_output`, `get_connected_instances`, `get_descendants`, `compare_instances`, `get_output_log`, `export_build`, `list_library`, `search_materials`, `get_build`, `search_assets`, `get_asset_details`, `get_asset_thumbnail`, `preview_asset`, `capture_screenshot`, `export_rbxm`, `get_memory_breakdown`

**Setup** - same plugin family, different rbxmx file. Install **only one variant at a time** - having `MCPPlugin.rbxmx` and `MCPInspectorPlugin.rbxmx` in `Plugins/` simultaneously causes double-registration with the MCP server and breaks per-peer routing. Use `--replace-variant` to swap atomically:

```bash
npx -y @chrrxs/robloxstudio-mcp-inspector@latest --install-plugin --replace-variant
```

Then wire up your MCP client:

**Claude:**
```bash
claude mcp add robloxstudio-inspector -- npx -y @chrrxs/robloxstudio-mcp-inspector@latest
```

**Codex:**
```bash
codex mcp add robloxstudio-inspector -- npx -y @chrrxs/robloxstudio-mcp-inspector@latest
```

**Gemini:**
```bash
gemini mcp add robloxstudio-inspector npx --trust -- -y @chrrxs/robloxstudio-mcp-inspector@latest
```

<details>
<summary>Other MCP clients (Claude Desktop, Cursor, etc.)</summary>

```json
{
  "mcpServers": {
    "robloxstudio-mcp-inspector": {
      "command": "npx",
      "args": ["-y", "@chrrxs/robloxstudio-mcp-inspector@latest"]
    }
  }
}
```

**Windows users:** If you encounter issues, use `cmd`:
```json
{
  "mcpServers": {
    "robloxstudio-mcp-inspector": {
      "command": "cmd",
      "args": ["/c", "npx", "-y", "@chrrxs/robloxstudio-mcp-inspector@latest"]
    }
  }
}
```
</details>

</details>

---

<!-- VERSION_LINE -->
**v2.11.0** - based on boshyxd v2.7.0 + four plugin-side fixes + SerializationService round-trip + per-peer memory snapshots

## Building & releasing

```bash
# Install all workspaces + the studio-plugin TS toolchain
npm install
cd studio-plugin && npm install && cd ..

# Build node packages (core, mcp, inspector)
npm run build

# Compile the Studio plugin TS to Luau, then assemble the rbxmx
cd studio-plugin && npm run build && cd ..
node scripts/build-plugin.mjs                       # produces studio-plugin/MCPPlugin.rbxmx
node scripts/build-plugin.mjs --variant inspector   # produces studio-plugin/MCPInspectorPlugin.rbxmx
```

On WSL the rbxmx is auto-installed into `/mnt/c/Users/<you>/AppData/Local/Roblox/Plugins/`. Set `MCP_PLUGINS_DIR` to override.

After a code change, **fully close and reopen Roblox Studio** for the new plugin to load (Studio caches plugin Scripts across `Plugins/` mtime).

### Releasing

1. Bump `version` in the four `package.json` files (root + 3 workspaces) in lockstep.
2. `cd studio-plugin && npm run build && cd .. && node scripts/build-plugin.mjs && node scripts/build-plugin.mjs --variant inspector` to produce both rbxmx files.
3. `npm publish --access public -w packages/robloxstudio-mcp -w packages/robloxstudio-mcp-inspector` (core is `private: true`-style internal, but currently published as a regular dep - flip it to `private: true` in `packages/core/package.json` if you don't want it on npm).
4. Cut a GitHub release on `chrrxs/robloxstudio-mcp` tagged `v<version>` with `MCPPlugin.rbxmx` and `MCPInspectorPlugin.rbxmx` attached so `--install-plugin` finds them.

### Verification recipe (against a running Studio)

```text
mcp__Roblox_Studio__execute_luau target=edit                # baseline
mcp__Roblox_Studio__start_playtest mode=play numPlayers=1   # wait ~10s
mcp__Roblox_Studio__get_connected_instances                 # expect edit + server + client-N + edit-proxy
mcp__Roblox_Studio__execute_luau target=server              # IsServer=true, LocalPlayer=nil
mcp__Roblox_Studio__execute_luau target=client-N            # IsClient=true, LocalPlayer=<name>
mcp__Roblox_Studio__stop_playtest                           # "Playtest stopped via edit-proxy/EndTest"
mcp__Roblox_Studio__execute_luau target=server              # "Target instance 'server' disconnected"

# v2.11.0 rbxm round-trip
mcp__Roblox_Studio__export_rbxm instance_paths=["Workspace.SpawnLocation"] output_path="/tmp/test.rbxm"
mcp__Roblox_Studio__import_rbxm source={path:"/tmp/test.rbxm"} parent_path="ServerStorage"
# expect ServerStorage.SpawnLocation to now exist; Ctrl+Z in Studio removes it
mcp__Roblox_Studio__mass_get_property paths=["Workspace.SpawnLocation","ServerStorage.SpawnLocation"] propertyName="Size"
# expect identical Size values - property bag round-trips through .rbxm

# v2.11.0 memory snapshot
mcp__Roblox_Studio__get_memory_breakdown target=edit         # total_mb + per-category MB
mcp__Roblox_Studio__start_playtest mode=play numPlayers=1
mcp__Roblox_Studio__get_memory_breakdown target=all          # edit + server + client-1 entries
mcp__Roblox_Studio__get_memory_breakdown target=client-1 tags=["LuaHeap","Instances","Script"]
```

[Report Issues](https://github.com/chrrxs/robloxstudio-mcp/issues) | Upstream: [boshyxd/robloxstudio-mcp](https://github.com/boshyxd/robloxstudio-mcp) | [DevForum (upstream)](https://devforum.roblox.com/t/v180-roblox-studio-mcp-speed-up-your-workflow-by-letting-ai-read-paths-and-properties/3707071) | MIT Licensed
