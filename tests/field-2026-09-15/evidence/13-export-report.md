# Field report #13 + #14 — export_rbxm / import_rbxm size and count report

Test: `tests/field-2026-09-15/13-export-report.mjs` (both items in one test)
Command: `node tests/run-with-test-port.mjs tests/run-all.mjs --managed --test field-2026-09-15/13-export-report.mjs`

## Symptom / reproduction (before the fix, 2026-09-15 11:19)

`export_rbxm` of 1 Folder + 5 Parts (6 instances) → only `{"bytes_written":3292,"instance_count":1,"output_path":…}` (instance_count = number of roots; no descendant count, no root class/name). `import_rbxm` likewise returned only the root names/paths.

Output of the test before the fix (the test was then named `TODO#13/#14`; the run lived in worktree `wt/C`):

```
##### RED 13-export-report 2026-09-15T11:19:32+03:00
Test process using port 53919 (automatically assigned)
Full integration suite using port 53919 (from ROBLOX_STUDIO_PORT)
Installing worktree plugin C:\Users\<user>\Desktop\mcp\wt\C\studio-plugin\MCPPlugin.rbxmx
Installed MCPPlugin.rbxmx to C:\Users\<user>\AppData\Local\Temp\robloxstudio-mcp-workers\run-all-iRuY11\RsmcpIsolatedPlugins\MCPPlugin.rbxmx
Launched managed Studio instance instance:v2a-x7f

=== TODO#13/#14 export_rbxm and import_rbxm size/count reports ===
  ✓ managed instance id is set
[2026-09-15T08:19:47.826Z] setup: {"returnValue":"6","message":"Code executed successfully","success":true,"output":[]}
  ✓ tree has 6 instances including the root
[2026-09-15T08:19:47.858Z] export_rbxm: {"bytes_written":3292,"instance_count":1,"output_path":"C:\\Users\\<user>\\AppData\\Local\\Temp\\rsmcp-todo13-k5lTrR\\tree.rbxm"}

❌ TODO#13/#14 export_rbxm and import_rbxm size/count reports FAILED: ASSERT FAIL: bytes (undefined) equals the file size on disk (3292)

--- todo-13-export-report stderr tail ---
responseMode: 'json' drops mid-call notifications. subscriptions/listen streams are always served over SSE regardless; other notifications emitted before a result are dropped.
Port 53919 in use, trying next...
Port 53919 in use - entering proxy mode (forwarding to localhost:53919)
robloxstudio-mcp v3.1.4 running on stdio
MCP server active in proxy mode - forwarding requests to primary
Waiting for Studio plugin to connect...
Closed managed Studio instance instance:v2a-x7f

========== SUMMARY ==========
  ❌ FAIL  todo-2026-09-15/13-export-report.mjs

0/1 passed.
##### EXIT=1 2026-09-15T11:19:51+03:00
```

## Fix

- `studio-plugin/src/modules/handlers/SerializationHandlers.ts`: the exportRbxm result adds `bytes` (`buffer.len`), `instanceCount` (Σ GetDescendants + 1 per root), `rootClass`/`rootName` (first root), `rootClasses`/`rootNames`; the importRbxm result adds `instanceCount`, `rootNames`, `rootClasses`. Existing `bytes_written`, `instance_count`, `instance_names`, `instance_paths` are unchanged.
- `packages/core/src/tools/index.ts` (exportRbxm): the plugin fields are passed through to the JSON result; `bytes` is the length written to disk.
- The `export_rbxm` schema description is NOT changed: the inspector catalog budget in `mcp-runtime.test.ts` is 20,000 characters and the current size is 19,986 — even a 15-character addition turns it red (tried: 20,001). The result fields are self-explanatory.
- Note: when two nested roots are passed in one call (Folder + Folder.P1), `instanceCount` counts P1 twice (7) while `bytes` stays 3292 (SerializeInstancesAsync de-duplicates). The count follows the root list, not the file contents.

## After the fix (same command, 2026-09-15 13:52)

- export: `bytes: 3292` = size on disk, `instanceCount: 6`, `rootClass: "Folder"`, `rootName: "__RSMCP_ExportReport"`; 2 roots: `rootClasses: ["Folder","Part"]`, `rootNames: ["__RSMCP_ExportReport","P1"]`.
- import (into ReplicatedStorage): `instanceCount: 6`, `rootNames: ["__RSMCP_ExportReport"]`, `rootClasses: ["Folder"]`; `execute_luau` count 6.

```
##### GREEN 13-export-report 2026-09-15T13:52+03:00
Test process using port 62339 (automatically assigned)
Full integration suite using port 62339 (from ROBLOX_STUDIO_PORT)
Installing worktree plugin C:\Users\<user>\Desktop\mcp\wt-a\studio-plugin\MCPPlugin.rbxmx
Installed MCPPlugin.rbxmx to C:\Users\<user>\AppData\Local\Temp\robloxstudio-mcp-workers\run-all-IpqLXI\RsmcpIsolatedPlugins\MCPPlugin.rbxmx
Launched managed Studio instance instance:v2u-a30

=== field #13/#14 export_rbxm and import_rbxm size/count reports ===
  ✓ managed instance id is set
[2026-09-15T10:52:12.918Z] setup: {"returnValue":"6","message":"Code executed successfully","success":true,"output":[]}
  ✓ tree has 6 instances including the root
[2026-09-15T10:52:12.952Z] export_rbxm: {"bytes_written":3292,"instance_count":1,"output_path":"C:\\Users\\<user>\\AppData\\Local\\Temp\\rsmcp-field13-cvj5PO\\tree.rbxm","bytes":3292,"instanceCount":6,"rootClass":"Folder","rootName":"__RSMCP_ExportReport","rootClasses":["Folder"],"rootNames":["__RSMCP_ExportReport"]}
  ✓ bytes (3292) equals the file size on disk (3292)
  ✓ instanceCount is 6 (root + descendants)
  ✓ rootClass is Folder
  ✓ rootName is __RSMCP_ExportReport
  ✓ existing bytes_written/instance_count fields are unchanged
[2026-09-15T10:52:12.984Z] export_rbxm(2 roots): {"bytes_written":3292,"instance_count":2,"output_path":"C:\\Users\\<user>\\AppData\\Local\\Temp\\rsmcp-field13-cvj5PO\\multi.rbxm","bytes":3292,"instanceCount":7,"rootClass":"Folder","rootName":"__RSMCP_ExportReport","rootClasses":["Folder","Part"],"rootNames":["__RSMCP_ExportReport","P1"]}
  ✓ two roots: instanceCount counts every root subtree
  ✓ rootClasses lists every root class in order
  ✓ rootNames lists every root name in order
[2026-09-15T10:52:13.001Z] import_rbxm: {"instance_paths":["game.ReplicatedStorage.__RSMCP_ExportReport"],"rootClasses":["Folder"],"source":"C:\\Users\\<user>\\AppData\\Local\\Temp\\rsmcp-field13-cvj5PO\\tree.rbxm","instance_count":1,"rootNames":["__RSMCP_ExportReport"],"parent_path":"game.ReplicatedStorage","instanceCount":6,"instance_names":["__RSMCP_ExportReport"]}
  ✓ import instanceCount is 6
  ✓ import rootNames lists the Folder
  ✓ import rootClasses lists Folder
  ✓ existing import fields are unchanged
  ✓ imported tree has the reported instance count in the DataModel

✅ field #13/#14 export_rbxm and import_rbxm size/count reports PASSED
Closed managed Studio instance instance:v2u-a30

========== SUMMARY ==========
  ✅ PASS  field-2026-09-15/13-export-report.mjs

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
