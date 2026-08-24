# Configuration & Security

## Local HTTP Bridge

The internal HTTP bridge binds to `127.0.0.1` and rejects cross-origin browser requests unless explicitly allowed. The `stdio` MCP transport is isolated and unaffected by HTTP authentication.

HTTP endpoints that invoke tools (`/mcp`, `/mcp/<tool>`, `/proxy`, `/instances`, `/unregister-instance-id`) require a shared-secret authorization token. The server generates this token at `~/.robloxstudio-mcp/auth-token` on first run (`0600` permissions).

HTTP clients must supply this token:
```text
X-MCP-Auth: <token>
Authorization: Bearer <token>
```

### Plugin-Facing Endpoints
Endpoints for the Studio plugin (`/ready`, `/poll`, `/response`, `/disconnect`) operate without tokens because local plugins cannot read external files. These endpoints strictly queue messages and cannot invoke tools.

> **Caution:** Setting `ROBLOX_STUDIO_HOST` to a non-loopback address (e.g., `0.0.0.0`) exposes the bridge to the network. Treat your token as a secret.

## Multiple Connected Places

All open Studio places connect to the same MCP server URL. 
Use `get_connected_instances` to retrieve a list of active places (`{ id, name, roles }`). Route tool calls by passing an `id` into the `instance_id` argument. Separate ports for separate places are not supported.

## Version Mismatches

If the Studio plugin and MCP server versions mismatch, the plugin displays a yellow warning. `/health` and `/status` endpoints report the mismatch, but standard MCP tools omit this to save tokens.

To fix, restart the server with `--auto-install-plugin`, then restart Roblox Studio.

## Environment Variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `ROBLOX_STUDIO_HOST` | `127.0.0.1` | HTTP bridge bind address. |
| `ROBLOX_STUDIO_PORT` | `58741` | HTTP bridge port. |
| `ROBLOX_STUDIO_AUTH_TOKEN` | Auto-generated file | Explicit shared secret overriding the token file. |
| `ROBLOX_STUDIO_NO_AUTH` | Unset | Set to `1` or `true` to disable HTTP tool authentication. **Not recommended.** |
| `ROBLOX_STUDIO_ALLOWED_ORIGINS` | None | Comma-separated browser origins permitted cross-origin access. |
| `ROBLOX_STUDIO_MCP_RESULT_MODE` | `compatible` | Controls response formatting. Enforces text fallbacks for compatibility across all CLI/IDEs (including Antigravity). |
| `ROBLOX_OPEN_CLOUD_API_KEY` | None | Roblox Open Cloud key. Permissions vary by tool. |
| `MCP_PLUGINS_DIR` | Platform Plugins folder | Overrides the plugin installation folder. |

> **Note:** Audio previews require `asset:read`. See [Creator Store assets](creator-store-assets.md).
