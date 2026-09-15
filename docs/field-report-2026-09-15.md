# Field report — 2026-09-15

Findings from one day of real use: three connected Studio instances (a published place under active
development, a read-only reference place in play mode, and an unrelated place), 5–11 concurrent
agents, roughly 700 tool calls over ~14 hours. Each item lists the symptom, how to reproduce it,
the expected behavior, the candidate files, and a priority (P1 breaks the workflow, P2 wastes
time, P3 is an improvement).

File names follow this repository: `packages/core/src/*.ts` (server) and
`studio-plugin/src/modules/*.ts` (plugin). Regression tests for every item live in
`tests/field-2026-09-15/` (`npm run test:field`); the raw before/after tool output for each item
is in `tests/field-2026-09-15/EVIDENCE.md`.

---

## P1 — breaks the workflow

### 1. `capture_screenshot` returns a blank frame in play mode (and sometimes in edit mode)
- **Symptom:** `"Studio's CaptureService returned a blank (single-colour) frame and host window capture also failed (no viewport markers were visible in the Studio window capture)"`. The image is 1608×661, entirely black. In the same session, edit-mode captures with a `Scriptable` camera worked several times; in play mode (with a client-1 peer) 4/4 attempts were blank.
- **Reproduce:** `solo_playtest start play` → character spawned, `eval_client_runtime` shows a normal `workspace.CurrentCamera.CFrame` and a populated `PlayerGui` → `capture_screenshot` (jpeg 60/70 and png) → blank. The Studio window was maximized and in the foreground (`ShowWindow(h, 3)` + `SetForegroundWindow`, `IsIconic = false`). A PowerShell `Graphics.CopyFromScreen` of the same window at the same moment showed the viewport fully rendered.
- **Expected:** in play mode the play client's viewport is returned; when it is not, the error says why (which peer CaptureService ran on; why the markers were not visible: DPI scale? With the "HD 720 1280×720" device emulation enabled the viewport is scaled and centered — are the markers at the corners of the emulated frame or of the pane?).
- **Candidate files:** `packages/core/src/host-capture.ts` (marker search: `no viewport markers…` around line 108; `isBlank` threshold around line 66), `studio-plugin/src/modules/CaptureTransfer.ts`, `RenderMonitor.ts` (which DataModel/ScreenGui the markers are drawn into in play mode — `CoreGui` or `PlayerGui`; does the client peer have `CoreGui` access?).
- **Suspicion:** with device emulation ("HD 720") on, the viewport inside the window capture is scaled relative to the reported 1608×661 (the real pane is 1326×662 or 1608×662 depending on the panel layout). The aspect check in `host-capture.ts:128–134` (`does not match the reported viewport aspect`) can reject a valid marker box; the log does not say which branch failed.
- **Field workaround:** a GDI `CopyFromScreen` script with a fixed crop (edit: 293,195 1326×662; play: 12,195 1608×662). The crop rectangle depends on the pane layout; a `viewportRect` in the tool result would remove the need for it.
- **Request:** (a) marker count/position and emulation state in the error message; (b) a `viewportRect` (screen coordinates) field in the `capture_screenshot` result; (c) a `fallback: "window"` option that returns the **uncropped** window capture when no markers are found.

### 2. Edit-DataModel changes during play do not reach the running session → stop/sync/start for every fix
- **Symptom:** a code fix (`execute_luau` writing `Source`) or a `Destroy` in the edit DataModel leaves the running play session stale (correct Roblox behavior), but the tool set splits the cycle into three calls: `solo_playtest stop` → `execute_luau` sync → `solo_playtest start` (start takes 5–10 s). Six times in one session.
- **Request:** `solo_playtest action="restart"` (stop + wait + start, `mode` preserved) with an optional `before_start` Luau parameter that runs on the edit peer in between. `StopPlayMonitor.ts` already watches the stop.
- **Priority rationale:** in the concurrent-agent protocol the playtest is the single locked resource; every restart costs 20–30 s of queue time.

### 3. `import_rbxm` could not parent under `StarterPlayer.StarterCharacterScripts`
- **Symptom:** an rbxm with two LocalScripts (1,706 B) could not be imported with `parent_path="StarterPlayer.StarterCharacterScripts"` (agent report: "rbxm could not be parented"); the same file imported fine into `StarterGui`/`ReplicatedStorage` in four other imports. The scripts were recreated by hand with `Instance.new("LocalScript")` + `Source`.
- **Reproduce:** `export_rbxm instance_paths=["StarterPlayer.StarterCharacterScripts"]` → `import_rbxm path=… parent_path="StarterPlayer.StarterCharacterScripts"` (target Studio is a different instance).
- **Suspicion:** the root object serialized as the `StarterCharacterScripts` container itself; importing a service/container root fails ("Parent locked"). When the root is a service/container, its **children** should be moved to the parent. `studio-plugin/src/modules/handlers/SerializationHandlers.ts`.
- **Request:** unwrap service-rooted rbxm into its children; include Roblox's own text ("The Parent property of X is locked…") in the error message.

