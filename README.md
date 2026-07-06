# Roblox Studio MCP — Agentic Runtime Debugging

**Debug your game while it runs.** The most capable Roblox Studio MCP server: live game-VM eval, log breakpoints, profiler captures, and full playtest automation — built for agent-driven development from Claude, Cursor, Codex, or Gemini.

[![NPM Version](https://img.shields.io/npm/v/@chrrxs/robloxstudio-mcp)](https://www.npmjs.com/package/@chrrxs/robloxstudio-mcp)

When you start using agents to drive development, runtime debugging is what matters: not just reading scripts, but watching state change in a live playtest and steering from there. That is what this server is built around. SOTA models are insanely capable — this MCP gives them the runtime access to prove it.

## The tools that matter

77 tools total. These are the ones that do the heavy lifting:

**Runtime debugging** — the reason this server exists
- `eval_server_runtime` / `eval_client_runtime` — run Luau in the live game VM on the server or a specific client, sharing the same `require` cache as your scripts. Inspect `MatchService.activeMatches` mid-match.
- `breakpoints` — log breakpoints that instrument live code without pausing the playtest.
- `get_runtime_logs` — buffered log capture per peer (`edit`, `server`, `client-N`), including boot-time prints.

**Playtest automation**
- `solo_playtest` / `multiplayer_playtest` — start, inspect, and stop playtests, including multi-client sessions.
- `manage_instance` — launch and close Studio windows, open blank baseplates, local files, or specific published place revisions.

**Profiling & performance**
- `capture_script_profiler` / `capture_micro_profiler` — CPU hotspots with debug labels and microsecond timing, on server or client.
- `get_memory_breakdown` / `get_scene_analysis` — memory and scene attribution per peer.

**Editing & automation at scale**
- `execute_luau` — full-power edit-context scripting with output capture.
- `mass_set_property`, `bulk_set_attributes`, `find_and_replace_in_scripts` — bulk operations for large places.
- `capture_screenshot` + simulated mouse/keyboard input — see the viewport and interact with UI.

**Agent guidance**
- `get_roblox_docs` — official engine API docs fetched as markdown, so your agent checks `ProximityPrompt` or `CFrame` semantics before writing code instead of hallucinating them.

## Setup

1. Enable **Allow HTTP Requests** in Game Settings → Security
2. Wire up your AI — `--auto-install-plugin` installs the matching Studio plugin automatically:

```bash
# Claude Code
claude mcp add robloxstudio -- npx -y @chrrxs/robloxstudio-mcp@latest --auto-install-plugin

# Codex CLI
codex mcp add robloxstudio -- npx -y @chrrxs/robloxstudio-mcp@latest --auto-install-plugin

# Gemini CLI
gemini mcp add robloxstudio npx --trust -- -y @chrrxs/robloxstudio-mcp@latest --auto-install-plugin
```

3. Fully close and reopen Studio after the plugin is first installed or updated. The plugin shows **Connected** when ready.

Multiple open places connect to the same server; call `get_connected_instances` and pass `instance_id` to route tool calls. Custom Plugins folder: set `MCP_PLUGINS_DIR`. Manual plugin install: `npx -y @chrrxs/robloxstudio-mcp@latest --install-plugin`.

<details>
<summary>Other MCP clients (Claude Desktop, Cursor, etc.)</summary>

```json
{
  "mcpServers": {
    "robloxstudio-mcp": {
      "command": "npx",
      "args": ["-y", "@chrrxs/robloxstudio-mcp@latest", "--auto-install-plugin"]
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
      "args": ["/c", "npx", "-y", "@chrrxs/robloxstudio-mcp@latest", "--auto-install-plugin"]
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

## Inspector edition (read-only)

[![NPM Version](https://img.shields.io/npm/v/@chrrxs/robloxstudio-mcp-inspector)](https://www.npmjs.com/package/@chrrxs/robloxstudio-mcp-inspector)

36 read-only tools — no writes, no script edits. Safe for browsing, code review, and debugging without risk of accidental changes. Install only one variant at a time (the installers remove the other automatically):

```bash
claude mcp add robloxstudio-inspector -- npx -y @chrrxs/robloxstudio-mcp-inspector@latest --auto-install-plugin
```

## More

- [Security model & environment variables](docs/security.md)
- [Building from source](docs/building-from-source.md)
- [Deprecated tool names](docs/deprecated-api.md)

---

<!-- VERSION_LINE -->
**v2.20.0**

[Report Issues](https://github.com/chrrxs/robloxstudio-mcp/issues) · MIT Licensed · Based on [boshyxd/robloxstudio-mcp](https://github.com/boshyxd/robloxstudio-mcp) v2.7.0
