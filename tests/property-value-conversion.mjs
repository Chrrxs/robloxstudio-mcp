#!/usr/bin/env node
// Regression coverage for JSON object payloads that map to Roblox value types.
// The converter must honor the destination property type: {X,Y} is Vector2 for
// GuiObject.AnchorPoint, while {X,Y,Z} remains Vector3 for BasePart.Position.

import { McpClient, runTest, assert, selectEditInstance } from './lib/mcp-client.mjs';
import { setTimeout as delay } from 'node:timers/promises';

function findResult(response, property) {
  return Array.isArray(response.results)
    ? response.results.find((result) => result.property === property)
    : undefined;
}

async function cleanupProbes(client, instanceId) {
  try {
    await client.callTool('execute_luau', {
      target: 'edit',
      instance_id: instanceId,
      code: `
local gui = game:GetService("StarterGui"):FindFirstChild("__RSMCP_Vector2Conversion")
if gui then gui:Destroy() end
local part = workspace:FindFirstChild("__RSMCP_Vector3Conversion")
if part then
  local probe = part:FindFirstChild("SourceProbe") or part:FindFirstChild("RenamedSourceProbe")
  local document = probe and game:GetService("ScriptEditorService"):FindScriptDocument(probe)
  if document then
    local closed, closeError = document:CloseAsync()
    assert(closed, closeError)
  end
  part:Destroy()
end
return true
`,
    });
  } catch {
    // Best-effort cleanup; the test verdict should come from the assertion.
  }
}

async function waitForEditInstance(client, instanceId, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      const connected = await client.callTool('get_connected_instances', {});
      const edit = selectEditInstance(connected, instanceId);
      if (edit) return edit;
      last = connected;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    await delay(500);
  }
  throw new Error(`edit instance ${instanceId} did not remain connected. Last: ${JSON.stringify(last)}`);
}

async function assertOpenEditorSource(client, instanceId, expected, message, scriptName = 'SourceProbe') {
  const readback = await client.callTool('execute_luau', {
    target: 'edit',
    instance_id: instanceId,
    code: `
local service = game:GetService("ScriptEditorService")
local probe = workspace.__RSMCP_Vector3Conversion:FindFirstChild(${JSON.stringify(scriptName)})
assert(probe, "Missing source probe: " .. ${JSON.stringify(scriptName)})
local expected = ${JSON.stringify(expected)}
local deadline = os.clock() + 5
repeat
  local document = service:FindScriptDocument(probe)
  assert(document, "SourceProbe must remain open in the editor")
  local editorSource = service:GetEditorSource(probe)
  local documentText = document:GetText()
  if editorSource == expected and documentText == expected then
    return true
  end
  if os.clock() >= deadline then
    error("Editor source mismatch; editor=" .. editorSource .. "; document=" .. documentText)
  end
  task.wait()
until false
`,
  });
  assert(readback.success === true && String(readback.returnValue) === 'true', message);
}

