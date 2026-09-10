#!/usr/bin/env node
// execute_luau target=server must surface the user's actual error, not the
// plugin-internal handler path + the generic "Requested module experienced
// an error" wrapper. The ModuleScript-fallback path in
// MetadataHandlers.executeLuau wraps user code in xpcall inside the IIFE
// so the real message and traceback survive the require() boundary.
//
// Regression test for the execute_luau target=server error-leak bug fixed
// in v2.11.3.

import { McpClient, runTest, assert, assertContains, assertNotContains, startPlaytestAndWait, safeStopPlaytest } from './lib/mcp-client.mjs';

const MARKER = 'EXEC_ERR_MARKER_8b1d2e';
const PREEXISTING_MARKER = 'EXEC_PREEXISTING_REQUIRE_MARKER_1b9e7d';
const GENERIC = 'Requested module experienced an error while loading';
const PLUGIN_PATH_LEAK = 'MCPPlugin.modules.handlers.MetadataHandlers';

await runTest('execute_luau target=server preserves user error', async ({ track }) => {
  const client = track(new McpClient('A'));
  await client.start();
  await client.initialize();

  await startPlaytestAndWait(client);

  try {
    // Case 1: explicit error() — works for target=edit, currently broken for target=server
    const r1 = await client.callToolError('execute_luau', {
      target: 'server',
      code: `error("${MARKER}-server-error")`,
    });
    assert(r1.success === false, 'execute_luau target=server reports failure');
    assertContains(JSON.stringify(r1), `${MARKER}-server-error`,
      'response.error carries the actual user error message');
    assertNotContains(JSON.stringify(r1), PLUGIN_PATH_LEAK,
      'response.error does NOT leak the plugin handler path');
    assertNotContains(JSON.stringify(r1), GENERIC,
      'response.error does NOT use the generic require wrapper');

    // Case 2: target=edit baseline — should already work, asserts the same
    // marker-preservation contract on the working path so we know our
    // assertions are sensible.
    const r2 = await client.callToolError('execute_luau', {
      target: 'edit',
      code: `error("${MARKER}-edit-error")`,
    });
    assert(r2.success === false, 'execute_luau target=edit reports failure');
    assertContains(JSON.stringify(r2), `${MARKER}-edit-error`,
      'edit baseline: error message preserved (sanity)');

    // Case 3: nested ModuleScript load failures also go through require().
    // Roblox collapses these to GENERIC at the require boundary; execute_luau
    // should recover the real module-load diagnostic from LogService.
    const r3 = await client.callToolError('execute_luau', {
      target: 'edit',
      code: `
local module = Instance.new("ModuleScript")
module.Name = "__MCPNestedRequireFailure"
module.Source = [[
local missing = script.Parent.EXEC_NESTED_REQUIRE_MARKER_missing
return missing
]]
module.Parent = workspace
task.defer(function()
  if module.Parent then module:Destroy() end
end)
require(module)
`,
    });
    assert(r3.success === false, 'execute_luau target=edit nested require reports failure');
    assertContains(r3.error || '', 'EXEC_NESTED_REQUIRE_MARKER_missing',
      'nested require response carries the actual module-load error');
    assertNotContains(r3.error || '', GENERIC,
      'nested require response does NOT use the generic require wrapper');

    // Case 4: pre-existing ModuleScript failures can be cached by Roblox.
    // The first require emits the real diagnostic; later requires can return
    // only GENERIC, so recovery must be able to associate the module with its
    // earlier LogService stack block.
    const setupPreexisting = await client.callTool('execute_luau', {
      target: 'edit',
      code: `
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local old = ReplicatedStorage:FindFirstChild("__MCPPreexistingRequireFailure")
if old then old:Destroy() end
local module = Instance.new("ModuleScript")
module.Name = "__MCPPreexistingRequireFailure"
module.Source = [[error("${PREEXISTING_MARKER}")]]
module.Parent = ReplicatedStorage
return module:GetFullName()
`,
    });
    assert(setupPreexisting.success === true, 'pre-existing failing module setup succeeds');

    const r4 = await client.callToolError('execute_luau', {
      target: 'edit',
      code: `
local ReplicatedStorage = game:GetService("ReplicatedStorage")
require(ReplicatedStorage:WaitForChild("__MCPPreexistingRequireFailure"))
`,
    });
    assert(r4.success === false, 'execute_luau pre-existing require reports failure');
    assertContains(r4.error || '', PREEXISTING_MARKER,
      'pre-existing require response carries the actual module-load error');
    assertNotContains(r4.error || '', GENERIC,
      'pre-existing require response does NOT use the generic require wrapper');

    const r5 = await client.callToolError('execute_luau', {
      target: 'edit',
      code: `
local ReplicatedStorage = game:GetService("ReplicatedStorage")
require(ReplicatedStorage:WaitForChild("__MCPPreexistingRequireFailure"))
`,
    });
    assert(r5.success === false, 'execute_luau cached pre-existing require reports failure');
    assertContains(r5.error || '', PREEXISTING_MARKER,
      'cached pre-existing require response carries the earlier module-load error');
    assertNotContains(r5.error || '', GENERIC,
      'cached pre-existing require response does NOT use the generic require wrapper');

    // Case 5: success path still works on server target
    const r6 = await client.callTool('execute_luau', {
      target: 'server',
      code: `return "${MARKER}-ok"`,
    });
    assert(r6.success === true, 'execute_luau target=server success works');
    assertContains(JSON.stringify(r6), `${MARKER}-ok`,
      'success returnValue preserved');

    // Case 6: parse/compile error on target=server (LoadStringEnabled=false
    // default forces the ModuleScript-fallback path, where require()
    // collapses parse errors into GENERIC). Handler must recover the real
    // parser diagnostic from LogService.
    const r7 = await client.callToolError('execute_luau', {
      target: 'server',
      code: `this is not valid luau syntax @#$`,
    });
    assert(r7.success === false, 'execute_luau target=server parse error reports failure');
    assertContains(r7.error || '', 'user_code:',
      'parse-error response carries the normalized user-code parser diagnostic');
    assertNotContains(r7.error || '', GENERIC,
      'parse-error response does NOT fall back to the generic require wrapper');
  } finally {
    try {
      await client.callTool('execute_luau', {
        target: 'edit',
        code: `
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local module = ReplicatedStorage:FindFirstChild("__MCPPreexistingRequireFailure")
if module then module:Destroy() end
return true
`,
      });
    } catch {
      // Best-effort cleanup; the playtest cleanup below is the important one.
    }
    await safeStopPlaytest(client);
  }
}).then((ok) => process.exit(ok ? 0 : 1));
