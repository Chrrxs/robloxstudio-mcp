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
if part then part:Destroy() end
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
