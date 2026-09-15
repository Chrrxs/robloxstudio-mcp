#!/usr/bin/env node
// Field report #4: set_properties on Workspace.StreamingMinRadius/StreamingTargetRadius (NotScriptable) must return an explanatory error (property name + "Properties panel" + Roblox's raw message) and get_instance_properties must list them under `inaccessible`.
// Run: node tests/run-with-test-port.mjs tests/run-all.mjs --managed --test field-2026-09-15/04-streaming-props.mjs
import { McpClient, runTest, assert, assertContains } from '../lib/mcp-client.mjs';

const PROPS = ['StreamingMinRadius', 'StreamingTargetRadius'];

function log(label, value) {
  console.log(`[${new Date().toISOString()}] ${label}: ${JSON.stringify(value)}`);
}

await runTest('field #4 NotScriptable Workspace streaming properties', async ({ track }) => {
  const client = track(new McpClient('field-04-streaming-props', { startupTimeoutMs: 20000 }));
  await client.start();
  await client.initialize();
  const instanceId = process.env.MCP_INSTANCE_ID;
  assert(typeof instanceId === 'string' && instanceId.length > 0, 'managed instance id is set');

  const probe = await client.callTool('execute_luau', {
    instance_id: instanceId, target: 'edit',
    code: `
local out = {}
for _, p in ipairs({"StreamingMinRadius", "StreamingTargetRadius"}) do
  local ok, err = pcall(function() return workspace[p] end)
  out[p .. "_read"] = ok and "readable" or tostring(err)
  local ok2, err2 = pcall(function() workspace[p] = 128 end)
  out[p .. "_write"] = ok2 and "writable" or tostring(err2)
end
return out`,
  });
  log('raw plugin pcall (execute_luau)', probe);
  const raw = JSON.parse(probe.returnValue);
  const pluginCanWrite = PROPS.some((p) => raw[`${p}_write`] === 'writable');
  if (pluginCanWrite) {
    throw new Error(`Studio allows the plugin to write these properties; field report #4 premise does not hold: ${JSON.stringify(raw)}`);
  }

  const set = (await client.callToolResult('set_properties', {
    instance_id: instanceId, instancePath: 'game.Workspace',
    properties: { StreamingMinRadius: 128, StreamingTargetRadius: 2048 },
  })).body;
  log('set_properties(Workspace streaming)', set);
  assert(set.success === false && set.summary?.failed === 2, 'set_properties reports both writes as failed');
  for (const prop of PROPS) {
    const entry = set.results.find((r) => r.property === prop);
    assert(entry && entry.success === false, `${prop}: result entry present and failed`);
    assertContains(entry.error, prop, `${prop}: error names the property`);
    assertContains(entry.error, 'Properties panel', `${prop}: error tells the caller to use the Properties panel`);
    assertContains(entry.error, 'plugin', `${prop}: error explains the plugin cannot access it`);
    assertContains(entry.error, raw[`${prop}_write`], `${prop}: error contains Roblox's raw pcall message`);
    assert(entry.reason === 'not_scriptable', `${prop}: reason is not_scriptable`);
  }

  const unknown = (await client.callToolResult('set_properties', {
    instance_id: instanceId, instancePath: 'game.Workspace',
    properties: { __RSMCP_NoSuchProperty: 1 },
  })).body;
  log('set_properties(unknown property)', unknown);
  const unknownEntry = unknown.results.find((r) => r.property === '__RSMCP_NoSuchProperty');
  assert(unknownEntry?.reason === 'not_a_member', 'property outside the table is classified from the pcall message (not_a_member)');
  assertContains(unknownEntry.error, 'is not a valid member', 'unknown property error keeps the raw Roblox message');

  const props = await client.callTool('get_instance_properties', {
    instance_id: instanceId, instancePath: 'game.Workspace',
  });
  log('get_instance_properties(Workspace)', { inaccessible: props.inaccessible, className: props.className });
  assert(Array.isArray(props.inaccessible), 'get_instance_properties returns inaccessible: [...]');
  for (const prop of PROPS) {
    assert(props.inaccessible.includes(prop), `inaccessible lists ${prop}`);
  }

  const partProps = await client.callTool('get_instance_properties', {
    instance_id: instanceId, instancePath: 'game.Workspace.Terrain',
  });
  assert(partProps.inaccessible === undefined, 'Terrain has no inaccessible list (table is class-scoped)');
});
