# Creator Store Assets & Security

## Search & Discovery

`search_assets` queries public decals, images, models, audio, particles, and VFX. Results are compact (ID, name, description excerpt, audio duration). Set `robloxCreatedOnly: true` for Roblox-authored assets only.

Use `get_asset_details` for comprehensive metadata and `get_asset_thumbnail` for visual inspection.

## Security Previews

`preview_asset` safely loads assets into an isolated, unparented wrapper and returns a hierarchy summary, capability list, and security scan. **Note:** Previews never read or execute script source code.

The preview system inventories `Sound` and `AudioPlayer` instances, accurately interpreting audio assets even if loaded as empty wrappers.

### Inline Audio Previews
Enabled by default. The local MCP server uses your `ROBLOX_OPEN_CLOUD_API_KEY` (requires `asset:read`) to download audio via secure delivery APIs.

Set `includeAudio: false` to skip audio. `maxAudioPreviews` defaults to 3 (max 5).

**Audio Restrictions:**
- HTTPS only from `rbxcdn.com` or `contentdelivery.roblox.com`.
- Strict MIME/signature validation (MP3, OGG, WAV, FLAC).
- Enforced byte limits.
- In-memory only; never written to disk.
- Returns structural preview with warnings on download failure.

## Safe Insertion Pipeline

Enable **Allow Loading Third Party Assets** in **Game Settings → Security** to insert third-party assets.

### Sanitization Policy
`insert_asset` treats all assets as untrusted. The pipeline applies a strict protocol:

1. **Isolation:** `AssetService` loads the asset into a sandboxed wrapper.
2. **Purge:** Permanently destroys every `PackageLink` and `LuaSourceContainer` (`Script`, `LocalScript`, `ModuleScript`).
3. **Verification:** Aborts and destroys the asset if any script or `PackageLink` survives.

This policy is absolute. Visual, audio, and physical properties (meshes, lights, constraints) are preserved.
