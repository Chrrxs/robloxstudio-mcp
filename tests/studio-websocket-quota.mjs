#!/usr/bin/env node
// Opt-in transport experiment, not a production adapter. Real Studio clocks and
// network deadlines are intentional: fake timers cannot drive the engine quota.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { BASE_PORT, McpClient, runTest } from './lib/mcp-client.mjs';

await runTest('WebSocket responses survive Studio HTTP quota exhaustion', async ({ track }) => {
  const client = track(new McpClient('websocket-quota', { startupTimeoutMs: 20000 }));
  await client.start();
  await client.initialize();
  const instance_id = process.env.MCP_INSTANCE_ID;
  assert.ok(instance_id);
  const root = '__RSMCP_WebSocketQuota';
  const token = randomUUID();
  const connected = Promise.withResolvers();
  const pending = new Map();
  let socket;
  let nextId = 1;
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0, path: `/${token}`, maxPayload: 2 * 1024 * 1024 });
  server.on('connection', ws => {
    if (socket) { ws.close(); return; }
    socket = ws;
    ws.on('message', bytes => {
      try {
        const message = JSON.parse(bytes.toString());
        const entry = pending.get(message.id);
        if (!entry) return;
        if (message.ok) entry.resolve(message.data);
        else entry.reject(new Error(String(message.error)));
      } catch (error) {
        for (const entry of pending.values()) entry.reject(error);
      }
    });
    ws.on('close', () => {
      for (const entry of pending.values()) entry.reject(new Error('WebSocket closed'));
    });
    connected.resolve();
  });
  async function rpc(action, data = {}, timeoutMs = 5000) {
    const id = nextId++;
    const entry = Promise.withResolvers();
    pending.set(id, entry);
    const signal = AbortSignal.timeout(timeoutMs);
    const abort = () => entry.reject(new Error(`WebSocket ${action} deadline ${timeoutMs}ms`));
    signal.addEventListener('abort', abort, { once: true });
    try {
      socket.send(JSON.stringify({ id, action, ...data }));
      return await entry.promise;
    } finally {
      signal.removeEventListener('abort', abort);
      pending.delete(id);
    }
  }
  try {
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const bootstrap = await client.callTool('execute_luau', {
      instance_id, target: 'edit', code: `
local h=game:GetService('HttpService')
local old=workspace:FindFirstChild('${root}') if old then old:Destroy() end
local f=Instance.new('StringValue',workspace) f.Name='${root}'
local stream=h:CreateWebStreamClient(Enum.WebStreamClientType.WebSocket, {Url='ws://localhost:${address.port}/${token}'})
stream.MessageReceived:Connect(function(raw)
  local request=h:JSONDecode(raw)
  local ok,data=pcall(function()
    if request.action=='quota' then
      for i=1,2100 do
        local success,result=pcall(function() return h:GetAsync('http://localhost:${BASE_PORT}/health',true) end)
        if not success then return {attempt=i, httpError=tostring(result)} end
      end
      return {httpError='quota not exhausted'}
    elseif request.action=='http' then
      local success,result=pcall(function() return h:GetAsync('http://localhost:${BASE_PORT}/health',true) end)
      return {httpOk=success, httpError=success and '' or tostring(result)}
    elseif request.action=='write' then
      f.Value=request.value
      f:SetAttribute('MutationCount', (f:GetAttribute('MutationCount') or 0)+1)
      return {bytes=#f.Value, mutationCount=f:GetAttribute('MutationCount')}
    elseif request.action=='read' then
      return {value=f.Value, mutationCount=f:GetAttribute('MutationCount')}
    elseif request.action=='cleanup' then
      f:Destroy() return true
    else error('Unknown action') end
  end)
  stream:Send(h:JSONEncode({id=request.id,ok=ok,data=ok and data or nil,error=not ok and tostring(data) or nil}))
end)
stream.Closed:Connect(function() if f.Parent then f:Destroy() end end)
return true`,
    });
    assert.equal(bootstrap.success, true);
    // Bootstrap completion is not proof of WebSocket readiness.
    const connectionSignal = AbortSignal.timeout(15000);
    const connectionAbort = () => connected.reject(new Error('Studio WebSocket did not connect'));
    connectionSignal.addEventListener('abort', connectionAbort, { once: true });
    try { await connected.promise; } finally { connectionSignal.removeEventListener('abort', connectionAbort); }

    const baseline = await rpc('write', { value: 'baseline' });
    assert.equal(baseline.mutationCount, 1);
    const saturationStarted = performance.now();
    const saturation = await rpc('quota', {}, 90000);
    assert.match(saturation.httpError, /Number of requests exceeded limit/);
    console.log(JSON.stringify({ phase: 'quota-exhausted', ...saturation, elapsedMs: Math.round(performance.now() - saturationStarted) }));

    let mutations = 1;
    const records = [];
    for (const bytes of [1, 3000, 10000, 128000]) {
      for (let round = 0; round < 10; round++) {
        const before = await rpc('http');
        assert.equal(before.httpOk, false, 'HTTP must still be rejected before the WebSocket mutation');
        assert.match(before.httpError, /Number of requests exceeded limit/);
        const value = String.fromCharCode(65 + round).repeat(bytes);
        const started = performance.now();
        const result = await rpc('write', { value });
        const elapsedMs = Math.round(performance.now() - started);
        assert.equal(result.bytes, bytes);
        assert.equal(result.mutationCount, ++mutations);
        const readback = await rpc('read');
        assert.equal(readback.value, value);
        assert.equal(readback.mutationCount, mutations);
        const after = await rpc('http');
        assert.equal(after.httpOk, false, 'HTTP must still be rejected after the WebSocket readback');
        assert.match(after.httpError, /Number of requests exceeded limit/);
        records.push({ bytes, elapsedMs });
      }
    }
    console.log(JSON.stringify({ phase: 'verified', mutations: records.length, readbacks: records.length, httpRejections: records.length * 2, maxMutationMs: Math.max(...records.map(row => row.elapsedMs)), sizes: [...new Set(records.map(row => row.bytes))] }));
    await rpc('cleanup');
  } finally {
    socket?.terminate();
    const closed = once(server, 'close');
    server.close();
    await closed;
  }
});
