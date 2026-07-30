# Creator Store Assets

## Search and details

`search_assets` searches public Creator Store decals, images, models, audio,
particles, and VFX. Results are compact: they include the asset ID, name,
description excerpt, and audio duration when available. Results include all
creators by default; pass `robloxCreatedOnly: true` to restrict results to
assets created by Roblox.

Call `get_asset_details` for full metadata on shortlisted assets and
`get_asset_thumbnail` for an inline image.

## Preview

`preview_asset` loads an asset into an unparented wrapper and returns a bounded
hierarchy, capability summary, and complete security scan. It never reads or
returns imported script source.

The preview inventories every `Sound` and `AudioPlayer` with playback metadata.
It also recognizes a requested Creator Store Audio asset when Studio represents
it as an empty wrapper model.

Inline audio is enabled by default. The MCP server—not the Studio plugin—uses
`ROBLOX_OPEN_CLOUD_API_KEY` with `asset:read` permission to request the direct
Audio asset or each unique nested sound through Roblox's asset-delivery API.
Set `includeAudio: false` for metadata only. `maxAudioPreviews` defaults to
three and can be set as high as five.

Downloads are accepted only from HTTPS locations on `rbxcdn.com` or the exact
Roblox-owned legacy host `contentdelivery.roblox.com`. The server validates MP3,
OGG, WAV, or FLAC file signatures and enforces per-file and aggregate byte
limits. Audio bytes remain in memory and are not written to disk. A failed or
inaccessible download is reported without weakening insertion sanitization or
preventing the structural preview from returning.

## Safe insertion

To preview or insert a public third-party asset, enable
**Allow Loading Third Party Assets** in Studio under
**Game Settings → Security**. Roblox disables this setting by default. When it
is disabled, preview and insertion failures include a setup hint.

`insert_asset` treats every Creator Store asset as untrusted. `AssetService`
loads the asset into an unparented wrapper, then the plugin scans the complete
descendant hierarchy and destroys every `LuaSourceContainer`—including
`Script`, `LocalScript`, `ModuleScript`, and future subclasses—and every
`PackageLink`.

The plugin performs a second complete scan before parenting any remaining
content. If a script or `PackageLink` survived, the entire loaded asset is
destroyed and nothing is inserted. The policy does not depend on instance
names, Unicode, hierarchy depth, creator verification, source contents, or
asset reputation.

Non-script content such as particles, beams, trails, attachments, decals,
textures, meshes, lights, sounds, fire, smoke, and sparkles is preserved.
