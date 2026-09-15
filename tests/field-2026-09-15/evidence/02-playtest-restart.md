# 02 — `solo_playtest action="restart"` (stop + wait + `before_start` + start, mode preserved)

Field report #2. Branch `field/playtest-restart-instances`, 2026-09-15, on top of `de752b5` (upstream `dddd037` + harness).

## Symptom / reproduction

Command (from the worktree, managed baseplate):

```
node tests/run-with-test-port.mjs tests/run-all.mjs --managed --test field-2026-09-15/02-playtest-restart.mjs
```

Before the fix (raw output of the same test against the unpatched server, 2026-09-15 ~11:15 local; the test and
folder still carried their pre-rename names at the time):

```
=== TODO#2 solo_playtest restart ===
{"step":"start","elapsedMs":1584,"result":{"success":true,"action":"start","message":"Playtest started.","roles":["edit","server","client-1"]}}
  ✓ initial start succeeds
  ✓ baseline stop succeeds
  ✓ baseline execute_luau succeeds
  ✓ baseline start succeeds
{"step":"baseline-3-calls","calls":3,"stopMs":1166,"syncMs":15,"startMs":1589,"totalMs":2770}
❌ TODO#2 solo_playtest restart FAILED: Tool solo_playtest returned isError: "Input validation error: Invalid arguments for tool solo_playtest: data/action must be equal to one of the allowed values"
========== SUMMARY ==========
  ❌ FAIL  todo-2026-09-15/02-playtest-restart.mjs
0/1 passed.
EXIT 1
```

In numbers: the old cycle is three tool calls (`stop` 1166 ms + `execute_luau` 15 ms + `start` 1589 ms = 2770 ms on an
empty baseplate; on the real game from the field report a start takes 5–10 s). The `restart` action does not exist in
the schema.

Jest before the fix: `field-02-playtest-restart.test.ts` does not compile — `soloPlaytest(...)` has no 5th parameter
(`before_start`, TS2554); `tool-schema.test.ts` expects the action enum `['start','stop','status']`.

## Fix

Server side only (the plugin is unchanged; `StopPlayMonitor.ts`/`TestHandlers.ts` untouched — the existing
`/api/stop-playtest`, `/api/execute-luau` and `/api/start-playtest` routes are used in sequence):

- `packages/core/src/tools/definitions.ts`: `restart` added to the `action` enum; new optional `before_start` (string);
  `mode` description notes that restart keeps the running session's mode when omitted.
- `packages/core/src/http-server.ts`: the `solo_playtest` dispatcher passes `body.before_start` through.
  `TOOL_PROXY_ENDPOINTS` is deliberately not extended: a proxy allowlist without `execute_luau` makes `before_start`
  fail with `before_start_failed` instead of granting Luau execution through `solo_playtest`.
- `packages/core/src/tools/index.ts`:
  - `soloPlaytest`: accepts `restart`; `before_start` is only accepted together with `restart`.
  - `_restartPlaytest`: (1) `wasRunning` from the runtime peers; if `mode` is omitted it is derived from the active
    session (a client peer means `play`, server only means `run`), otherwise from the last successful `start` on the
    same instance (`lastPlaytestMode`), otherwise an explanatory error before any Studio request. (2) If `wasRunning`,
    `stopPlaytest` (waits for the runtime peers to drop; `runtimeStopped:false` aborts with `phase:"stop"`).
    (3) If `before_start` is given, `executeLuau(code, 'edit')` — same route, sandbox and limits as `execute_luau`;
    on `success!==true` the result is `error:"before_start_failed"` with the `beforeStart` payload and no start.
    (4) `startPlaytest(mode)`; the result carries `wasRunning`, `mode`, `stoppedInMs`, `beforeStartMs`, `startedInMs`,
    `totalMs`, `beforeStart`, `roles`.
  - `startPlaytest`: a successful start records `lastPlaytestMode.set(instanceId, mode)`.
- `packages/core/src/__tests__/tool-schema.test.ts`: enum expectation `['start','stop','status','restart']`.

## Green

Same command on the final branch (2026-09-15 10:16 UTC, freshly built `dist`):

