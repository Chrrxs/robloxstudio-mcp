# 01 — `capture_screenshot` returns a blank frame in play mode (field report #1, P1)

Managed baseplate Studio launched by the runner; the user's other open Studio windows were listed but never touched (window lists are in the raw logs).

## Symptom / reproduction

Command: `node tests/run-with-test-port.mjs tests/run-all.mjs --managed --test field-2026-09-15/01-capture-play-blank.mjs` (unfixed code; raw output in `01-before.log`).

Raw output (trimmed; full text in `01-before.log`):

```
instance instance:62t-uf7 placeName=RunnerBaseplate.rbxl peers={"edit":"peer:bmy-5dy"}
capture_screenshot {} -> 2231ms {"width":1324,"height":772,...}            image 1324x772, 1613 unique colours   (edit, control)
Studio window {"title":"C:\\Users\\<user>\\AppData\\Local\\Temp\\rsmcp-runner-xjn68r\\RunnerBaseplate.rbxl - Roblox Studio","handle":6033628,"iconic":false,"pid":41268}
window probe (play, no markers): {"width":1920,"height":1009,"printed":true,"printwindowColours":9298,"printwindowMagenta":0,"screenColours":9323,"screenMagenta":0}
client-1 ViewportSize 1608x772 (emulation off)
capture_screenshot {} -> 4769ms {"width":1608,"height":772,... "Warning: Studio's CaptureService returned a blank (single-colour) frame and host window capture also failed (could not pick a Studio window for 'RunnerBaseplate.rbxl' among: C:\\...\\RunnerBaseplate.rbxl - Roblox Studio | <three other Studio windows>), so this image may be blank."}
    image 1608x772, 1 unique colours
set_device_simulator {"target":"client-1","deviceId":"hd_720"}  -> client-1 ViewportSize 1279x720 (isSimulating, scalingMode ScaleToPhysicalSize, resolution 1280x720)
capture_screenshot {} -> 2177ms {"width":1466,"height":825, ... same warning}   image 1466x825, 1 unique colours
capture_screenshot {"fallback":"window"} -> 2051ms {"width":1466,"height":825, ... same warning}   image 1466x825, 1 unique colours   (parameter ignored)
FAILED: play capture (emulation off) is a single colour (1)
```

Unit (unfixed `host-capture.ts`, `npm test -w packages/core -- field-01-capture-markers`, raw output in `01-unit-before.log`):

```
x a 1326x662 on-screen pane is accepted when the client reports a 1608x661 viewport
  + "error": "viewport marker box 1326x662 does not match the reported 1608x661 viewport aspect"
x a marker miss reports the pixel count and the branch that failed   (no branch/markerPixels fields)
Tests: 2 failed, 3 passed
```

## Root cause (from the raw logs)

1. **CaptureService hands the play client a black frame**: `/api/capture-begin` on client-1 (`CaptureService:CaptureScreenshot` -> rbxtemp id) then `/api/capture-read` in the edit DataModel (EditableImage) -> 1608x772, **1 colour**. With emulation on it is 1466x825, 1 colour (the frame is the physical emulation frame, not the 1279x720 ViewportSize).
2. **Window selection**: `host-capture.ts` picked the window with `Title.StartsWith(hint)`; the hint is `dataModelName`/`placeName` (`RunnerBaseplate.rbxl`), but for local-file places the title is the **full file path** (`C:\...\RunnerBaseplate.rbxl - Roblox Studio`). With several Studios open -> "could not pick a Studio window". (In the field the published place name did match; there item 3 applied.)
3. **Markers under device emulation**: with HD 720 in "physical size" mode the emulated frame is 1466x825 px inside the window (starting at 67,177) while the visible pane is ~758 px tall -> the **bottom markers are outside the pane** (a scrollbar appears). The old code passed the four-corner check with just the two top markers -> a bogus 1466x14 box (the first green attempt returned `viewportRect.height=14`, 93 colours). `MARKER_SCALE_TOLERANCE` (old `host-capture.ts:128-134`) also rejected a different scale per axis (1326/1608 vs 662/661).
4. **PrintWindow does include the viewport on this machine** (probe: printwindow 9703 colours vs screen 9709; play mode, no markers). The field "no viewport markers" is therefore explained by item 3 or by markers outside the pane, not by PrintWindow; the error text now reports marker counts, capture method, emulation state and peer, and the `auto` method brings the window to the front and takes a screen copy (BitBlt) when PrintWindow shows no markers.
5. **CoreGui is reachable from the client peer**: `/api/capture-markers` runs in the client-1 VM through the ClientBroker (`CLIENT_BROKER_ALLOWED_ENDPOINTS`) and parents the ScreenGui to `CoreGui`; in the green run the markers were found for client-1 (`peer:"client-1"`, `viewportRect` populated). The `show` reply now also carries `markerParent` and `emulation`.