### 4. `set_properties` cannot write `Workspace.StreamingMinRadius` / `StreamingTargetRadius`
- **Symptom:** `"StreamingMinRadius is not a valid member of Workspace"`. These properties cannot be read from the plugin context either (`get_instance_properties` omits them). The user has to set them in the Properties panel.
- **Suspicion:** these properties sit under `RobloxScriptSecurity`/`PluginSecurity` (or are `NotScriptable`); they should be attempted with `pcall` and reported with a clear message ("this property cannot be written from a plugin; set it in the Properties panel").
- **Candidate:** `studio-plugin/src/modules/handlers/PropertyHandlers.ts` — a table of known plugin-inaccessible properties plus an explanatory error.

---

## P2 — wastes time

### 5. `execute_luau` silently cuts large return values
- **Symptom:** `return table.concat(...)` results above ~30k characters arrive with the tail cut off and no indication (`"truncated": true` or similar). Agents dumping inventories had to split into 3–4 chunks.
- **Request:** `truncated: true` + `totalBytes` in the result; a `max_output_bytes` parameter for `execute_luau`, or an `output_path` that writes large output to a file and returns the path.
- **Candidate:** `packages/core/src/http-body-limits.ts`, `studio-plugin/src/modules/LuauExec.ts`.
- **Status:** fixed in this PR — server-side output budget `max_output_bytes` (default 64 KiB, max 50 MiB) with `truncated`/`totalBytes`/`returnedBytes` (and `outputTruncated`/`outputTotalBytes` for print output); test `tests/field-2026-09-15/05-execute-luau-truncation.mjs`, unit test `packages/core/src/__tests__/field-05-execute-luau-output-budget.test.ts`, evidence `tests/field-2026-09-15/evidence/05-execute-luau-truncation.md`. Measurement showed no layer in this repository truncated; the cut came from the MCP client's own output budget.

### 6. `get_runtime_logs`: the error text and its `Script '…', Line N` source line are separate entries
- **Symptom:** one error is 2–3 separate `entries`: `ERR` message, `INFO "Script 'Players.x.PlayerGui…', Line 5"`, `INFO "Stack Begin/End"`. `filter="Script '"` drops the error text; `filter=":"` returns everything, with asset-permission spam (below) interleaved.
- **Request:** merge `MessageOutput` + `MessageError` + stack lines into one entry (`stack: [...]`), or at least a `level="ERR"` filter (there is no `level` parameter).
- **Extra:** the same asset's "User is not authorized to access Asset" error repeated 60+ times; `dedupe: true` (same message → `count`) would free a lot of space.
- **Candidate:** `studio-plugin/src/modules/RuntimeLogBuffer.ts`, `packages/core/src/tools/definitions.ts` (get_runtime_logs schema).

### 7. Many concurrent agents → queue, timeouts, resends
- **Symptom:** five agents sending `execute_luau`/`export_rbxm` to one instance produced 60 s timeouts; agents resent the same code instead of calling `get_request_status` (no `operation_id`, so no deduplication). Mutations (e.g. decor placement) risked running twice.
- **Request:** (a) `queued_ahead: N` and an estimated wait in the `execute_luau` result; (b) when `operation_id` is absent, derive one from the code hash (same code + same instance within 5 minutes → retained outcome); (c) the timeout error text should say "call `get_request_status`, do not resend".
- **Candidate:** `packages/core/src/bridge-service.ts`, `managed-instance-registry.ts`, `studio-plugin/src/modules/CooperativeJobRunner.ts`.
- **Status:** fixed in this PR — `execute_luau`/`export_rbxm` results carry `operationId`, `queued_ahead`, `waitedMs`; without `operation_id` the identity is derived from peer + endpoint + code and identical code is deduplicated only while the earlier request is pending or its result was never delivered (`dedupe:false` opts out; a delivered result never blocks a rerun); the timeout text says "call get_request_status with operation_id <id>; do not resend". Test `tests/field-2026-09-15/07-queue-dedupe.mjs`, unit test `packages/core/src/__tests__/field-07-queue-dedupe.test.ts`, evidence `tests/field-2026-09-15/evidence/07-queue-dedupe.md`.

