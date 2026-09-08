#!/usr/bin/env node
// Opt-in live diagnostic: intentionally consumes real Studio HTTP budget.
// No parallel mutations, synthetic delays, transport mocks, or large scene required.
import assert from 'node:assert/strict';
import { BASE_PORT, McpClient, runTest } from './lib/mcp-client.mjs';

await runTest('live HTTP budget mutation reproduction', async ({ track }) => {
  const client = track(new McpClient('http-budget', { startupTimeoutMs: 20000 }));
  await client.start();
  await client.initialize();
  const instance_id = process.env.MCP_INSTANCE_ID;
  assert.ok(instance_id);
  const size = Number(process.env.RSMCP_CHUNK_BYTES ?? 3000);
  const tool = process.env.RSMCP_MUTATION_TOOL ?? 'execute_luau';
  const pressure = process.env.RSMCP_HTTP_PRESSURE !== '0';
  const root = '__RSMCP_HttpBudget';
  const execute = code => client.callTool('execute_luau', { instance_id, target: 'edit', code });
  const text = 'x'.repeat(size);
  try {
    await execute(`local old=workspace:FindFirstChild('${root}') if old then old:Destroy() end local f=Instance.new('StringValue',workspace) f.Name='${root}' return true`);
    if (pressure) await execute(`task.spawn(function()
local h=game:GetService('HttpService')
for i=1,2000 do
local ok,err=pcall(function() h:GetAsync('http://localhost:${BASE_PORT}/health',true) end)
if not ok then warn('[quota-probe] '..tostring(err)) break end
end
end) return true`);
    for (let index = 0; index < 2200; index++) {
      const expected = `${index}:${text}`;
      const args = tool === 'set_properties'
        ? { instance_id, instancePath: `game.Workspace.${root}`, properties: { Value: expected } }
        : { instance_id, target: 'edit', code: `workspace.${root}.Value='${expected}' return true` };
      const started = performance.now();
      try {
        await client.callTool(tool, args, Number(process.env.RSMCP_RPC_TIMEOUT_MS ?? 30000));
      } catch (error) {
        const elapsedMs = Math.round(performance.now() - started);
        const connected = await client.callTool('get_connected_instances', {});
        const readStarted = performance.now();
        const readback = await execute(`return workspace.${root}.Value == '${expected}'`);
        console.log(JSON.stringify({ tool, size, pressure, index, argumentBytes: Buffer.byteLength(JSON.stringify(args)), elapsedMs, error: error.message, connected, written: String(readback.returnValue) === 'true', readbackMs: Math.round(performance.now() - readStarted), timestamp: new Date().toISOString() }));
        throw error;
      }
      const elapsedMs = Math.round(performance.now() - started);
      if (index % 100 === 0 || elapsedMs > 500) console.log(JSON.stringify({ index, elapsedMs, size, tool, pressure }));
    }
  } finally {
    await execute(`local f=workspace:FindFirstChild('${root}') if f then f:Destroy() end return true`).catch(() => {});
  }
});
