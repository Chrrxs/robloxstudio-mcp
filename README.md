# Roblox Studio MCP

Connect your coding agent directly to Roblox Studio. It can edit places, run Luau
in live server and client contexts, start and stop playtests, and collect logs,
screenshots, memory reports, and profiler captures from each peer.

[![NPM Version](https://img.shields.io/npm/v/@chrrxs/robloxstudio-mcp)](https://www.npmjs.com/package/@chrrxs/robloxstudio-mcp)

## What it can do

### Debug a running game

- Run Luau with `eval_server_runtime` or `eval_client_runtime`. Both tools execute in a live server or client context and use the same `require` cache as your game scripts.
- Instrument live code with `breakpoints`. It records each hit without pausing the playtest.
- Read output from edit mode, the server, or a specific client with `get_runtime_logs`, including messages logged during startup.

### Automate playtests

- Start, inspect, and stop solo or multi-client sessions with `solo_playtest` and `multiplayer_playtest`.
- Open or close Studio windows with `manage_instance`. It can launch a baseplate, a local place file, a published place, or an older place revision.

### Find performance problems

- Record server or client CPU timings with `capture_script_profiler` and `capture_micro_profiler`.
- Break down memory use with `get_memory_breakdown` or attribute scene cost with `get_scene_analysis`.

### Work in edit mode

- Run Luau in Studio's edit context with `execute_luau`.
- Use `set_properties` for instance properties and `find_and_replace_in_scripts` for script text. For project-specific bulk edits, use `execute_luau`.
- For large generated Luau, use the [verified chunk-staging workflow](docs/large-inputs.md): explicit instance routing, UTF-8 byte/hash readback, ownership-checked cleanup, and bounded recovery without blindly replaying mutations.
- Use `selection` to inspect or update Studio selection and frame a part or model before capturing the viewport.
- Capture the viewport with `capture_screenshot`, then send mouse or keyboard input. See [Configuration](docs/configuration.md#host-window-capture).

### Inspect Creator Store assets

- Find public assets with `search_assets`, then read the full catalog metadata with `get_asset_details`.
- Check an asset's hierarchy, media metadata, and security scan with `preview_asset` before adding it to the place.
- Add an asset with `insert_asset`. The tool removes scripts and package links, verifies the cleaned result, and then parents it in Studio.

### Look up Roblox APIs

- Fetch official engine API documentation as Markdown with `get_roblox_docs`.
- List and retrieve Roblox-authored skills with `get_roblox_skills`.

See the [complete tool list](packages/core/src/tools/definitions.ts).

## Setup

### 1. Connect your client

Choose your MCP client below. Each setup installs the matching Studio plugin automatically.

<details>
<summary>Codex CLI</summary>

```bash
codex mcp add robloxstudio -- npx -y @chrrxs/robloxstudio-mcp@latest --auto-install-plugin
```

</details>

<details>
<summary>Claude Code</summary>

```bash
claude mcp add robloxstudio -- npx -y @chrrxs/robloxstudio-mcp@latest --auto-install-plugin
```

</details>

<details>
<summary>Antigravity CLI</summary>

```bash
agy mcp add robloxstudio -- npx -y @chrrxs/robloxstudio-mcp@latest --auto-install-plugin
```

</details>

<details>
<summary>Other clients (Cursor, Claude Desktop, etc..)</summary>

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

</details>

### 2. Restart Studio

Fully close and reopen Studio after installation or updates.
When the plugin displays **Connected**, you're ready.

<details>
<summary>Advanced setup</summary>

**Custom Plugins folder.** Set `MCP_PLUGINS_DIR` to use a custom location.

**Manual plugin installation.**

```bash
npx -y @chrrxs/robloxstudio-mcp@latest --install-plugin
```

Both editions prefer the bundled plugin. If it is missing, installation downloads
the GitHub release matching the installed npm package version and validates the
plugin's version and edition before replacing the installed file. This also
applies to development versions; a missing matching release is an error.

</details>

## Inspector edition

Read-only access to the DataModel.

[![NPM Version](https://img.shields.io/npm/v/@chrrxs/robloxstudio-mcp-inspector)](https://www.npmjs.com/package/@chrrxs/robloxstudio-mcp-inspector)

<details>
<summary>Installation and permissions</summary>

No DataModel or script edits. The selection tool can change editor selection and
camera framing; export and profiler tools can write files only to explicit local
paths.

Install only one variant at a time (the installers remove the other automatically):

**Codex CLI**

```bash
codex mcp add robloxstudio-inspector -- npx -y @chrrxs/robloxstudio-mcp-inspector@latest --auto-install-plugin
```

**Claude Code**

```bash
claude mcp add robloxstudio-inspector -- npx -y @chrrxs/robloxstudio-mcp-inspector@latest --auto-install-plugin
```

**Antigravity CLI**

```bash
agy mcp add robloxstudio-inspector -- npx -y @chrrxs/robloxstudio-mcp-inspector@latest --auto-install-plugin
```

**Other clients (Cursor, Claude Desktop, etc.)**

```json
{
  "mcpServers": {
    "robloxstudio-inspector": {
      "command": "npx",
      "args": ["-y", "@chrrxs/robloxstudio-mcp-inspector@latest", "--auto-install-plugin"]
    }
  }
}
```

</details>

## Documentation

| Topic | Guides |
| --- | --- |
| **Setup & usage** | [Configuration and HTTP bridge](docs/configuration.md) · [Large inputs & recovery](docs/large-inputs.md) · [Creator Store assets](docs/creator-store-assets.md) |
| **Development** | [Building from source](docs/building-from-source.md) · [API migration](docs/deprecated-api.md) · [Token budgets](docs/token-efficiency.md) |

---

[Report issues](https://github.com/chrrxs/robloxstudio-mcp/issues) · [Report a security vulnerability](SECURITY.md) · MIT Licensed · Based on [boshyxd/robloxstudio-mcp](https://github.com/boshyxd/robloxstudio-mcp) v2.7.0
