# Field report #4 — set_properties / get_instance_properties: Workspace.StreamingMinRadius, StreamingTargetRadius

Test: `tests/field-2026-09-15/04-streaming-props.mjs`
Command: `node tests/run-with-test-port.mjs tests/run-all.mjs --managed --test field-2026-09-15/04-streaming-props.mjs`

## Security-level check

- `https://create.roblox.com/docs/reference/engine/classes/Workspace.md` (the source behind `get_roblox_docs`; downloaded directly so the live MCP was not touched, 72,260 B): `StreamingMinRadius` and `StreamingTargetRadius` have `security.read = None`, `security.write = None` — so this is NOT a PluginSecurity/RobloxScriptSecurity issue.
- API dump (`MaximumADHD/Roblox-Client-Tracker` Full-API-Dump.json, 8,069,340 B): both properties carry `Tags: ["NotScriptable"]` (so do `StreamingIntegrityMode`, `ModelStreamingBehavior`, `PredictiveStreamingMode`, `MeshStreamingAndImprovedLods`, `StreamingPauseMode`; `StreamingEnabled` is write=PluginSecurity and writable from a plugin).
- Raw pcall in Studio (managed baseplate, plugin context, `execute_luau`): reading and writing raise the same error: `StreamingMinRadius is not a valid member of Workspace "Workspace"`. A plugin CANNOT write them — the report's premise holds (the test deliberately fails if Studio ever allows the write).

## Symptom / reproduction (before the fix, 2026-09-15 11:19)

`set_properties instancePath="game.Workspace" properties={StreamingMinRadius:128, StreamingTargetRadius:2048}` → only the raw text, no explanation and no reason; `get_instance_properties` never mentions these properties.

Output of the test before the fix (the test was then named `TODO#4`; the run lived in worktree `wt/C`):

```
##### RED 04-streaming-props 2026-09-15T11:19:13+03:00
Test process using port 54668 (automatically assigned)
Full integration suite using port 54668 (from ROBLOX_STUDIO_PORT)
Installing worktree plugin C:\Users\<user>\Desktop\mcp\wt\C\studio-plugin\MCPPlugin.rbxmx
Installed MCPPlugin.rbxmx to C:\Users\<user>\AppData\Local\Temp\robloxstudio-mcp-workers\run-all-81fmco\RsmcpIsolatedPlugins\MCPPlugin.rbxmx
Launched managed Studio instance instance:s0n-hk5

=== TODO#4 NotScriptable Workspace streaming properties ===
  ✓ managed instance id is set
[2026-09-15T08:19:28.625Z] raw plugin pcall (execute_luau): {"returnValue":"{\"StreamingTargetRadius_read\":\"StreamingTargetRadius is not a valid member of Workspace \\\"Workspace\\\"\",\"StreamingMinRadius_write\":\"StreamingMinRadius is not a valid member of Workspace \\\"Workspace\\\"\",\"StreamingTargetRadius_write\":\"StreamingTargetRadius is not a valid member of Workspace \\\"Workspace\\\"\",\"StreamingMinRadius_read\":\"StreamingMinRadius is not a valid member of Workspace \\\"Workspace\\\"\"}","message":"Code executed successfully","success":true,"output":[]}

❌ TODO#4 NotScriptable Workspace streaming properties FAILED: Tool set_properties returned isError: {"instancePath":"game.Workspace","summary":{"total":2,"failed":2,"succeeded":0},"success":false,"results":[{"property":"StreamingTargetRadius","success":false,"error":"StreamingTargetRadius is not a valid member of Workspace \"Workspace\""},{"property":"StreamingMinRadius","success":false,"error":"StreamingMinRadius is not a valid member of Workspace \"Workspace\""}]}

--- todo-04-streaming-props stderr tail ---
responseMode: 'json' drops mid-call notifications. subscriptions/listen streams are always served over SSE regardless; other notifications emitted before a result are dropped.
Port 54668 in use, trying next...
Port 54668 in use - entering proxy mode (forwarding to localhost:54668)
robloxstudio-mcp v3.1.4 running on stdio
MCP server active in proxy mode - forwarding requests to primary
Waiting for Studio plugin to connect...
Closed managed Studio instance instance:s0n-hk5

========== SUMMARY ==========
  ❌ FAIL  todo-2026-09-15/04-streaming-props.mjs

0/1 passed.
##### EXIT=1 2026-09-15T11:19:32+03:00
```

## Fix

- `studio-plugin/src/modules/PropertyAccess.ts` (new, dependency-free): `NOT_SCRIPTABLE_PROPERTIES` table (Workspace: 7 properties from the API dump) + `listInaccessibleProperties(instance)` (class-scoped through `IsA`) + `classifyPropertyFailure(instance, prop, rawMessage)`: in the table ⇒ `not_scriptable`; message contains "lacking capability"/"cannot access"/"current identity" ⇒ `security`; "is not a valid member" ⇒ `not_a_member` ("inaccessible or does not exist"); anything else keeps the raw message.
- `studio-plugin/src/modules/handlers/PropertyHandlers.ts`: failed writes get an explanatory `error` (property name + "cannot be … from a plugin (plugin security); set it from Studio's Properties panel. Roblox: <raw message>") and a `reason` field.
- `studio-plugin/src/modules/handlers/QueryHandlers.ts` (getInstanceProperties return): `inaccessible: [...]` (field omitted when empty).
- `packages/core/src/__tests__/studio-handler-failures.test.ts`: the existing harness that runs PropertyHandlers in a Node VM now loads the new `../PropertyAccess` dependency and a Luau `string.lower/find` shim (it failed with "Unexpected dependency" otherwise).
- `packages/core/src/tools/definitions.ts`: `set_properties` description.

