# 11 (+ the instances half of #9) — `get_connected_instances`: `playtest {active, mode, startedAt}` + `windowTitle` / `processId`

Field report #11 and #9. Branch `field/playtest-restart-instances`, 2026-09-15, on top of `de752b5` (upstream `dddd037` + harness).

## Symptom / reproduction

Command (from the worktree, managed baseplate):

```
node tests/run-with-test-port.mjs tests/run-all.mjs --managed --test field-2026-09-15/11-connected-instances-playtest.mjs
```

Before the fix (raw output of the same test against the unpatched server, 2026-09-15 ~11:20 local; the test and
folder still carried their pre-rename names at the time):

```
=== TODO#11 get_connected_instances playtest + window ===
{"step":"before-play","instance":{"id":"instance:29t-38i","placeId":0,"placeName":"RunnerBaseplate.rbxl","peers":{"edit":"peer:9pn-kjs"}}}
  ✓ get_connected_instances lists instance:29t-38i
❌ TODO#11 get_connected_instances playtest + window FAILED: ASSERT FAIL: playtest field present before play
========== SUMMARY ==========
  ❌ FAIL  todo-2026-09-15/11-connected-instances-playtest.mjs
0/1 passed.
EXIT 1
```

An instance carried four fields (`id`, `placeId`, `placeName`, `peers`); play state had to be guessed from `peers`,
there was no mode or start time, and no way to tell which Studio window belonged to which instance.

Jest before the fix: `field-11-connected-instances-playtest.test.ts` fails on the missing `playtest` field and the
missing `windowTitle`/`processId` (and the `studioWindowLookup` seam does not exist).

## Fix

- `packages/core/src/bridge-service.ts`: `ConnectedPlaytestState` type; `playtestStateOf(instance)` — with at least
  one runtime peer (server / client-N) the state is `active:true`; `mode` is `"multiplayer"` for a multiplayer group,
  `"play"` when a client peer exists, `"run"` when only a server peer exists; `startedAt` is the earliest runtime peer
  `connectedAt` as an ISO string. Without runtime peers the state is `{active:false}`. `ConnectedStudioInstance`
  gains the `playtest` field.
- `packages/core/src/tools/index.ts` (`getConnectedInstances`): `windowTitle` + `processId` per instance. Source:
  `observeStudioProcesses()` (existing export of `studio-instance-manager.ts`; `Get-Process RobloxStudioBeta` →
  `Id`, `MainWindowTitle`). Matching: the " - Roblox Studio" suffix and any directory path are stripped from the
  window title (for local files the title is the full path, e.g. `C:\…\RunnerBaseplate.rbxl - Roblox Studio`), and the
  remainder is compared with and without the `.rbxl`/`.rbxlx` extension against the peer's `dataModelName` /
  `placeName`. Exactly one match → fields written; 0 or >1 matches → resolved through the managed-launch pid
  (`instanceManager.get(id).nativeProcessId ?? spawnPid`), otherwise the fields are omitted (no window is better than
  the wrong window). The process list is cached for 2 s (`STUDIO_WINDOW_SNAPSHOT_TTL_MS`; `waitForEditPeer` polls
  every 500 ms). The plugin cannot read its own window title, so this is server side; `host-capture.ts` is untouched.
- Unit tests replace the private `studioWindowLookup` with a fake snapshot so jest never spawns PowerShell
  (`proxy-runtime-logs.test.ts` ×3, `smoke.test.ts` ×1, the new test file).
- `packages/core/src/__tests__/mcp-runtime.test.ts`: the `get_connected_instances` fixture gains `playtest:{active:false}`.

## Green

Same command on the final branch (2026-09-15 10:51 UTC, freshly built `dist`):