```
Test process using port 55194 (automatically assigned)
Full integration suite using port 55194 (from ROBLOX_STUDIO_PORT)
Installing worktree plugin C:\Users\<user>\Desktop\mcp\wt-b\studio-plugin\MCPPlugin.rbxmx
Installed MCPPlugin.rbxmx to C:\Users\<user>\AppData\Local\Temp\robloxstudio-mcp-workers\run-all-rm1JuP\RsmcpIsolatedPlugins\MCPPlugin.rbxmx
Launched managed Studio instance instance:zei-m17

=== field #2 solo_playtest restart ===
{"step":"start","elapsedMs":2180,"result":{"success":true,"action":"start","message":"Playtest started.","roles":["edit","server","client-1"]}}
  ✓ initial start succeeds
  ✓ baseline stop succeeds
  ✓ baseline execute_luau succeeds
  ✓ baseline start succeeds
{"step":"baseline-3-calls","calls":3,"stopMs":1119,"syncMs":16,"startMs":2662,"totalMs":3797}
{"step":"restart-1-call","calls":1,"wallMs":4358,"result":{"success":true,"message":"Playtest restarted.","action":"restart","mode":"play","wasRunning":true,"stoppedInMs":2221,"beforeStartMs":16,"startedInMs":2087,"totalMs":4324,"beforeStart":{"returnValue":"Workspace.FieldRestartPart","message":"Code executed successfully","success":true,"output":[]},"roles":["edit","server","client-1"]}}
  ✓ restart succeeds: {"success":true,"message":"Playtest restarted.","action":"restart","mode":"play","wasRunning":true,"stoppedInMs":2221,"beforeStartMs":16,"startedInMs":2087,"totalMs":4324,"beforeStart":{"returnValue":"Workspace.FieldRestartPart","message":"Code executed successfully","success":true,"output":[]},"roles":["edit","server","client-1"]}
  ✓ restart echoes action
  ✓ restart reports wasRunning=true while a playtest was active
  ✓ restart preserves the previous play mode when mode is omitted
  ✓ restart reports stoppedInMs
  ✓ restart reports startedInMs
  ✓ restart totalMs within 60 s (got 4324)
  ✓ before_start ran on the edit peer
  ✓ before_start output returned (got {"returnValue":"Workspace.FieldRestartPart","message":"Code executed successfully","success":true,"output":[]})
{"step":"eval_server_runtime","result":{"ok":true,"bridge":"ok","result":"true","output":[]}}
  ✓ new play session sees the Part written before start: {"ok":true,"bridge":"ok","result":"true","output":[]}
{"step":"connected-after-restart","playtest":{"active":true,"mode":"play","startedAt":"2026-09-15T10:16:17.719Z"}}
  ✓ play session is active after restart
  ✓ stop after restart succeeds
{"step":"restart-when-idle","wallMs":2091,"result":{"success":true,"message":"No playtest was running; playtest started.","action":"restart","mode":"play","wasRunning":false,"stoppedInMs":0,"startedInMs":2087,"totalMs":2087,"roles":["edit","server","client-1"]}}
  ✓ idle restart is a plain start: {"success":true,"message":"No playtest was running; playtest started.","action":"restart","mode":"play","wasRunning":false,"stoppedInMs":0,"startedInMs":2087,"totalMs":2087,"roles":["edit","server","client-1"]}
  ✓ idle restart reports wasRunning=false
  ✓ idle restart reuses the last known mode
  ✓ idle restart spends no time stopping
  ✓ final stop succeeds
{"summary":{"before":{"calls":3,"totalMs":3797,"startMs":2662},"after":{"calls":1,"totalMs":4324,"stoppedInMs":2221,"startedInMs":2087,"wallMs":4358},"initialStartMs":2180}}

✅ field #2 solo_playtest restart PASSED
Closed managed Studio instance instance:zei-m17

========== SUMMARY ==========
  ✅ PASS  field-2026-09-15/02-playtest-restart.mjs

1/1 passed.
```

Tool calls and raw results:
- `solo_playtest {action:"restart", timeout:60, before_start:"local p = Instance.new(\"Part\") p.Name = \"FieldRestartPart\" … p.Parent = workspace return p:GetFullName()"}` (no `mode`) → the `restart-1-call` JSON above.
- `eval_server_runtime {code:"return workspace:FindFirstChild(\"FieldRestartPart\") ~= nil and workspace:FindFirstChild(\"FieldRestartBaselinePart\") ~= nil"}` → `{"ok":true,"bridge":"ok","result":"true"}` — the Part written to the edit DataModel by `before_start` is visible in the new play session.
- `solo_playtest {action:"restart", timeout:60}` with no playtest running → `wasRunning:false`, `mode:"play"` (from the last start), `stoppedInMs:0`.

Before/after (same Studio, empty baseplate): before, 3 calls / 3797 ms total (stop 1119 + sync 16 + start 2662);
after, 1 call / 4324 ms (stop 2221 + before_start 16 + start 2087). Call count 3 → 1; wall time is in the same range
(the start is Studio's own cost; the restart's stop phase waits for the runtime peers to actually drop, which the
bare `stop` call does not). The 20–30 s saving from the field report comes from holding the concurrent-agent playtest
lock for one call instead of three. `totalMs` ≤ 60 s: 4324 ms.

Jest (`npm test -w packages/core -- field-02`), `field #2` describe, 6 tests: schema (`restart` + `before_start`);
stop → execute-luau → start endpoint order with `mode:"play"` preserved and the `beforeStart` payload; server only →
`run`; restart while idle = plain start (`wasRunning:false, stoppedInMs:0`, last mode); neither a session nor a known
mode → error with no Studio request; `before_start` failure → `before_start_failed`, no start.

## Regression

- `npm run typecheck`: green.
- `npm run lint`: 8 errors / 40 warnings, all pre-existing on the base (install-plugin-helpers 254–257,
  opencloud-client 445, studio-instance-manager 2120 `while (true)` from upstream c21cc03, install-plugin `_chunk` ×2); none new.
- `npm test -w packages/core`: 40 suites / 708 tests green (base 697 + 11 new).
