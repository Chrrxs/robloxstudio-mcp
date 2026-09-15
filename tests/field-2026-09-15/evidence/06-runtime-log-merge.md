# Field report #6 + #15 — `get_runtime_logs`: error + source line + stack merged into one entry, dedupe, level/since_ts/exclude

Raw output: `raw-06-jest-red.txt`, `raw-06-studio-red.txt`, `raw-06-studio-red2-clientbroker.txt`, `raw-06-studio-red3-level-message.txt`, `raw-06-studio-launch-timeout.txt` (all "before", captured while the tests were still named `todo-06` and used `TODO6` identifiers), `raw-06-studio-green.txt`, `raw-06-08-16-jest-green.txt`.

## Symptom / reproduction

Tests:
- `packages/core/src/__tests__/field-06-runtime-log-merge.test.ts` — loads `studio-plugin/src/modules/RuntimeLogBuffer.ts` in Node through esbuild + `vm` (`@rbxts/services` external, `LogService.MessageOut` stub) and feeds the `MessageError` + `Stack Begin` + `Script '…', Line N` + `Stack End` sequence.
- `runtime-log-context.test.ts`, "field #15" describes — the core `getRuntimeLogs` forwards `level/sinceTs/exclude/dedupe` to each Peer request, rejects invalid values before anything reaches Studio, and the client Peer path (`ClientBroker`) goes through `LogHandlers`.
- `tests/field-2026-09-15/06-runtime-log-merge.mjs` (managed) — stages `StarterGui.Field6Gui` with two disabled LocalScripts in the edit DataModel (`Field6Once`: `error("Field6 boom once")`; `Field6Five`: 5 × `task.spawn(function() error("Field6 boom five") end)`), then enables them from `eval_client_runtime` during play.

Commands: `npm test -w packages/core -- field-06 runtime-log-context`, `node tests/run-with-test-port.mjs tests/run-all.mjs --managed --test field-2026-09-15/06-runtime-log-merge.mjs`

Jest before:

```
    src/__tests__/runtime-log-context.test.ts:288:7 - error TS2554: Expected 0-7 arguments, but got 8.
  ● TODO #6 runtime log merge › one runtime error becomes one entry with script, line, and stack
      Array [
        "before",
        "Players.Player1.PlayerGui.TODO6Gui.TODO6Once:5: TODO6 boom",
    +   "Stack Begin",
    +   "Script 'Players.Player1.PlayerGui.TODO6Gui.TODO6Once', Line 5",
    +   "Stack End",
Tests:       6 failed, 1 passed, 7 total
```

Studio before, run 1 (2026-09-15 11:28, `instance:bp2-96w`, unpatched plugin) — one error arrives as two entries:

```
  [raw filter=TODO6] [{"message":"Players.<user>.PlayerGui.TODO6Gui.TODO6Once:1: TODO6 boom once","ts":1789460877.879,"level":"ERR","data":[]},{"message":"Script 'Players.<user>.PlayerGui.TODO6Gui.TODO6Once', Line 1","ts":1789460877.879,"level":"INFO","data":[]}]
❌ ... FAILED: ASSERT FAIL: one error yields exactly one entry mentioning TODO6Once (got 2)
```

Studio before, run 2 (11:40, `instance:mzm-lcc`, merge already in place) — `level:"INFO"` still returned the ERR entry. Cause: client Peer requests go through `ClientBroker.handleGetRuntimeLogs`, which forwarded only `since/tail/filter`:

```
  [level=INFO filter=TODO6] [{"message":"...TODO6Once:1: TODO6 boom once","level":"ERR","script":"Players.<user>.PlayerGui.TODO6Gui.TODO6Once","line":1,"stack":["Script '...TODO6Once', Line 1"],...}]
❌ ... FAILED: ASSERT FAIL: no separate INFO "Script ..., Line N" entry remains (got 1)
```

Run 3 (`raw-06-studio-red3-level-message.txt`) failed only on the assertion text for an invalid `level`: the MCP schema enum rejects it first with "allowed values", so the assertion accepts either the schema message or the server message. `raw-06-studio-launch-timeout.txt` (11:41): the managed Studio edit connection hit the `manage_instance` timeout — infrastructure, rerun without code changes.

## Fix