async function checkOpenDocumentSourceWrite(client, instanceId, scriptPath) {
  const draft = '-- unsaved editor change before set_properties\nreturn 73';
  const replacement = '-- source written through set_properties\nreturn 99';
  const renamed = 'RenamedSourceProbe';
  const opened = await client.callTool('execute_luau', {
    target: 'edit',
    instance_id: instanceId,
    code: `
local service = game:GetService("ScriptEditorService")
local probe = workspace.__RSMCP_Vector3Conversion.SourceProbe
assert(probe.Archivable, "SourceProbe must participate in DataModel history")
local opened, openError = service:OpenScriptDocumentAsync(probe)
assert(opened, openError)
local document = service:FindScriptDocument(probe)
assert(document, "Opening SourceProbe must produce a ScriptDocument")
local lineCount = document:GetLineCount()
local lastLine = document:GetLine(lineCount)
local edited, editError = document:EditTextAsync(${JSON.stringify(draft)}, 1, 1, lineCount, #lastLine + 1)
assert(edited, editError)
-- Seal fixture preparation so undo cannot remove the probe or earlier test edits.
game:GetService("ChangeHistoryService"):SetWaypoint("RSMCP open Source fixture prepared")
return true
`,
  });
  assert(opened.success === true && String(opened.returnValue) === 'true', 'opens and modifies the SourceProbe editor document');
  await assertOpenEditorSource(client, instanceId, draft, 'open document contains the pre-write unsaved text');

  const written = await client.callTool('set_properties', {
    instancePath: scriptPath,
    properties: { Source: replacement, Name: renamed },
    instance_id: instanceId,
  });
  assert(written.summary?.failed === 0 && findResult(written, 'Source')?.success === true
    && findResult(written, 'Name')?.success === true,
    'set_properties writes Source and an ordinary property with an open modified document');
  await assertOpenEditorSource(client, instanceId, replacement, 'Source write updates both editor readback APIs', renamed);

  // Studio intentionally excludes Source from ChangeHistoryService. Script text
  // uses the editor's own history; only ordinary DataModel properties undo here.
  // https://devforum.roblox.com/t/4590702/4
  for (const [action, expectedName] of [['Undo', 'SourceProbe'], ['Redo', renamed]]) {
    const historyResult = await client.callTool('execute_luau', {
      target: 'edit',
      instance_id: instanceId,
      code: `
local history = game:GetService("ChangeHistoryService")
local probe = workspace.__RSMCP_Vector3Conversion:FindFirstChild(${JSON.stringify(action === 'Undo' ? renamed : 'SourceProbe')})
assert(probe, "Missing source probe before ${action}")
local available, waypoint = history:GetCan${action}()
assert(available, "${action} must be available after the Source write")
assert(type(waypoint) == "string" and string.find(waypoint, "Set multiple properties", 1, true),
  "Unexpected ${action.toLowerCase()} waypoint: " .. tostring(waypoint))
history:${action}()
assert(probe.Name == ${JSON.stringify(expectedName)},
  "${action} must restore the name from the mixed batch; got " .. probe.Name)
return true
`,
    });
    assert(historyResult.success === true && String(historyResult.returnValue) === 'true',
      `${action} restores the name from the set_properties recording`);
    await assertOpenEditorSource(client, instanceId, replacement,
      `${action} leaves Source in the separate editor history`, expectedName);
  }
  console.log('Open-document Source write and mixed-batch property undo/redo passed.');
}

