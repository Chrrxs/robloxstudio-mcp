# 09 — minimized Studio window (field report #9, P2, capture half)

Scope of this PR: `capture_screenshot` restores and foregrounds a minimized Studio window; the window lookup / title helpers are exported from `host-capture.ts` for the `get_connected_instances` half (`windowTitle`/`windowHandle`), which lives in another PR.

## Symptom / reproduction

Command: `node tests/run-with-test-port.mjs tests/run-all.mjs --managed --test field-2026-09-15/09-minimized-window-capture.mjs` (unfixed code; raw output in `09-before.log`). The test finds the managed baseplate's window through `manage_instance status` -> `pid` (`listStudioWindows`; falls back to a `placeName` match when there is no pid), minimizes it during play with `ShowWindow(h, SW_MINIMIZE)`, calls `capture_screenshot`, and checks that the `IsIconic` state of the user's other Studio windows did not change.

```
(09-before.log, unfixed server + plugin)
managed window: {"title":"...\rsmcp-runner-rI7Vtt\RunnerBaseplate.rbxl - Roblox Studio","handle":5050374,"iconic":false,"pid":60376}; untouched windows: 3
solo_playtest start play -> client-1
ShowWindow(5050374, SW_MINIMIZE) -> {"iconic":true,"ok":true}
capture_screenshot (minimized) -> 1570ms {"width":1608,"height":772,... "Warning: Studio's CaptureService returned a blank (single-colour) frame and host window capture also failed (could not pick a Studio window for 'RunnerBaseplate.rbxl' among: ...4 windows...), so this image may be blank."}
    image 1608x772, 1 unique colours
window state after capture: {"iconic":true,"foreground":false,"visible":true}
FAILED: capture from a minimized window is a single colour (1)
```
(An earlier red attempt failed with "expected exactly one Studio window ... found 2": another agent's managed Studio was open with the same `RunnerBaseplate.rbxl` name -> the test now finds the window by the `manage_instance status` `pid`.)

## Fix

- `packages/core/src/host-capture.ts`: the PowerShell helper checks `IsIconic` -> `ShowWindow(h, 9 /*SW_RESTORE*/)` + `BringToFront` (`SetForegroundWindow`; on failure the Alt-key `keybd_event` trick and a retry) + a 400 ms settle; the result reports `restored` and `foreground`. `method:'screen'`, and the second attempt of `auto`, also bring the window to the front (required for a screen copy).
- Exported helpers (for the other half of #9): `listStudioWindows(): Promise<{ok:true, windows: StudioWindowInfo[]} | {ok:false,error}>` (`StudioWindowInfo = {handle, pid, title, placeName, isIconic}`), `findStudioWindow(titleHint, pid)`, `studioWindowMatchesHint(title, hint)`, `studioWindowPlaceName(title)`.
- `packages/core/src/tools/index.ts`: the result carries `window: {title, handle, width, height, method, restored, foreground}`; `restored`/`foreground` from the marker grab and the clean grab are merged.

## After

Same command on the final branch (raw output in `09-after.log`):

```
2026-09-15 14:04 (final branch); manage_instance status -> pid=62208; managed window {"title":"...smcp-runner-behYcl\RunnerBaseplate.rbxl - Roblox Studio","handle":18419638,"iconic":false,"pid":62208}; untouched windows: 3 (the user's three Studios, two of them minimized)
solo_playtest start play -> client-1
ShowWindow(18419638, SW_MINIMIZE) -> {"iconic":true,"ok":true}
capture_screenshot (minimized) -> 2748ms {"width":1608,"height":772,"peer":"client-1","target":"auto","source":"host-window","cropped":true,"viewportRect":{"x":3,"y":188,"width":1608,"height":772},
   "window":{"title":"...RunnerBaseplate.rbxl - Roblox Studio","handle":18419638,"width":1920,"height":1009,"method":"printwindow","restored":true,"foreground":true},
   "message":"... Captured from the Studio window through the host OS (printwindow) because Studio's CaptureService returned a blank (single-colour) frame."}
    image 1608x772, 8248 unique colours
window state after capture: {"iconic":false,"foreground":true,"visible":true}
other Studio windows unchanged (3)      (the IsIconic state of every other Studio window is the same as before)
RESULT IsIconic=false, image 1608x772/8248c, restored=true, method=printwindow
PASSED: field #9 capture_screenshot restores a minimized Studio window     1/1 passed.
```

Before -> after: minimized window gives 1608x772 **1 colour** and stays `IsIconic=true` -> 1608x772, **8,248 colours**, `IsIconic=false`, `window.restored=true`, `foreground=true`, 2.7 s.

## Regression

- `npm run typecheck` green.
- `npm run lint`: only the pre-existing errors; no new ones.
- `npm test -w packages/core`: 39 suites / 713 tests green.
