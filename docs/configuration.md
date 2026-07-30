# Configuration

## Local HTTP bridge

The bridge binds to `127.0.0.1` by default and rejects cross-origin browser
requests unless their origin is explicitly allowed. The normal stdio MCP
transport is unaffected by HTTP authentication.

HTTP endpoints that can invoke tools (`/mcp`, `/mcp/<tool>`, `/proxy`,
`/instances`, and `/unregister-instance-id`) require a shared-secret token. The
server creates one at `~/.robloxstudio-mcp/auth-token` on first run and uses
mode `0600` on platforms that support POSIX permissions. HTTP MCP clients can
send the token as either:

```text
X-MCP-Auth: <token>
Authorization: Bearer <token>
```

Plugin-facing endpoints (`/ready`, `/poll`, `/response`, and `/disconnect`)
remain tokenless because Roblox Studio plugins cannot read the local token.
Those endpoints register the plugin and exchange queued bridge messages; they
cannot directly invoke tools. Passive health and status endpoints are also
tokenless.

Setting `ROBLOX_STUDIO_HOST` to a non-loopback address exposes the bridge to
other machines. Only do this on a trusted network, retain token authentication,
and treat the token as a secret.

Code passed to `generate_build` runs in a restricted AST interpreter without
access to Node globals, `Function`, or prototype chains.

## Multiple connected places

Connect every open Studio place to the same MCP server URL. The server tracks
each connection; call `get_connected_instances` and pass the returned
`instance_id` to route a tool call to a specific game. Per-place port tabs such
as `58742` are not the supported routing model.

## Version mismatch behavior

If the Studio plugin and MCP server versions differ, the plugin remains
connected and displays a yellow warning banner. `get_connected_instances`,
`/health`, and `/status` also report `pluginVersion`, `serverVersion`, and
`versionMismatch`.

Restart the MCP server with `--auto-install-plugin`, then fully close and reopen
Studio to load the matching plugin.

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `ROBLOX_STUDIO_HOST` | `127.0.0.1` | HTTP bridge bind address. |
| `ROBLOX_STUDIO_PORT` | `58741` | HTTP bridge port. |
| `ROBLOX_STUDIO_AUTH_TOKEN` | Auto-generated token file | Explicit shared secret that overrides the token file. |
| `ROBLOX_STUDIO_NO_AUTH` | Unset | Set to `1` or `true` to disable HTTP tool authentication. This is not recommended. |
| `ROBLOX_STUDIO_ALLOWED_ORIGINS` | None | Comma-separated browser origins allowed to call the HTTP API cross-origin. |
| `ROBLOX_OPEN_CLOUD_API_KEY` | None | Roblox Open Cloud key used by features such as audio preview and place version access. Required permissions depend on the tool. |
| `MCP_PLUGINS_DIR` | Platform Studio Plugins folder | Override the destination used by plugin installation. |

Creator Store audio preview requires `asset:read` permission. See
[Creator Store assets](creator-store-assets.md) for its download and validation
behavior.
