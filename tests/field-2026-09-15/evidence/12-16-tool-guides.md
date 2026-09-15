# Field report #12 + #16 — `robloxstudio://tool-guides`: server-side teleportation note + concurrent agent protocol

Raw output: `raw-16-jest-red.txt` (before, captured while the test was still named `todo-16`), `raw-16-jest-green.txt`, `raw-06-08-16-jest-green.txt` (full `packages/core` run on the final branch).

## Symptom / reproduction

Test: `packages/core/src/__tests__/field-16-tool-guides.test.ts` — builds an in-memory MCP client/server pair with `registerResourceHandlers` (same pattern as `mcp-compat.test.ts`), checks that `resources/list` contains `robloxstudio://tool-guides`, and that the `resources/read` text carries `## Server-side teleportation` (mentioning `HumanoidRootPart.CFrame` and `Humanoid:MoveTo`) and `## Concurrent agent protocol` with the key phrase of each of the six rules (`one playtest lock`, `disjoint DataModel subtree`, `operation_id`, `solo_playtest action=restart`, `max_output_bytes`, `target=edit`). The em dash character stays forbidden in the guide (existing contract).

Command: `npm test -w packages/core -- field-16`

Before (guide without the new sections):

```
  ● TODO #12/#16 tool guide sections › lists the tool guide resource and serves both new sections
    Expected substring: "## Server-side teleportation"
    Received string:    "# Roblox Studio MCP tool guide·
Tests:       1 failed, 1 total
```

## Fix

`packages/core/src/mcp-compat.ts` (`TOOL_GUIDE_MARKDOWN`):
- "Playtests and runtime Luau": one sentence on the merged `get_runtime_logs` error entry (`script`, `line`, `stack`) and the `level`, `since_ts`, `exclude`, `dedupe` parameters. The upstream retention bullets (64 KiB per Peer, `totalDropped`, `nextCursor` watermark) stay directly under that paragraph.
- New `## Server-side teleportation`: rapid `HumanoidRootPart.CFrame` writes can trip the game's own anti-cheat; treat the game's speed limit as the ceiling; prefer a `Humanoid:MoveTo` loop, the game's own teleport/checkpoint API, or a single CFrame write plus a short wait and a position check.
- New `## Concurrent agent protocol`: six rules — one playtest lock per Instance (held by an orchestrator), a disjoint DataModel subtree per agent, `operation_id` on every `execute_luau`/`set_properties` and `get_request_status` after a timeout, restart the playtest after writing to the edit DataModel (`solo_playtest action=restart` where the server offers it, otherwise stop and start), split large outputs (`max_output_bytes` where the server offers it, log cursors), and treat a reference Instance as read-only (`target=edit`).

The existing `mcp-compat.test.ts` and `tool-schema.test.ts` read the same text and keep passing.

## After

```
PASS src/__tests__/field-16-tool-guides.test.ts
  field #12/#16 tool guide sections
    √ lists the tool guide resource and serves both new sections (56 ms)

Tests:       1 passed, 1 total
```

## Regression

- `npm run typecheck` green.
- `npm run lint`: 8 errors / 40 warnings, all pre-existing on `origin/main` (`install-plugin-helpers.ts:254–257`, `opencloud-client.ts:445`, `studio-instance-manager.ts:2120`, `install-plugin.ts` `_chunk` ×2); no new ones.
- `npm test -w packages/core`: 41 suites / 714 tests green on the final branch (`raw-06-08-16-jest-green.txt`).
