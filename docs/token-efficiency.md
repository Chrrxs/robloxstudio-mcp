# Token-efficiency contract

Version 3.0 treats the MCP wire surface as a budgeted public API.

## Catalog budget

The 2.23.1 catalog contained 81 advertised tools and serialized to 95,892
characters (about 23,973 tokens using the deliberately simple `characters / 4`
estimate). The 3.0 catalog contains 47 canonical tools and serializes to 42,671
characters (about 10,668 estimated tokens), a 55.5% reduction. The 24-tool
inspector catalog serializes to 19,032 characters (about 4,758 estimated tokens).

The regression test caps the serialized public catalog at 43,000 characters,
tool descriptions at 120 characters, and argument descriptions at 64 characters.
It also requires structured output schemas for every tool except the
Markdown-returning `get_roblox_docs` tool. Change the budget only as an explicit
API decision.

## Advertisement contract

- A tool description is one sentence that explains when or why to call it.
- Every input property describes its meaning and any constraint not already
  encoded by `enum`, `required`, bounds, or another JSON Schema keyword.
- Tool annotations contain only `readOnlyHint`, `destructiveHint`,
  `idempotentHint`, and `openWorldHint` behavior metadata.
- Server instructions hold shared constraints and cross-tool sequences. They are
  generated from the tools exposed by each server edition, so they never name an
  unavailable tool.
- Detailed workflows and safety notes are available on demand at
  `robloxstudio://tool-guides`. Official engine references remain available through
  the `robloxdocs://` resource templates.

The shared server instructions are 876 characters and are advertised once. The
4,855-character tool guide is not part of the tool catalog and is read only when
needed.

## Response contract

- Modern 2026-07-28 clients receive JSON once, in `structuredContent`.
- Legacy 2025 clients receive one JSON text projection for compatibility.
- Human-readable Markdown and image/audio content remain content blocks.
- Known bundle, plugin-session, version-mismatch, debug, and diagnostic metadata
  fields are removed at the protocol boundary.
- `get_connected_instances` returns each place once as `{ id, name, roles }`
  instead of repeating full plugin diagnostics for every edit/server/client peer.
- Tool errors expose a short stable code, an actionable message, and only the
  recovery data a caller needs. Full diagnostics go to stderr.

The shared boundary in `packages/core/src/mcp-runtime.ts` owns catalog projection,
annotations, input/output schemas, result normalization, and public error shaping
for both HTTP and stdio transports.
