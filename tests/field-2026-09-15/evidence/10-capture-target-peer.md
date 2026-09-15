# 10 — `capture_screenshot` client peer selection in play mode (field report #10, P2)

## Symptom / reproduction

Command: `node tests/run-with-test-port.mjs tests/run-all.mjs --managed --test field-2026-09-15/10-capture-target-peer.mjs` (unfixed code; raw output in `10-before.log`). Captures in play mode without `target`, with `target:"client-1"`, `target:"server"`, `target:"client-7"`, and in edit mode with `target:"edit"`; the result must carry `peer`/`target` and error text must name the peer that was tried.

```
(10-before.log, unfixed server)
capture_screenshot {"target":"edit"} (edit) -> 723ms {"width":1324,"height":772,"format":"png",...}  image 1324x772, 2758 unique colours   <- NO peer/target fields
solo_playtest start play -> client-1
capture_screenshot {}                -> 1458ms {"width":1608,"height":772,... "Warning: Studio's CaptureService returned a blank (single-colour) frame and host window capture also failed (could not pick a Studio window for 'RunnerBaseplate.rbxl' among: ...4 windows...)"}  image 1608x772, 1 unique colours
capture_screenshot {"target":"client-1"} -> 1255ms  same; no peer field; target ignored
capture_screenshot {"target":"server"}   -> 1257ms  isError=false, same blank frame (server is not rejected)
capture_screenshot {"target":"client-7"} -> 1336ms  isError=false, same blank frame (a peer that is not connected is not rejected)
FAILED: play mode without target must use client-1   (+ actual: undefined, - expected: 'client-1')
```

## Fix

- `packages/core/src/tools/index.ts`: `_resolveCapturePeer(instance_id, target)` — no `target` / `auto` -> the lowest `client-N` during play, otherwise `edit` (the previous behavior); `edit`/`client-N` select a peer explicitly (an error plus the list of connected peers when it is not connected); `server` -> "does not render a viewport; use client-1 or edit". Every result carries `peer` (used) and `target` (requested or `auto`); every error text ends with `(peer tried: <peer>; target: <target>)` and the JSON carries `peer`.
- `packages/core/src/tools/definitions.ts`: `capture_screenshot.inputSchema.target`; `packages/core/src/http-server.ts` parameter pass-through.
- Unit: `host-capture.test.ts` > "target selects the peer explicitly and rejects peers that cannot render", "keeps the Studio error ... peer tried: client-1".

## After

Same command on the final branch (raw output in `10-after.log`):

```
2026-09-15 14:04 (final branch)
capture_screenshot {"target":"edit"}  -> 620ms {"width":1324,"height":772,"peer":"edit","target":"edit","source":"CaptureService","cropped":true}   image 1324x772, 2758 unique colours
solo_playtest start play -> client-1 (edit+server+client-1)
capture_screenshot {}                 -> 2268ms {"width":1608,"height":772,"peer":"client-1","target":"auto","source":"host-window","cropped":true,"viewportRect":{"x":3,"y":188,"width":1608,"height":772},"window":{..."method":"printwindow"...}}   image 1608x772, 6379 unique colours
capture_screenshot {"target":"client-1"} -> 1440ms {"width":1608,"height":772,"peer":"client-1","target":"client-1","source":"host-window",...}   image 1608x772, 10291 unique colours
capture_screenshot {"target":"server"}   -> 4ms isError=true {"error":"tool_failed","message":"capture_screenshot target \"server\" was requested, but the play server does not render a viewport; use target \"client-1\" (the play client) or \"edit\". Connected peers: client-1, edit, server."}
capture_screenshot {"target":"client-7"} -> 2ms isError=true {"error":"tool_failed","message":"capture_screenshot target \"client-7\" is not connected on instance:mol-g67. Connected peers: client-1, edit, server."}
RESULT auto=client-1/host-window explicit=client-1/host-window
PASSED: field #10 capture_screenshot target peer selection     1/1 passed.
```

Before -> after: no `peer` field / `target` ignored / `server` and `client-7` silently return a blank frame -> `peer:"client-1"`, `target:"auto"|"client-1"`, `server` rejected in 4 ms with an explanation, `client-7` rejected in 2 ms with the peer list; capture error text ends with `(peer tried: <peer>; target: <target>)` (unit: host-capture.test.ts "keeps the Studio error...", "explains a marker miss...").

## Regression

- `npm run typecheck` green.
- `npm run lint`: only the pre-existing errors; no new ones.
- `npm test -w packages/core`: 39 suites / 713 tests green.