await runTest('property value conversion honors destination property types', async ({ track }) => {
  const client = track(new McpClient('property-value-conversion', { startupTimeoutMs: 20000 }));
  await client.start();
  await client.initialize();

  let launchedInstanceId;
  let instanceId = process.env.MCP_INSTANCE_ID;
  if (!instanceId) {
    const launched = await client.callTool('manage_instance', {
      action: 'launch',
      source: 'baseplate',
      wait_for_connection: true,
      timeout_ms: 120000,
    });
    launchedInstanceId = launched.instance_id;
    instanceId = launchedInstanceId;
  }
  assert(typeof instanceId === 'string' && instanceId.length > 0, 'edit instance is available');
  await waitForEditInstance(client, instanceId);

  const screenGuiPath = 'game.StarterGui.__RSMCP_Vector2Conversion';
  const labelPath = `${screenGuiPath}.AnchorPointProbe`;
  const partPath = 'game.Workspace.__RSMCP_Vector3Conversion';

  try {
    const setup = await client.callTool('execute_luau', {
      target: 'edit',
      instance_id: instanceId,
      code: `
local starterGui = game:GetService("StarterGui")
local oldGui = starterGui:FindFirstChild("__RSMCP_Vector2Conversion")
if oldGui then oldGui:Destroy() end
local oldPart = workspace:FindFirstChild("__RSMCP_Vector3Conversion")
if oldPart then oldPart:Destroy() end

local screenGui = Instance.new("ScreenGui")
screenGui.Name = "__RSMCP_Vector2Conversion"
screenGui.Parent = starterGui
local label = Instance.new("TextLabel")
label.Name = "AnchorPointProbe"
label.Parent = screenGui
local part = Instance.new("Part")
part.Name = "__RSMCP_Vector3Conversion"
part.Parent = workspace
local value = Instance.new("StringValue")
value.Name = "StringProbe"
value.Parent = part
local scriptProbe = Instance.new("Script")
scriptProbe.Name = "SourceProbe"
scriptProbe.Disabled = true
scriptProbe.Parent = part
local model = Instance.new("Model")
model.Name = "ReferenceProbe"
model.Parent = part
local primary = Instance.new("Part")
primary.Name = "Primary"
primary.Parent = model
model.PrimaryPart = primary
return true
`,
    });
    assert(setup.success === true && String(setup.returnValue) === 'true', 'execute_luau creates conversion probes');

    const anchorSet = await client.callTool('set_properties', {
      instancePath: labelPath,
      properties: { AnchorPoint: { X: 0.5, Y: 0.5 } },
      instance_id: instanceId,
    });
    const anchorResult = findResult(anchorSet, 'AnchorPoint');
    assert(anchorSet.summary?.failed === 0 && anchorResult?.success === true,
      'set_properties accepts {X,Y} for Vector2 properties');

    const positionSet = await client.callTool('set_properties', {
      instancePath: partPath,
      properties: { Position: { X: 1, Y: 2, Z: 3 } },
      instance_id: instanceId,
    });
    const positionResult = findResult(positionSet, 'Position');
    assert(positionSet.summary?.failed === 0 && positionResult?.success === true,
      'set_properties preserves {X,Y,Z} for Vector3 properties');

    for (const text of ['true', 'false']) {
      for (const [instancePath, property] of [[labelPath, 'Text'], [`${partPath}.StringProbe`, 'Value'], [partPath, 'Anchored']]) {
        const result = await client.callTool('set_properties', {
          instancePath, properties: { [property]: text }, instance_id: instanceId,
        });
        assert(result.summary?.failed === 0, `${property} accepts ${text}`);
      }
      const result = await client.callTool('execute_luau', {
        target: 'edit', instance_id: instanceId,
        code: `return game.StarterGui.__RSMCP_Vector2Conversion.AnchorPointProbe.Text == "${text}" and workspace.__RSMCP_Vector3Conversion.StringProbe.Value == "${text}" and workspace.__RSMCP_Vector3Conversion.Anchored == ${text}`,
      });
      assert(String(result.returnValue) === 'true', 'boolean-looking text preserves the destination property type');
    }

    const cleared = await client.callTool('set_properties', {
      instancePath: `${partPath}.ReferenceProbe`, properties: { PrimaryPart: '' }, instance_id: instanceId,
    });
    assert(cleared.summary?.failed === 0, 'empty PrimaryPart path clears the reference');
    const nilReference = await client.callTool('execute_luau', {
      target: 'edit', instance_id: instanceId,
      code: 'return workspace.__RSMCP_Vector3Conversion.ReferenceProbe.PrimaryPart == nil',
    });
    assert(String(nilReference.returnValue) === 'true', 'cleared PrimaryPart reads back as nil');
    for (const property of ['Parent', 'PrimaryPart']) {
      const rejected = await client.callToolError('set_properties', {
        instancePath: `${partPath}.ReferenceProbe`, properties: { [property]: false }, instance_id: instanceId,
      });
      assert(rejected.summary?.failed === 1, `invalid ${property} value is reported as a failed write`);
    }

    const sourceWrite = await client.callTool('set_properties', {
      instancePath: `${partPath}.SourceProbe`, properties: { Source: 'return 42' }, instance_id: instanceId,
    });
    assert(sourceWrite.summary?.failed === 0, 'Source writes through set_properties succeed');
    const editorReadback = await client.callTool('execute_luau', {
      target: 'edit', instance_id: instanceId,
      code: 'return game:GetService("ScriptEditorService"):GetEditorSource(workspace.__RSMCP_Vector3Conversion.SourceProbe) == "return 42"',
    });
    assert(String(editorReadback.returnValue) === 'true', 'Source write is visible to ScriptEditorService');
    await checkOpenDocumentSourceWrite(client, instanceId, `${partPath}.SourceProbe`);

    const missing = await client.callToolError('set_properties', {
      instancePath: `${partPath}.Missing`,
      properties: { Anchored: true },
      instance_id: instanceId,
    });
    assert(missing.error?.includes('Instance not found'), 'missing instance is an MCP error with its handler diagnostic');

    const partial = await client.callToolError('set_properties', {
      instancePath: partPath,
      properties: { Anchored: true, __InvalidProperty: true },
      instance_id: instanceId,
    });
    assert(partial.success === false && partial.summary?.succeeded === 1 && partial.summary?.failed === 1,
      'partial property write is an MCP error with accurate counts');
    assert(findResult(partial, 'Anchored')?.success === true
      && typeof findResult(partial, '__InvalidProperty')?.error === 'string',
    'partial property write preserves successful results and failure details');
    const readback = await client.callTool('execute_luau', {
      target: 'edit',
      instance_id: instanceId,
      code: `return workspace.__RSMCP_Vector3Conversion.Anchored`,
    });
    assert(String(readback.returnValue) === 'true', 'a failed batch does not roll back successful property writes');
  } finally {
    await cleanupProbes(client, instanceId);
    if (launchedInstanceId) {
      await client.callTool('manage_instance', {
        action: 'close',
        instance_id: launchedInstanceId,
      }).catch(() => {});
    }
  }
});
