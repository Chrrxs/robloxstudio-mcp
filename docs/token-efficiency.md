# Token-Efficiency Contract

Version 3.0 treats the MCP wire surface as a budgeted public API.

## Catalog Budget
- **Catalog Size:** Capped at 43,000 characters.
- **Tool Descriptions:** Max 120 characters.
- **Argument Descriptions:** Max 64 characters.
- **Output Schemas:** Required for all tools except `get_roblox_docs`.

## Advertisement Contract
- Tool descriptions are a single sentence explaining when/why to call it.
- Input descriptions exclude constraints already encoded by JSON Schema (e.g., bounds, enums).
- Annotations only include behavior metadata (`readOnlyHint`, `destructiveHint`, etc.).
- Server instructions hold shared constraints, generated dynamically to exclude unavailable tools.
- Detailed workflows are available via `robloxstudio://tool-guides` and `robloxdocs://` resources.

## Response Contract
- Structured results include a compact JSON text projection alongside `structuredContent`.
- Set `ROBLOX_STUDIO_MCP_RESULT_MODE=structured` only for clients verified to parse `structuredContent`.
- **Payload Minimization:** Missing, `null`, or empty arrays (`[]`) for specific keys are recursively stripped to save tokens.
- **Client Compatibility:** A text projection fallback is enforced if no other content blocks exist (fixes Antigravity IDE).
- `get_connected_instances` returns compact `{ id, name, roles }` rows instead of full diagnostics.
- Tool errors return a short code and actionable message; full stack traces go to stderr.

`packages/core/src/mcp-runtime.ts` manages catalog projection, schemas, result normalization, and error shaping.