### 8. `grep_scripts` cannot see CollectionService tag-based usage
- **Symptom:** to find the code that sets a third-party UI button `Visible=true` at runtime, `grep_scripts pattern="<ButtonName>"` → 0 results (303 scripts). The reference UI handler finds objects via `CollectionService:GetTagged("…")`; the tag name never appears in the script (it comes from a Config table). The fix was to delete the object.
- **Request:** a `search_objects`/new `get_tags` tool: an object's tags plus the scripts that look that tag up with `GetTagged` (static: literal `GetTagged("<tag>")` match; when dynamic, a "tag list comes from Config" hint). At minimum a `tags: [...]` field in `get_instance_properties`.
- **Candidate:** `studio-plugin/src/modules/ScriptSearch.ts`, `handlers/*` (instance properties).

### 9. Minimized Studio window → everything is black; the window handle changes per session
- **Symptom:** when the user has minimized Studio, `capture_screenshot` is black. Every session needs `Get-Process RobloxStudioBeta | select MainWindowHandle` + `ShowWindow` (three Studios open — which one is which instance is matched by the title).
- **Request:** `capture_screenshot` (or a new `focus_window`) restores and foregrounds a minimized window (`host-capture.ts` already finds it); add `windowHandle`/`windowTitle` to `get_connected_instances`.

### 10. In play mode, `capture_screenshot` never worked on the reference instance because of the "client peer"
- **Symptom:** for the reference instance (play mode: edit + server + client-1) `capture_screenshot` failed every time (peer ambiguity). No visuals were available for the read-only reference review; code reading had to do.
- **Request:** a `target` parameter (`edit|client-1`) or automatic client-1 selection in play mode; the error text names the peer that was tried.

---

## P3 — improvements

### 11. `get_connected_instances` does not show play state
- `server`/`client-1` in `peers` implies play, but there is no `mode` (play/run) or duration. Agents had to be told "the reference is in play mode, use the edit target". `solo_playtest status` is a separate call per instance.
- **Request:** a `playtest: { active, mode, startedAt }` field.

### 12. Fast `HumanoidRootPart.CFrame` writes through `eval_server_runtime` trip the game's anti-cheat
- Not a tool bug, but "move the player to X" tests needed a `Humanoid:MoveTo` loop. Tool-guides note: "for server-side teleports consider the game's speed limits (for example a per-sample distance cap); use `MoveTo` or the game's own teleport API".

### 13. `export_rbxm` size/count report
- The export result only returns the path; agents verified file size with `ls` and the instance count with a separate `GetDescendants`. **Request:** `bytes`, `instanceCount`, `rootClass` in the result (also catches item 3 early).

### 14. Count/verification after `import_rbxm`
- A successful import does not say how many instances arrived; every import was followed by an `execute_luau` `GetDescendants` count. **Request:** `instanceCount`, `rootNames` in the result.

### 15. `get_runtime_logs` `filter` is substring-only; no `level`, no `since`
- `level: "ERR"|"WARN"`, `since_ts`, `exclude` (to drop the asset-permission spam) parameters.

### 16. Tool-guides: a short section on the concurrent-agent protocol
- Rules that worked in the field (candidates for `robloxstudio://tool-guides`): one playtest lock (the orchestrator), a disjoint DataModel subtree per agent, mandatory `operation_id`, restart play after writing to the edit DataModel, split large outputs, treat reference instances as read-only (`target=edit`).

---

## Behaviors that worked in the field and must keep working (regression list)
- `execute_luau` in the edit context calling `HttpService:GetAsync("http://127.0.0.1:<port>/...")` (a local dev-server bridge) — the backbone of disk → Studio sync.
- `eval_server_runtime` / `eval_client_runtime` reaching live modules through the require cache (`require(ServerScriptService.<Module>)`) — all play verification relied on it.
- `export_rbxm` reading the edit DataModel while in play mode (34 files, 2.6 MB from the reference).
- `grep_scripts` over 303 scripts in under 1 s.
- `solo_playtest start` returning in 5–10 s every time under a 60 s timeout; `stop` immediate.

## Measurement note
- Tool calls in the session: ~700 (11 + 5 + 3 agents + orchestrator). Retries caused by queueing/timeouts: an estimated 30–40 calls; screenshot failures: 5 calls plus ~15 minutes on the PowerShell workaround.