- `studio-plugin/src/modules/RuntimeLogBuffer.ts`: merging happens **at read time** (`mergeStackFrames` inside `query`): an `ERR` entry followed immediately by `INFO "Stack Begin"` … `INFO "Stack End"` becomes one entry; `stack[]` holds the lines in between, `script`/`line` come from the first frame matching `^Script '(.-)', Line (%d+)`. Rationale: LogService emits the error and its trace lines back to back in one engine call and a plugin request cannot interleave with that emission, so a timer (250 ms settle) would add latency without adding correctness, whereas read-time merging is deterministic and leaves the buffer contract (`seq`/`since`) untouched. Unterminated traces or traces not preceded by an `ERR` stay as they are. Then, in order: `level`, `sinceTs` (values above 1e11 are treated as milliseconds and divided by 1000), `filter`, `exclude` (literal substring; no regex in the plugin), `dedupe` (key `level|script|line|message` → first entry plus `count`; repeats update `firstTs/lastTs`), and `tail` last.
- `studio-plugin/src/modules/handlers/LogHandlers.ts`: validation of the new parameters (`level must be one of ERR, WARN, INFO, OUT` and so on).
- `studio-plugin/src/modules/ClientBroker.ts`: `handleGetRuntimeLogs` → `LogHandlers.getRuntimeLogs(data ?? {})` so the filters survive on the client Peer.
- `packages/core/src/tools/index.ts`: `getRuntimeLogs(..., signal, options)` — `level` (ERR|WARN|INFO|OUT), `since_ts` (≥ 0), `exclude` (string), `dedupe` (boolean) are validated and sent to every Peer request as `level/sinceTs/exclude/dedupe`. `http-server.ts` handler, `definitions.ts` schema (`level` enum, `since_ts`, `exclude`, `dedupe`), `tool-schema.test.ts` property list.

Dedupe runs per Peer; the core does not dedupe again when it merges several Peers (the same message on edit + server + client stays three entries).

## After

Jest: `field-06-runtime-log-merge.test.ts` 7/7, `runtime-log-context.test.ts` 7/7 (final branch: 41 suites / 714 tests, `raw-06-08-16-jest-green.txt`).

Studio (same command, final branch, 2026-09-15 13:14, `instance:ogc-gp6`, client-1 Peer errors; `raw-06-studio-green.txt`):

```
Launched managed Studio instance instance:ogc-gp6
  [raw filter=Field6] [{"message":"Players.<user>.PlayerGui.Field6Gui.Field6Once:1: Field6 boom once","ts":1789467322.698,"script":"Players.<user>.PlayerGui.Field6Gui.Field6Once","data":[],"level":"ERR","stack":["Script 'Players.<user>.PlayerGui.Field6Gui.Field6Once', Line 1"],"line":1}]
  [level=INFO filter=Field6] []
  [level=error] "Input validation error: Invalid arguments for tool get_runtime_logs: data/level must be equal to one of the allowed values"
  ✓ five identical errors are five merged entries without dedupe (got 5)
  [dedupe=true] [{"lastTs":1789467323.732,"ts":1789467323.732,"script":"Players.<user>.PlayerGui.Field6Gui.Field6Five","data":[],"message":"Players.<user>.PlayerGui.Field6Gui.Field6Five:3: Field6 boom five","firstTs":1789467323.732,"count":5,"stack":["Script 'Players.<user>.PlayerGui.Field6Gui.Field6Five', Line 3"],"level":"ERR","line":3}]
  [since_ts seconds] ["Players.<user>.PlayerGui.Field6Gui.Field6Five:3: Field6 boom five", ... ×5]
  ✓ since_ts (milliseconds) is accepted too (got 5)
  [exclude=five] ["Players.<user>.PlayerGui.Field6Gui.Field6Once:1: Field6 boom once"]
✅ field #6/#15: runtime error merge, level/since_ts/exclude, dedupe PASSED
Closed managed Studio instance instance:ogc-gp6
1/1 passed.
```

Runner exit code 0.

## Regression

- `npm run typecheck` green.
- `npm run lint`: 8 errors / 40 warnings, all pre-existing on `origin/main`; no new ones.
- `npm test -w packages/core`: 41 suites / 714 tests green.
- `execute-luau-output-capture.mjs` (runtime logs `data` contract) and `studio-grep-responsiveness.mjs` rerun on the final branch; see the PR description.
