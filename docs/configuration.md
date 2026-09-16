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

Plugin registration (`/ready`) and disconnect (`/disconnect`) do not require the
local HTTP client token because Roblox Studio plugins cannot read that file.
Registration issues a per-transport token for the authenticated `/studio`
WebSocket upgrade. Commands, observed execution progress, responses, and
acknowledgements share that persistent socket; playtest client routes are
multiplexed through their play-server transport. These plugin endpoints cannot
directly invoke tools. The retired Studio `/events` stream and `/response`
posting routes return HTTP 426 (`studio_websocket_required`), not an SSE fallback.
This Studio transport is separate from MCP clients' HTTP subscription streams.
Passive health and status endpoints are also tokenless.

Setting `ROBLOX_STUDIO_HOST` to a non-loopback address exposes the bridge to
other machines. Only do this on a trusted network, retain token authentication,
and treat the token as a secret.

### Automatic Studio reconnection

While the plugin is enabled, connection failures retry automatically with
backoff of 0.5, 1, 2, 4, then 5 seconds (capped at 5 seconds, with no retry
limit). Duplicate-instance registration responses use a 1-second retry.
Registration (`/ready`, including metadata preparation) and WebSocket
creation/upgrade each have a 20-second deadline. A stalled phase is abandoned
and retried; late completions cannot replace the current connection. An open
socket with no valid incoming events for 20 seconds is also reconnected.

A previously healthy registration may be revalidated once by reconnecting its
socket without HTTP, so transient drops can recover even when Studio's HTTP
quota is exhausted. If that socket cannot open, including a timeout or an
upgrade rejection without a numeric HTTP status, its cached credentials are
discarded and the next attempt registers again. Replacing the bridge does not
require toggling Disconnect/Connect.

The plugin panel shows the connection stage, attempt number, retry countdown,
and last failure. A live connection with no MCP client is shown separately from
a failed registration or socket. Metadata refreshes also have a 20-second
deadline, but their failure does not close a healthy socket or start an HTTP
retry loop. Explicit metadata changes received during reconnection or another
refresh are coalesced and sent when the transport is ready.

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

## Host window capture

`capture_screenshot` first asks Studio for the frame (StudioCaptureService, then
CaptureService + EditableImage). During a solo playtest those paths can come back
unusable on some Studio builds: StudioCaptureService reports
`CanCaptureScreenshot() == false` in the play client, and CaptureService hands
back a fully black frame (observed with the Vulkan renderer), regardless of
whether the Studio window is focused. When the frame is a single colour, or
Studio's capture errors outright, the server captures the Studio window through
the host OS and crops it to the viewport:

- The plugin briefly pins four magenta squares to the viewport corners so the
  crop is exact under any dock layout or DPI scale; they are removed before the
  final capture, and the located position is reused for 60 seconds.
- On Windows the capture uses `PrintWindow(PW_RENDERFULLCONTENT)` via
  PowerShell, which reads the composited window even when it is behind other
  windows. A minimized window cannot be captured; the tool says so.
- Other platforms currently report that host capture is unavailable and return
  Studio's original result or error.

The returned image keeps the `simulate_mouse_input` coordinate contract: it is
resampled to the viewport's logical size, so image pixels are viewport pixels.
The tool message states when the host path was used. Set
`ROBLOX_STUDIO_HOST_CAPTURE=0` to disable the fallback.

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `ROBLOX_STUDIO_HOST` | `127.0.0.1` | HTTP bridge bind address. |
| `ROBLOX_STUDIO_PORT` | `58741` | HTTP bridge port. |
| `ROBLOX_STUDIO_AUTH_TOKEN` | Auto-generated token file | Explicit shared secret that overrides the token file. |
| `ROBLOX_STUDIO_NO_AUTH` | Unset | Set to `1` or `true` to disable HTTP tool authentication. This is not recommended. |
| `ROBLOX_STUDIO_ALLOWED_ORIGINS` | None | Comma-separated browser origins allowed to call the HTTP API cross-origin. |
| `ROBLOX_STUDIO_HOST_CAPTURE` | Unset | Set to `0`, `false`, or `off` to disable the host window capture fallback for `capture_screenshot`. |
| `ROBLOX_OPEN_CLOUD_API_KEY` | None | Roblox Open Cloud key used by features such as audio preview and place version access. Required permissions depend on the tool. |
| `MCP_PLUGINS_DIR` | Platform Studio Plugins folder | Override the destination used by plugin installation. |

Creator Store audio preview requires `asset:read` permission. See
[Creator Store assets](creator-store-assets.md) for its download and validation
behavior.
