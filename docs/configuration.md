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

Plugin-facing endpoints (`/ready`, `/events`, `/response`, and `/disconnect`)
remain tokenless because Roblox Studio plugins cannot read the local token.
The plugin receives queued bridge messages over a persistent `/events` stream
and posts results to `/response`. These endpoints cannot directly invoke tools.
Passive health and status endpoints are also tokenless.

Setting `ROBLOX_STUDIO_HOST` to a non-loopback address exposes the bridge to
other machines. Only do this on a trusted network, retain token authentication,
and treat the token as a secret.

## Multiple connected places

Connect every open Studio place to the same MCP server URL. The server tracks
each connection; call `get_connected_instances` to receive compact standalone
and edit rows with IDs such as `instance:abc-1ef`. Each row's `peers` object
maps roles to typed Peer IDs such as `peer:abc-1ef`.

Temporary multiplayer server and client processes are listed only inside their
`multiplayerGroups` entry. Its `instances` object maps role-suffixed IDs such as
`instance:def-234-server` and `instance:567-890-client-1` directly to Peer IDs.
Pass either a top-level row ID or one of these grouped runtime IDs as
`instance_id`; the server resolves it to the correct game scope. Per-place port
tabs such as `58742` are not the supported routing model.

## Version compatibility

The Studio plugin and MCP server must have the same version. `/ready` rejects a
mismatched plugin rather than keeping an unsupported protocol pair connected.

Restart the MCP server with `--auto-install-plugin`, then fully close and reopen
Studio to load the matching bundled plugin.

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
| `ROBLOX_STUDIO_EXE` | Auto-discovered | Exact Studio executable used by `manage_instance action=launch`. |
| `ROBLOX_STUDIO_SOURCE` | `auto` | Restrict auto-discovery to one install source: `official`, `rml`, or `custom`. |
| `ROBLOX_STUDIO_SEARCH_ROOTS` | None | Extra Studio install roots, separated by `;`. Each is scanned for `version-*/RobloxStudioBeta.exe` and for a `RobloxStudioBeta.exe` directly inside it. |

Creator Store audio preview requires `asset:read` permission. See
[Creator Store assets](creator-store-assets.md) for its download and validation
behavior.

## Which Studio gets launched

`manage_instance action=launch` discovers Studio in both the official install
tree (`%LOCALAPPDATA%\Roblox\Versions`) and third-party launcher trees. The
Roblox Mod Loader launcher, which installs each Studio build under
`%APPDATA%\com.revolution.rml-launcher\studio\versions\version-<hash>`, is
recognized.

That launcher also records the instance it opens by default in
`studio/settings.json` as `"defaultInstallationId": "<source>:<version-folder>"`.
The source decides which tree the default lives in: `managed` is the launcher's
own tree, `roblox-official` is `%LOCALAPPDATA%\Roblox\Versions`. Only builds
found under the matching root are treated as the launcher default.

Selection order:

1. `studio_executable` on the launch request.
2. `ROBLOX_STUDIO_EXE`.
3. The build a launcher declares as its default.
4. The most recently modified `RobloxStudioBeta.exe` across every searched root.

Run `manage_instance action=list_studio_installations` to see every install
found, which one a launch would use, and why. Any other launcher can be added
with `ROBLOX_STUDIO_SEARCH_ROOTS`; `ROBLOX_STUDIO_SOURCE=official` restores
official-only discovery.