```
Test process using port 59368 (automatically assigned)
Full integration suite using port 59368 (from ROBLOX_STUDIO_PORT)
Installing worktree plugin C:\Users\<user>\Desktop\mcp\wt-b\studio-plugin\MCPPlugin.rbxmx
Installed MCPPlugin.rbxmx to C:\Users\<user>\AppData\Local\Temp\robloxstudio-mcp-workers\run-all-2XAvdb\RsmcpIsolatedPlugins\MCPPlugin.rbxmx
Launched managed Studio instance instance:m87-5tx

=== field #11 get_connected_instances playtest + window ===
{"step":"before-play","instance":{"id":"instance:m87-5tx","placeId":0,"placeName":"RunnerBaseplate.rbxl","peers":{"edit":"peer:4yr-b6j"},"playtest":{"active":false},"windowTitle":"C:\\Users\\<user>\\AppData\\Local\\Temp\\rsmcp-runner-gb48gt\\RunnerBaseplate.rbxl - Roblox Studio","processId":60576}}
  ✓ get_connected_instances lists instance:m87-5tx
  ✓ playtest field present before play
  ✓ playtest.active is false before play
  ✓ windowTitle is a string (got "C:\\Users\\<user>\\AppData\\Local\\Temp\\rsmcp-runner-gb48gt\\RunnerBaseplate.rbxl - Roblox Studio")
  ✓ windowTitle "C:\Users\<user>\AppData\Local\Temp\rsmcp-runner-gb48gt\RunnerBaseplate.rbxl - Roblox Studio" contains place name "RunnerBaseplate.rbxl"
  ✓ processId is a positive integer (got 60576)
  ✓ start succeeds
{"step":"during-play","instance":{"id":"instance:m87-5tx","placeId":0,"placeName":"RunnerBaseplate.rbxl","peers":{"edit":"peer:4yr-b6j","server":"peer:072-1oc","client-1":"peer:v7f-xji"},"playtest":{"active":true,"mode":"play","startedAt":"2026-09-15T10:51:29.351Z"},"windowTitle":"C:\\Users\\<user>\\AppData\\Local\\Temp\\rsmcp-runner-gb48gt\\RunnerBaseplate.rbxl - Roblox Studio","processId":60576}}
  ✓ get_connected_instances lists instance:m87-5tx
  ✓ playtest.active is true during play
  ✓ playtest.mode is "play" (got play)
  ✓ playtest.startedAt is ISO (got 2026-09-15T10:51:29.351Z)
  ✓ playtest.startedAt is recent
  ✓ processId is stable across play
  ✓ stop succeeds
{"step":"after-stop","instance":{"id":"instance:m87-5tx","placeId":0,"placeName":"RunnerBaseplate.rbxl","peers":{"edit":"peer:4yr-b6j"},"playtest":{"active":false},"windowTitle":"C:\\Users\\<user>\\AppData\\Local\\Temp\\rsmcp-runner-gb48gt\\RunnerBaseplate.rbxl - Roblox Studio","processId":60576}}
  ✓ get_connected_instances lists instance:m87-5tx
  ✓ playtest.active is false after stop
  ✓ no mode/startedAt when idle

✅ field #11 get_connected_instances playtest + window PASSED
Closed managed Studio instance instance:m87-5tx

========== SUMMARY ==========
  ✅ PASS  field-2026-09-15/11-connected-instances-playtest.mjs

1/1 passed.
```

Tool: `get_connected_instances {}` → the raw JSON above (three calls: before play / during play / after stop).
`solo_playtest {action:"start", mode:"play", timeout:60}` and `{action:"stop", timeout:30}` succeed.

Jest (`npm test -w packages/core -- field-11`), `field #11 / #9` describe, 6 tests: idle `{active:false}` with no
window fields; play → `mode:"play"` + ISO `startedAt` (earliest runtime peer); server only → `"run"`; a published
title and a full-path `.rbxl` title → the right pid; an ambiguous title (two identical names, no managed record) →
fields omitted.

Before/after: before, 4 fields per instance (`id, placeId, placeName, peers`; play state guessed from `peers`, no
duration, no window) → after, + `playtest` (3 sub-fields) + `windowTitle` + `processId`.

## Regression

- `npm run typecheck`: green.
- `npm run lint`: 8 errors / 40 warnings, all pre-existing on the base (install-plugin-helpers 254–257,
  opencloud-client 445, studio-instance-manager 2120 `while (true)` from upstream c21cc03, install-plugin `_chunk` ×2); none new.
- `npm test -w packages/core`: 40 suites / 708 tests green (12 new across field-02 and field-11).
- Note: with the real `Get-Process` lookup in unit tests, `proxy-runtime-logs.test.ts` hit its 30 s timeout twice
  under parallel jest workers; the fake `studioWindowLookup` removes the process spawn from unit tests entirely.
- Managed-launch infrastructure on a machine with several agents launching Studio at once: this test failed three
  times before any assertion ran (`Timed out waiting for managed instance registry lock`, `manage_instance … aborted
  due to timeout`); the green run above was taken once no managed Studio window was open and at most one other managed run was in flight. Unrelated to the code
  under test.