## After the fix (same command, 2026-09-15 13:47)

- `set_properties`: 2/2 failed, each with `reason: "not_scriptable"`, error = `Workspace.StreamingMinRadius is tagged NotScriptable: it cannot be read or written from a plugin (plugin security); set it from Studio's Properties panel. Roblox: StreamingMinRadius is not a valid member of Workspace "Workspace"`.
- `__RSMCP_NoSuchProperty` (not in the table) ⇒ `reason: "not_a_member"`, raw message kept.
- `get_instance_properties game.Workspace` ⇒ `inaccessible: ["StreamingMinRadius","StreamingTargetRadius","StreamingIntegrityMode","ModelStreamingBehavior","PredictiveStreamingMode","MeshStreamingAndImprovedLods","StreamingPauseMode"]`; `game.Workspace.Terrain` ⇒ no field.

```
##### GREEN 04-streaming-props 2026-09-15T13:47+03:00
Test process using port 64220 (automatically assigned)
Full integration suite using port 64220 (from ROBLOX_STUDIO_PORT)
Installing worktree plugin C:\Users\<user>\Desktop\mcp\wt-a\studio-plugin\MCPPlugin.rbxmx
Installed MCPPlugin.rbxmx to C:\Users\<user>\AppData\Local\Temp\robloxstudio-mcp-workers\run-all-MZRWiA\RsmcpIsolatedPlugins\MCPPlugin.rbxmx
Launched managed Studio instance instance:arc-j1o

=== field #4 NotScriptable Workspace streaming properties ===
  ✓ managed instance id is set
[2026-09-15T10:47:34.059Z] raw plugin pcall (execute_luau): {"returnValue":"{\"StreamingTargetRadius_read\":\"StreamingTargetRadius is not a valid member of Workspace \\\"Workspace\\\"\",\"StreamingMinRadius_write\":\"StreamingMinRadius is not a valid member of Workspace \\\"Workspace\\\"\",\"StreamingTargetRadius_write\":\"StreamingTargetRadius is not a valid member of Workspace \\\"Workspace\\\"\",\"StreamingMinRadius_read\":\"StreamingMinRadius is not a valid member of Workspace \\\"Workspace\\\"\"}","message":"Code executed successfully","success":true,"output":[]}
[2026-09-15T10:47:34.071Z] set_properties(Workspace streaming): {"instancePath":"game.Workspace","summary":{"total":2,"failed":2,"succeeded":0},"success":false,"results":[{"error":"Workspace.StreamingTargetRadius is tagged NotScriptable: it cannot be read or written from a plugin (plugin security); set it from Studio's Properties panel. Roblox: StreamingTargetRadius is not a valid member of Workspace \"Workspace\"","property":"StreamingTargetRadius","success":false,"reason":"not_scriptable"},{"error":"Workspace.StreamingMinRadius is tagged NotScriptable: it cannot be read or written from a plugin (plugin security); set it from Studio's Properties panel. Roblox: StreamingMinRadius is not a valid member of Workspace \"Workspace\"","property":"StreamingMinRadius","success":false,"reason":"not_scriptable"}]}
  ✓ set_properties reports both writes as failed
  ✓ StreamingMinRadius: result entry present and failed
  ✓ StreamingMinRadius: error names the property
  ✓ StreamingMinRadius: error tells the caller to use the Properties panel
  ✓ StreamingMinRadius: error explains the plugin cannot access it
  ✓ StreamingMinRadius: error contains Roblox's raw pcall message
  ✓ StreamingMinRadius: reason is not_scriptable
  ✓ StreamingTargetRadius: result entry present and failed
  ✓ StreamingTargetRadius: error names the property
  ✓ StreamingTargetRadius: error tells the caller to use the Properties panel
  ✓ StreamingTargetRadius: error explains the plugin cannot access it
  ✓ StreamingTargetRadius: error contains Roblox's raw pcall message
  ✓ StreamingTargetRadius: reason is not_scriptable
[2026-09-15T10:47:34.088Z] set_properties(unknown property): {"instancePath":"game.Workspace","summary":{"total":1,"failed":1,"succeeded":0},"success":false,"results":[{"error":"Workspace.__RSMCP_NoSuchProperty is inaccessible from a plugin or does not exist (NotScriptable properties and unknown names raise the same error; if it shows in the Properties panel, set it there). Roblox: __RSMCP_NoSuchProperty is not a valid member of Workspace \"Workspace\"","property":"__RSMCP_NoSuchProperty","success":false,"reason":"not_a_member"}]}
  ✓ property outside the table is classified from the pcall message (not_a_member)
  ✓ unknown property error keeps the raw Roblox message
[2026-09-15T10:47:34.105Z] get_instance_properties(Workspace): {"inaccessible":["StreamingMinRadius","StreamingTargetRadius","StreamingIntegrityMode","ModelStreamingBehavior","PredictiveStreamingMode","MeshStreamingAndImprovedLods","StreamingPauseMode"],"className":"Workspace"}
  ✓ get_instance_properties returns inaccessible: [...]
  ✓ inaccessible lists StreamingMinRadius
  ✓ inaccessible lists StreamingTargetRadius
  ✓ Terrain has no inaccessible list (table is class-scoped)

✅ field #4 NotScriptable Workspace streaming properties PASSED
Closed managed Studio instance instance:arc-j1o

========== SUMMARY ==========
  ✅ PASS  field-2026-09-15/04-streaming-props.mjs

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
