#!/usr/bin/env node
// Uses the production MCP -> bridge -> Studio transport, not the WebSocket proof
// of concept. HTTP pressure is real and independent of serialized mutations.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { BASE_PORT, McpClient, runTest } from './lib/mcp-client.mjs';

await runTest('production Studio transport survives HTTP quota exhaustion', async ({ track }) => {
  const client = track(new McpClient('production-websocket', { startupTimeoutMs: 20000 }));
  await client.start();
  await client.initialize();
  const instance_id = process.env.MCP_INSTANCE_ID;
  assert.ok(instance_id);
  const root = '__RSMCP_ProductionWebSocket';
  const execute = code => client.callTool('execute_luau', { instance_id, target: 'edit', code });
  let maxMutationMs = 0;
  let expectedMutations = 0;
  const prefix = randomUUID();
  const payload = 'x'.repeat(3000);
  try {
    await execute(`local old=workspace:FindFirstChild('${root}') if old then old:Destroy() end local f=Instance.new('StringValue',workspace) f.Name='${root}' f:SetAttribute('Mutations',0) return true`);
    await execute(`task.spawn(function()
local h=game:GetService('HttpService')
local f=workspace.${root}
for i=1,2100 do
  local ok,err=pcall(function() h:GetAsync('http://localhost:${BASE_PORT}/health',true) end)
  if not ok then f:SetAttribute('QuotaError',tostring(err)) f:SetAttribute('HttpAttempts',i) break end
end
end) return true`);
    for (let index = 0; index < 2200; index++) {
      const operation_id = index === 0 ? `${'界'.repeat(100)}${prefix.slice(0, 8)}` : `${prefix}:${index}`;
      const isLuau = index % 2 === 0;
      const name = isLuau ? 'execute_luau' : 'set_properties';
      const args = isLuau
        ? { instance_id, operation_id, target: 'edit', code: `local f=workspace.${root} f:SetAttribute('Mutations',f:GetAttribute('Mutations')+1) return true` }
        : { instance_id, operation_id, instancePath: `game.Workspace.${root}`, properties: { Value: `${index}:${payload}` } };
      const started = performance.now();
      const result = await client.callTool(name, args);
      const elapsedMs = Math.round(performance.now() - started);
      maxMutationMs = Math.max(maxMutationMs, elapsedMs);
      assert.ok(elapsedMs < 5000, `mutation ${index} stalled ${elapsedMs}ms`);
      assert.notEqual(result.success, false);
      assert.ok(!result.summary?.failed);
      if (isLuau) expectedMutations++;
      if (index % 100 === 0) {
        const status = await client.callTool('get_request_status', { request_id: operation_id });
        assert.equal(status.outcome, 'success');
        assert.equal(status.requestId, operation_id);
        const replay = await client.callTool(name, args);
        assert.deepEqual(replay, result, 'same operation ID replays result without re-executing');
        console.log(JSON.stringify({ index, elapsedMs, recovered: true }));
      }
    }
    const verification = await execute(`local f=workspace.${root} return f:GetAttribute('Mutations')==${expectedMutations} and f.Value=='2199:${payload}' and string.find(f:GetAttribute('QuotaError') or '', 'Number of requests exceeded limit',1,true)~=nil`);
    assert.equal(String(verification.returnValue), 'true', 'quota was exhausted, exact writes persisted and duplicate operation IDs did not repeat mutations');
    const health = await fetch(`http://127.0.0.1:${BASE_PORT}/health`).then(response => response.json());
    assert.ok(health.activeWebSockets > 0);
    assert.equal(health.pendingRequests, 0);
    console.log(JSON.stringify({ mutations: 2200, sideEffects: expectedMutations, maxMutationMs, activeWebSockets: health.activeWebSockets, quotaVerified: true }));
  } finally {
    await execute(`local f=workspace:FindFirstChild('${root}') if f then f:Destroy() end return true`).catch(() => {});
  }
});
