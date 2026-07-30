# Roblox Studio MCP

**Debug your game while it runs.** The most capable Roblox Studio MCP server: live game-VM eval, log breakpoints, profiler captures, and full playtest automation, built for agent-driven development from Claude, Cursor, Codex, or Gemini.

[![Install from GitHub](https://img.shields.io/badge/install-GitHub-181717?logo=github)](https://github.com/Akramle/robloxstudio-mcp)

## The tools that matter

81 tools total. These are the ones that do the heavy lifting:

**Runtime debugging**
- `eval_server_runtime` / `eval_client_runtime`: run Luau in the live game VM on the server or a specific client, sharing the same `require` cache as your scripts. Inspect `MatchService.activeMatches` mid-match.
- `breakpoints`: log breakpoints that instrument live code without pausing the playtest.
- `get_runtime_logs`: buffered log capture per peer (`edit`, `server`, `client-N`), including boot-time prints and optional structured `data` on live `LogService` entries.

**Playtest automation**
- `solo_playtest` / `multiplayer_playtest`: start, inspect, and stop playtests, including multi-client sessions.
- `manage_instance`: launch and close Studio windows, open blank baseplates, local files, or specific published place revisions. Launches return an opaque `launch_id`, native PID, source path, and `launching | connected | exited | failed` lifecycle state, so asynchronous and failed launches remain inspectable and closable before a plugin connects.

**Profiling & performance**
- `capture_script_profiler` / `capture_micro_profiler`: CPU hotspots with debug labels and microsecond timing, on server or client.
- `get_memory_breakdown` / `get_scene_analysis`: memory and scene attribution per peer.

**Editing & automation at scale**
- `execute_luau`: full-power edit-context scripting with output capture.
- `mass_set_property`, `bulk_set_attributes`, `find_and_replace_in_scripts`: bulk operations for large places.
- `capture_screenshot` + simulated mouse/keyboard input: see the viewport and interact with UI.

**Agent guidance**
- `get_roblox_docs`: official engine API docs fetched as markdown, so your agent checks `ProximityPrompt` or `CFrame` semantics before writing code instead of hallucinating them.
- `get_roblox_skills`: list and retrieve Roblox-authored skills.

## Setup

1. Enable **Allow HTTP Requests** in Game Settings → Security
2. Wire up your AI. `--auto-install-plugin` installs the matching Studio plugin automatically:

```bash
# Claude Code
claude mcp add robloxstudio -- npx -y github:Akramle/robloxstudio-mcp --auto-install-plugin

# Codex CLI
codex mcp add robloxstudio -- npx -y github:Akramle/robloxstudio-mcp --auto-install-plugin

# Gemini CLI
gemini mcp add robloxstudio npx --trust -- -y github:Akramle/robloxstudio-mcp --auto-install-plugin
```

3. Fully close and reopen Studio after the plugin is first installed or updated. The plugin shows **Connected** when ready.

Multiple open places connect to the same server; call `get_connected_instances` and pass `instance_id` to route tool calls. Custom Plugins folder: set `MCP_PLUGINS_DIR`. Manual plugin install: `npx -y github:Akramle/robloxstudio-mcp --install-plugin`.

<details>
<summary>Other MCP clients (Claude Desktop, Cursor, etc.)</summary>

```json
{
  "mcpServers": {
    "robloxstudio-mcp": {
      "command": "npx",
      "args": ["-y", "github:Akramle/robloxstudio-mcp", "--auto-install-plugin"]
    }
  }
}
```

On Windows, wrap with `cmd /c` if `npx` doesn't resolve:
```json
{
  "mcpServers": {
    "robloxstudio-mcp": {
      "command": "cmd",
      "args": ["/c", "npx", "-y", "github:Akramle/robloxstudio-mcp", "--auto-install-plugin"]
    }
  }
}
```
</details>

## What you can ask

> *"Start a multiplayer test with 2 clients, read the server log, and tell me why the round never starts."*
> *"Evaluate `MatchService.activeMatches` on the server while a match is running."*
> *"Set a log breakpoint on the damage function, reproduce the hit, then read the breakpoint logs."*
> *"Capture a server Script Profiler sample while the wave spawns and rank the hottest functions."*
> *"Find scripts using deprecated APIs and rewrite them."*
> *"List recent versions for this place, then open version 3134 in a managed Studio window."*

## Creator Store assets

Search public decals, images, models, particles, and VFX with `search_assets`
without configuring a Roblox API key. `Image`
searches use the Creator Store Decal category; `Particle` and `VFX` searches use
models and effect-focused terms such as `particle effect`, `explosion`, `smoke`,
`aura`, `beam`, `trail`, and `impact effect`. Results include thumbnail URLs
when Roblox provides them. Use `get_asset_thumbnail` for an inline image and
`preview_asset` for an unparented hierarchy, visual-capability summary, and
unlimited-depth security scan.

`insert_asset` is fail-closed. The loaded asset remains unparented while every
`LuaSourceContainer` (including `Script`, `LocalScript`, `ModuleScript`, and
future subclasses) and every `PackageLink` is destroyed across the complete
descendant hierarchy. A second complete scan must find zero forbidden
instances before any content is parented into Studio; otherwise the entire
load is destroyed and nothing is inserted. Script source is never returned by
asset preview. Names, nesting depth, Unicode, creator verification, and asset
reputation never bypass this policy.

## Inspector edition (read-only)

[![NPM Version](https://img.shields.io/npm/v/@chrrxs/robloxstudio-mcp-inspector)](https://www.npmjs.com/package/@chrrxs/robloxstudio-mcp-inspector)

39 read-only tools: no writes, no script edits. Safe for browsing, code review, and debugging without risk of accidental changes. Install only one variant at a time (the installers remove the other automatically):

```bash
claude mcp add robloxstudio-inspector -- npx -y @chrrxs/robloxstudio-mcp-inspector@latest --auto-install-plugin
```

## More

- [Security model & environment variables](docs/security.md)
- [Building from source](docs/building-from-source.md)
- [Deprecated tool names](docs/deprecated-api.md)

---

<!-- VERSION_LINE -->
**v2.23.0**

[Report Issues](https://github.com/Akramle/robloxstudio-mcp/issues) · MIT Licensed · Based on [boshyxd/robloxstudio-mcp](https://github.com/boshyxd/robloxstudio-mcp) v2.7.0
