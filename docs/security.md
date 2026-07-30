# Security

The bridge binds to `127.0.0.1` and refuses cross-origin browser requests by default. Tool-invoking HTTP endpoints (`/mcp`, `/mcp/<tool>`, `/proxy`, `/instances`) require a shared-secret token, auto-generated on first run at `~/.robloxstudio-mcp/auth-token` (mode 0600). The stdio MCP transport (the normal `claude mcp add` path) is unaffected; HTTP MCP clients must send the token as `X-MCP-Auth: <token>` or `Authorization: Bearer <token>`. Plugin-facing endpoints (`/ready`, `/poll`, `/response`, `/disconnect`) stay tokenless — Studio plugins can't read local files, and those routes only register/poll and cannot invoke tools. `generate_build` code runs in a restricted AST interpreter with no access to Node globals, `Function`, or prototype chains.

## Creator Store imports

Loading public third-party assets requires **Allow Loading Third Party Assets**
in Studio under **Game Settings → Security**. Roblox disables this setting by
default. When it is disabled, preview and insertion load failures include a
targeted setup hint.

`insert_asset` treats every Creator Store asset as untrusted. `AssetService`
loads the asset into an unparented wrapper, and the plugin uses an
unlimited-depth `GetDescendants()` scan to destroy every
`LuaSourceContainer`—including `Script`, `LocalScript`, `ModuleScript`, and any
future subclass—and every `PackageLink`. It does not inspect or return script
source.

The plugin performs a second unlimited-depth scan before parenting any
remaining content. If a script or `PackageLink` survives, the complete loaded
asset is destroyed and nothing is inserted. This policy never depends on
instance names, Unicode, hierarchy depth, creator verification, source
contents, or asset reputation. Visual instances such as particles, beams,
trails, attachments, decals, textures, meshes, lights, sounds, fire, smoke,
and sparkles are preserved.

`preview_asset` records `Sound` and `AudioPlayer` content IDs and playback
metadata during the same unparented scan. It also recognizes a requested
Creator Store Audio asset from public metadata when Studio represents it as an
empty wrapper Model. When inline audio is enabled, the MCP server—not the Studio
plugin—uses `ROBLOX_OPEN_CLOUD_API_KEY` with `asset:read` permission to request
the direct Audio asset or each unique nested sound from Roblox's asset-delivery
API. It accepts only HTTPS download locations on `rbxcdn.com` or the exact
Roblox-owned legacy host `contentdelivery.roblox.com`, validates MP3, OGG, WAV,
or FLAC file signatures, returns at most five audio items, and enforces both
per-file and aggregate byte limits. Bytes remain in memory and are not written
to disk. Download failures never weaken insertion sanitization or prevent the
structural preview from returning.

## Version mismatch behavior

If the Studio plugin and MCP server versions differ, the plugin stays connected but shows a yellow warning banner. `get_connected_instances`, `/health`, and `/status` also report `pluginVersion`, `serverVersion`, and `versionMismatch`.

## Multiple connected places

For multiple open Studio places, connect each plugin to the same MCP server URL. The MCP server tracks every connected place; call `get_connected_instances` and pass the returned `instance_id` to route a tool call to a specific game. Per-place port tabs such as `58742` are not the supported routing model.

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `ROBLOX_STUDIO_HOST` | `127.0.0.1` | Bind address. Setting e.g. `0.0.0.0` exposes the bridge to the network — only do this on trusted networks. |
| `ROBLOX_STUDIO_AUTH_TOKEN` | *(auto-generated file)* | Explicit shared secret; overrides the token file. |
| `ROBLOX_STUDIO_NO_AUTH` | *(unset)* | Set to `1` to disable token auth (not recommended). |
| `ROBLOX_STUDIO_ALLOWED_ORIGINS` | *(none)* | Comma-separated browser origins allowed to call the API cross-origin. |
| `ROBLOX_OPEN_CLOUD_API_KEY` | *(none)* | Roblox Open Cloud key. `preview_asset` needs `asset:read` permission to return inline audio; inaccessible sounds remain metadata-only. |
