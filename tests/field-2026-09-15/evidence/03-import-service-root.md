# Field report #3 — import_rbxm: service/container-rooted rbxm

Test: `tests/field-2026-09-15/03-import-service-root.mjs`
Command: `node tests/run-with-test-port.mjs tests/run-all.mjs --managed --test field-2026-09-15/03-import-service-root.mjs`

## Symptom / reproduction (before the fix, 2026-09-15 11:18)

Scenario on a managed baseplate: create 2 LocalScripts under `StarterPlayer.StarterCharacterScripts` (`execute_luau`) → `export_rbxm instance_paths=["game.StarterPlayer.StarterCharacterScripts"]` → delete the children → `import_rbxm source.path=… parent_path="game.StarterPlayer.StarterCharacterScripts"`.

Raw error (Roblox's pcall message verbatim): `Cannot change Parent of type StarterCharacterScripts`. Note: this is not the "The Parent property of X is locked" text guessed in the report, and StarterCharacterScripts is not a service either (`game:GetService("StarterCharacterScripts")` throws); it is StarterPlayer's fixed singleton child. The deserialized root is a fresh instance of that service-like class and its Parent assignment is rejected.

Output of the test before the fix (the test was then named `TODO#3`; the run lived in worktree `wt/C`):

```
##### RED 03-import-service-root 2026-09-15T11:18:52+03:00
Test process using port 61369 (automatically assigned)
Full integration suite using port 61369 (from ROBLOX_STUDIO_PORT)
Installing worktree plugin C:\Users\<user>\Desktop\mcp\wt\C\studio-plugin\MCPPlugin.rbxmx
Installed MCPPlugin.rbxmx to C:\Users\<user>\AppData\Local\Temp\robloxstudio-mcp-workers\run-all-H1VCks\RsmcpIsolatedPlugins\MCPPlugin.rbxmx
Launched managed Studio instance instance:6as-bop

=== TODO#3 import_rbxm with a service-rooted rbxm ===
  ✓ managed instance id is set
[2026-09-15T08:19:08.911Z] setup: {"returnValue":"2","message":"Code executed successfully","success":true,"output":[]}
  ✓ execute_luau created 2 LocalScripts under StarterCharacterScripts
[2026-09-15T08:19:08.943Z] export_rbxm(StarterCharacterScripts): {"bytes_written":1186,"instance_count":1,"output_path":"C:\\Users\\<user>\\AppData\\Local\\Temp\\rsmcp-todo03-n9IwHo\\scs.rbxm"}
  ✓ service-rooted rbxm exported
  ✓ StarterCharacterScripts emptied before import
[2026-09-15T08:19:08.976Z] import_rbxm(parent_path=StarterCharacterScripts): {"body":{"error":"failed to parent StarterCharacterScripts (StarterCharacterScripts) under game.StarterPlayer.StarterCharacterScripts: Cannot change Parent of type StarterCharacterScripts"},"isError":true}

❌ TODO#3 import_rbxm with a service-rooted rbxm FAILED: import_rbxm rejected the service-rooted rbxm: failed to parent StarterCharacterScripts (StarterCharacterScripts) under game.StarterPlayer.StarterCharacterScripts: Cannot change Parent of type StarterCharacterScripts

--- todo-03-import-service-root stderr tail ---
responseMode: 'json' drops mid-call notifications. subscriptions/listen streams are always served over SSE regardless; other notifications emitted before a result are dropped.
Port 61369 in use, trying next...
Port 61369 in use - entering proxy mode (forwarding to localhost:61369)
robloxstudio-mcp v3.1.4 running on stdio
MCP server active in proxy mode - forwarding requests to primary
Waiting for Studio plugin to connect...
Closed managed Studio instance instance:6as-bop

========== SUMMARY ==========
  ❌ FAIL  todo-2026-09-15/03-import-service-root.mjs

0/1 passed.
##### EXIT=1 2026-09-15T11:19:13+03:00
```

## Fix

- `studio-plugin/src/modules/handlers/SerializationHandlers.ts` (importRbxm): when a deserialized root (a) is a real service class (`game:GetService(ClassName)` succeeds) or (b) has its Parent assignment rejected with a message containing "Cannot change Parent" / "locked", the root's CHILDREN are parented under `parent_path` and the empty root shell is destroyed; the result carries `unwrappedServiceRoot: "<ClassName>"` (plus `unwrappedServiceRoots: [...]`). Every other Parent failure still returns Roblox's raw pcall text (`failed to parent X (Class) under P: <Roblox message>`) and the all-or-nothing rollback is kept.
- `packages/core/src/tools/definitions.ts`: `import_rbxm` description (single sentence, within the 120-character budget).

## After the fix (same command, 2026-09-15 13:51)

- `import_rbxm` result: `unwrappedServiceRoot: "StarterCharacterScripts"`, `instanceCount: 2`, `rootClasses: ["LocalScript","LocalScript"]`, paths `game.StarterPlayer.StarterCharacterScripts.__RSMCP_ImportA/B`.
- `execute_luau` verification: `count=2`, both LocalScript, no nested StarterCharacterScripts (`service=false`).
- Regression: a ScreenGui-rooted rbxm with `parent_path="game.StarterGui"` → `instance_count: 1`, no `unwrappedServiceRoot`, both descendants in place.

```
##### GREEN 03-import-service-root 2026-09-15T13:51+03:00
Test process using port 53491 (automatically assigned)
Full integration suite using port 53491 (from ROBLOX_STUDIO_PORT)
Installing worktree plugin C:\Users\<user>\Desktop\mcp\wt-a\studio-plugin\MCPPlugin.rbxmx
Installed MCPPlugin.rbxmx to C:\Users\<user>\AppData\Local\Temp\robloxstudio-mcp-workers\run-all-KTgSd5\RsmcpIsolatedPlugins\MCPPlugin.rbxmx
Launched managed Studio instance instance:0sd-yxt

=== field #3 import_rbxm with a service-rooted rbxm ===
  ✓ managed instance id is set
[2026-09-15T10:51:48.435Z] setup: {"returnValue":"2","message":"Code executed successfully","success":true,"output":[]}
  ✓ execute_luau created 2 LocalScripts under StarterCharacterScripts
[2026-09-15T10:51:48.467Z] export_rbxm(StarterCharacterScripts): {"bytes_written":1187,"instance_count":1,"output_path":"C:\\Users\\<user>\\AppData\\Local\\Temp\\rsmcp-field03-WOHqou\\scs.rbxm","bytes":1187,"instanceCount":3,"rootClass":"StarterCharacterScripts","rootName":"StarterCharacterScripts","rootClasses":["StarterCharacterScripts"],"rootNames":["StarterCharacterScripts"]}
  ✓ service-rooted rbxm exported
  ✓ StarterCharacterScripts emptied before import
[2026-09-15T10:51:48.506Z] import_rbxm(parent_path=StarterCharacterScripts): {"body":{"source":"C:\\Users\\<user>\\AppData\\Local\\Temp\\rsmcp-field03-WOHqou\\scs.rbxm","rootClasses":["LocalScript","LocalScript"],"instanceCount":2,"instance_names":["__RSMCP_ImportA","__RSMCP_ImportB"],"instance_paths":["game.StarterPlayer.StarterCharacterScripts.__RSMCP_ImportA","game.StarterPlayer.StarterCharacterScripts.__RSMCP_ImportB"],"unwrappedServiceRoots":["StarterCharacterScripts"],"instance_count":2,"rootNames":["__RSMCP_ImportA","__RSMCP_ImportB"],"unwrappedServiceRoot":"StarterCharacterScripts","parent_path":"game.StarterPlayer.StarterCharacterScripts"},"isError":false}
  ✓ result reports unwrappedServiceRoot: "StarterCharacterScripts"
  ✓ instanceCount equals 2
  ✓ rootClasses are LocalScript
[2026-09-15T10:51:48.527Z] verify: {"returnValue":"{\"classes\":[\"LocalScript\",\"LocalScript\"],\"service\":false,\"count\":2,\"names\":[\"__RSMCP_ImportA\",\"__RSMCP_ImportB\"]}","message":"Code executed successfully","success":true,"output":[]}
  ✓ StarterCharacterScripts has 2 children after import
  ✓ every child is a LocalScript
  ✓ child names match the exported scripts
  ✓ no nested StarterCharacterScripts instance was left behind
  ✓ regression: ScreenGui with 2 descendants created in StarterGui
[2026-09-15T10:51:48.583Z] export_rbxm(StarterGui child): {"bytes_written":5693,"instance_count":1,"output_path":"C:\\Users\\<user>\\AppData\\Local\\Temp\\rsmcp-field03-WOHqou\\gui.rbxm","bytes":5693,"instanceCount":3,"rootClass":"ScreenGui","rootName":"__RSMCP_ImportRegression","rootClasses":["ScreenGui"],"rootNames":["__RSMCP_ImportRegression"]}
[2026-09-15T10:51:48.617Z] import_rbxm(parent_path=StarterGui): {"instance_paths":["game.StarterGui.__RSMCP_ImportRegression"],"rootClasses":["ScreenGui"],"source":"C:\\Users\\<user>\\AppData\\Local\\Temp\\rsmcp-field03-WOHqou\\gui.rbxm","instance_count":1,"rootNames":["__RSMCP_ImportRegression"],"parent_path":"game.StarterGui","instanceCount":3,"instance_names":["__RSMCP_ImportRegression"]}
  ✓ regression: non-service import still parents 1 root
  ✓ regression: no unwrappedServiceRoot for a ScreenGui root
  ✓ regression: ScreenGui round-trips into StarterGui with its 2 descendants

✅ field #3 import_rbxm with a service-rooted rbxm PASSED
Closed managed Studio instance instance:0sd-yxt

========== SUMMARY ==========
  ✅ PASS  field-2026-09-15/03-import-service-root.mjs

1/1 passed.
##### EXIT=0
```

## Regression checks (2026-09-15, worktree `wt-a`, branch `field/serialization-properties`)

- `npm run typecheck`: exit 0
- `npm run lint`: 48 problems = 8 errors + 40 warnings; all 8 errors pre-exist on `origin/main` (install-plugin-helpers.ts:254-257, opencloud-client.ts:445, studio-instance-manager.ts:2120, install-plugin.ts `_chunk` x2); no new ones
- `npm test -w packages/core`: Test Suites 38/38, Tests 696/696 green
- `npm run build:plugin:artifact`: 39 modules (PropertyAccess.ts added; 38 before)
- `node tests/run-with-test-port.mjs tests/run-all.mjs --managed --test studio-tooling-smoke.mjs`: PASS (73 checks, including get_instance_properties/export_rbxm/import_rbxm)
- Managed Studio launches timed out several times on this run (`manage_instance` status did not report the plugin within 120 s while several other Studio instances were running); the green output below is the first attempt in which Studio launched