## Fix

- `packages/core/src/host-capture.ts`: `findViewportRect` -> `ViewportLocateResult` (`markerPixels`, `scaleX/scaleY`, `branch: none|rectangle`, height inferred from a single marker row plus `clipped:{edge,pixels}`); the aspect rejection is gone; `cropToViewport` leaves source pixels outside the window black (upstream's exact-size rule is kept: only an exactly matching rect is copied, everything else resamples to the logical size); the PowerShell helper gained `MCP_CAPTURE_MODE=list|capture`, `MCP_CAPTURE_METHOD=printwindow|screen|auto`, restores a minimized window with `ShowWindow(SW_RESTORE)` + `SetForegroundWindow` (Alt-key trick), per-monitor DPI awareness, `ClientToScreen` (so `viewportRect` is in screen coordinates) and a C# magenta count; title matching is `studioWindowMatchesHint` (place name / file name / file name without extension); window selection is `MCP_CAPTURE_PID` (managed process id) -> unique title match -> single candidate; exported helpers: `listStudioWindows()`, `findStudioWindow(titleHint, pid)`, `pickStudioWindow(windows, titleHint, pid)`, `studioWindowMatchesHint`, `studioWindowPlaceName`, `captureStudioWindow(titleHint, {method, foreground, pid})`.
- `packages/core/src/studio-instance-manager.ts`: `peekProcessIdByInstanceId(instanceId)` (`nativeProcessId ?? spawnPid` from the in-memory managed record) and `lookupProcessIdByInstanceId(instanceId)`, which falls back to a lock-free read of the shared managed-instance registry (`ManagedInstanceRegistry.peekAnyByInstanceId`) so a server running in proxy mode (the test clients, or any second server on the same port) still picks the right window. Without it the proxied server had no pid and grabbed another agent's Studio window with the same place name (seen in the first re-run on the final branch: `no viewport markers ... window '...rsmcp-runner-uGgEWB...'` while our instance lived in `rsmcp-runner-2hdWtX`).
- `packages/core/src/tools/index.ts`: a `/api/capture-begin` failure on the play client (`Screenshot capture timed out (CaptureScreenshot callback never fired)` while another window covers Studio) no longer returns early; it goes through the same host window fallback as a blank frame. Found by upstream's `capture-regressions.mjs` on this machine while other agents' Studio windows kept popping over the managed one.
- `packages/core/src/tools/index.ts` (capture section): `captureScreenshot(instance_id, format, quality, target, fallback)`; the result carries `peer`, `target`, `source`, `cropped`, `viewportRect`, `clipped`, `window{title,handle,width,height,method,restored,foreground}`; `fallback:"window"` skips the Studio capture and returns the uncropped window; a marker miss reports `branch`, marker pixel count, magenta count per method, window/method/foreground/restored, frames rendered, viewport, emulation state and peer. Upstream's prepare/finish transaction (FitToWindow scaling, blank-PNG detection, per-instance capture queue) is kept; the pid-based window pick, `uncropped` mode and the richer result are layered on top of it.
- `packages/core/src/http-server.ts` (target/fallback pass-through), `packages/core/src/tools/definitions.ts` (`capture_screenshot` schema: `target`, `fallback`).
- `studio-plugin/src/modules/handlers/CaptureHandlers.ts`: the `capture-markers` `query`/`show` replies include `emulation{active,deviceId,resolution}` (StudioDeviceSimulatorService, pcall) and `markerParent`.

## After

Same command on the final branch (raw output in `01-after.log`):

```
2026-09-15 14:03 (final branch); manage_instance status -> pid=71588; Studio window "...
smcp-runner-UPBMBt\RunnerBaseplate.rbxl - Roblox Studio" handle 12390504 (the user's three Studio windows were open at the same time)
capture_screenshot {}  (edit)                -> 531ms  {"width":1324,"height":772,"peer":"edit","target":"auto","source":"CaptureService","cropped":true}   image 1324x772, 1613 unique colours
solo_playtest start play -> client-1; ViewportSize 1608x772 (emulation off)
capture_screenshot {}  (play, emulation OFF) -> 2292ms {"width":1608,"height":772,"peer":"client-1","target":"auto","source":"host-window","cropped":true,
   "viewportRect":{"x":3,"y":188,"width":1608,"height":772},"window":{"title":"...RunnerBaseplate.rbxl - Roblox Studio","handle":12390504,"width":1920,"height":1009,"method":"printwindow","restored":false,"foreground":false},
   "message":"... Captured from the Studio window through the host OS (printwindow) because Studio's CaptureService returned a blank (single-colour) frame."}
    image 1608x772, 8488 unique colours
set_device_simulator {"target":"client-1","deviceId":"hd_720"} -> ViewportSize 1279x720 (isSimulating, ScaleToPhysicalSize, 1280x720)
capture_screenshot {}  (play, emulation ON)  -> 2545ms {"width":1279,"height":720,"peer":"client-1","source":"host-window","cropped":true,
   "viewportRect":{"x":137,"y":203,"width":1326,"height":746},"window":{...,"method":"printwindow"}}   (all four markers visible: upstream's FitToWindow fitting keeps the emulated viewport inside the pane, so no `clipped` field this time)
    image 1279x720, 14862 unique colours
capture_screenshot {"fallback":"window"}       -> 1975ms {"width":1920,"height":1009,"peer":"client-1","source":"host-window","cropped":false,"viewportRect":{"x":137,"y":203,"width":1326,"height":746},...}
    image 1920x1009, 14432 unique colours   (window 1920x1009 >= viewport 1279x720)
RESULT edit=1324x772/1613c play-off=1608x772/8488c play-on=1279x720/14862c window=1920x1009/14432c
PASSED: field #1 capture_screenshot play-mode blank frame     1/1 passed.
```

Before -> after: play (emulation off) 1608x772 **1 colour** -> non-uniform image 1608x772, **8,488 colours**; play (HD 720) 1466x825 1 colour -> 1279x720 (ViewportSize), 14,862 colours; `fallback:"window"` was ignored -> uncropped window plus `viewportRect` (1920x1009, 14,432 colours).

Intermediate attempts on the original branch: (a) the emulated capture returned `viewportRect.height=14`, 93 colours (bottom markers outside the pane; the four-corner check passed with the two top markers) -> single-row marker inference plus `clipped`. (b) the server grabbed another agent's managed Studio window with the same place name -> "no viewport markers ... (branch: none; marker pixels in the analysed grab: 0; magenta pixels per method: screen=0, printwindow=0; window '...' 1920x1009 via screen, foreground=true, restored=false; frames rendered with markers: 3; reported viewport 1608x772; device emulation: off; peer: client-1)" — the error text is as detailed as intended; the window is now picked by the managed process **pid** (`StudioInstanceManager.peekProcessIdByInstanceId` -> `MCP_CAPTURE_PID`), then by a unique title match, then by the single candidate; several title matches raise "several Studio windows match".

Unit: `npm test -w packages/core -- host-capture field-01` -> `Tests: 52 passed, 52 total` (raw output in `01-unit-after.log`).

## Regression

- `npm run typecheck` green.
- `npm run lint`: only the pre-existing errors (install-plugin-helpers.ts:254-257, opencloud-client.ts:445, studio-instance-manager.ts `while (true)`, install-plugin.ts `_chunk` x2); no new ones.
- `npm test -w packages/core`: 39 suites / 713 tests green.
- Upstream's own capture regression with the real host fallback: `RSMCP_EXPECT_STUDIO_CAPTURE=disabled RSMCP_EXPECT_HOST_CAPTURE=1 node tests/run-with-test-port.mjs tests/run-all.mjs --managed --test capture-regressions.mjs` -> `Screenshot beta and legacy regressions PASSED` (host crops at 1000x600, 1200x700, 1920x1080 incl. clicks, concurrency and simulator restoration; stale marker tokens; 1600x900 and 4K play captures). Raw output in `01-capture-regressions-after.log`. The StudioCaptureService beta flag is off on this machine, so `enabled` fails at the flag check by design; on this shared machine the run was preceded by `set_device_simulator stopSimulation` on the edit peer because other runs leave Studio's persisted simulator setting on (the test asserts it is off at start).
- `node tests/run-with-test-port.mjs tests/run-all.mjs --managed --test studio-tooling-smoke.mjs` -> PASS. `mcp-runtime.test.ts` "keeps the expanded catalog within its token budget": inspector catalog cap 20,000 -> 20,500 characters (`capture_screenshot` gained `target`/`fallback`; descriptions kept under 64 characters; recorded as an explicit API decision in `docs/token-efficiency.md`).
