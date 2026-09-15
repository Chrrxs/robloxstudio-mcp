#!/usr/bin/env node
// Field report #7: identical code without operation_id is deduplicated only while the previous
// request is pending or its result was never delivered (waiter timeout, waiterEndedAt set); a
// delivered result never blocks a rerun. execute_luau/export_rbxm results carry queued_ahead +
// waitedMs; the timeout error text names get_request_status and says "do not resend".
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { resolveAuthToken } from '../../packages/core/dist/auth.js';
import { BASE_PORT, McpClient, runTest } from '../lib/mcp-client.mjs';

const ROOT = '__RSMCP_Field07';

function log(label, extra) {
  console.log(JSON.stringify({ label, timestamp: new Date().toISOString(), ...extra }));
}

function authHeaders(extra) {
  const { token } = resolveAuthToken();
  return { ...(token ? { 'X-MCP-Auth': token } : {}), ...extra };
}

async function editPeerId(instanceId) {
  const response = await fetch(`http://127.0.0.1:${BASE_PORT}/topology`, { headers: authHeaders() });
  assert.equal(response.ok, true, `/topology HTTP ${response.status}`);
  const body = await response.json();
  const peer = (body.peers ?? []).find((candidate) => candidate.instanceId === instanceId && candidate.role === 'edit');
  assert.ok(peer, `edit peer for ${instanceId} not in topology`);
  return peer.peerId;
}

function autoOperationId(targetPeerId, code) {
  return `auto-${createHash('sha256').update(JSON.stringify({ targetPeerId, endpoint: '/api/execute-luau', data: { code } })).digest('hex')}`;
}

async function proxyExecute(targetPeerId, code, operationId, timeoutMs) {
  const response = await fetch(`http://127.0.0.1:${BASE_PORT}/proxy`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ endpoint: '/api/execute-luau', data: { code }, targetPeerId, timeoutMs, operationId }),
  });
  return { status: response.status, body: await response.json() };
}

await runTest('field #7 queue metrics, automatic dedupe, timeout guidance', async ({ track }) => {
  const client = track(new McpClient('field-07', { startupTimeoutMs: 20000 }));
  await client.start();
  await client.initialize();
  const instanceId = process.env.MCP_INSTANCE_ID;
  assert.ok(instanceId, 'Run through run-all.mjs --managed');

  const call = (args, timeoutMs = 60_000) => client.callToolResult('execute_luau', { instance_id: instanceId, target: 'edit', ...args }, timeoutMs);
  const countNamed = async (name) => {
    const res = await call({ code: `local r = workspace:FindFirstChild("${ROOT}") if not r then return "0" end local n = 0 for _, c in ipairs(r:GetChildren()) do if c.Name == "${name}" then n += 1 end end return tostring(n)`, dedupe: false });
    return Number(res.body.returnValue);
  };
  const count = () => countNamed('Dedupe');

  try {
    const setup = await call({ code: `local old = workspace:FindFirstChild("${ROOT}") if old then old:Destroy() end local f = Instance.new("Folder") f.Name = "${ROOT}" f.Parent = workspace return "ok"`, dedupe: false });
    assert.equal(setup.body.returnValue, 'ok');

    console.log('--- (b) delivered result: same code, no operation_id → deliberate rerun (2 dispatches) ---');
    const mutation = `local f = Instance.new("Folder") f.Name = "Dedupe" f.Parent = workspace["${ROOT}"] return f.Name`;
    const first = await call({ code: mutation });
    const second = await call({ code: mutation });
    log('first', { body: first.body });
    log('second', { body: second.body });
    assert.equal(first.body.success, true);
    assert.equal(typeof first.body.operationId, 'string', 'result carries operationId');
    assert.equal(first.body.dedupe, 'auto', 'dedupe:"auto" marker when operation_id is omitted');
    assert.equal(first.body.deduplicatedFrom, undefined, 'the first run is not deduplicated');
    assert.equal(second.body.deduplicatedFrom, undefined, 'a delivered result does not dedupe the next identical call');
    assert.equal(second.body.operationId, `${first.body.operationId}-2`, 'the second run takes the next attempt id');
    assert.equal(second.body.returnValue, 'Dedupe');
    assert.equal(await count(), 2, '2 Folders under the root (deliberate rerun)');

    console.log('--- (b) dedupe:false → runs again ---');
    const forced = await call({ code: mutation, dedupe: false });
    log('forced', { body: forced.body });
    assert.equal(forced.body.success, true);
    assert.equal(forced.body.deduplicatedFrom, undefined);
    assert.equal(forced.body.dedupe, undefined, 'dedupe:false carries no auto marker');
    assert.ok(!String(forced.body.operationId).startsWith('auto-'), 'dedupe:false uses a random operationId');
    assert.equal(await count(), 3, '3 Folders after dedupe:false');

    console.log('--- (b) new operation_id → runs again ---');
    const explicit = await call({ code: mutation, operation_id: `field07-${Date.now()}` });
    log('explicit', { body: explicit.body });
    assert.equal(explicit.body.dedupe, undefined, 'an explicit operation_id carries no auto marker');
    assert.equal(await count(), 4, '4 Folders after a new operation_id');

    console.log('--- (b) UNDELIVERED result: short waiter timeout → same code again → the code runs once ---');
    const slowMutation = `task.wait(8) local f = Instance.new("Folder") f.Name = "SlowDedupe" f.Parent = workspace["${ROOT}"] return f.Name`;
    const peerId = await editPeerId(instanceId);
    const slowId = autoOperationId(peerId, slowMutation);
    const timedOutProxy = await proxyExecute(peerId, slowMutation, slowId, 1000);
    log('slow via /proxy timeoutMs=1000', timedOutProxy);
    assert.equal(timedOutProxy.status, 500, 'the waiter leaves with a timeout after 1 s');
    assert.equal(timedOutProxy.body.code, 'request_timeout');
    assert.ok(String(timedOutProxy.body.error).includes(`call get_request_status with operation_id ${slowId}; do not resend`), timedOutProxy.body.error);
    const resend = await call({ code: slowMutation });
    log('immediate resend (still executing)', { body: resend.body });
    if (resend.isError) {
      assert.equal(resend.body.error, 'operation_not_replayed', 'an unknown outcome that is still executing is not re-run');
      assert.ok(String(resend.body.message).includes(`operation_id ${slowId}`), resend.body.message);
    } else {
      assert.equal(resend.body.deduplicatedFrom, slowId, 'either deduplicated or operation_not_replayed');
    }
    await delay(10_000);
    assert.equal(await countNamed('SlowDedupe'), 1, 'after 10 s the SlowDedupe count is 1 (the code ran once)');
    const settledStatus = await client.callToolResult('get_request_status', { request_id: slowId });
    log('status after late settle', { body: settledStatus.body });
    assert.equal(settledStatus.body.state, 'settled');
    assert.equal(typeof settledStatus.body.waiterEndedAt, 'number', 'the result settled without being delivered');
    const afterSettle = await call({ code: slowMutation });
    log('resend after undelivered settle', { body: afterSettle.body });
    assert.equal(afterSettle.isError, false, JSON.stringify(afterSettle.body).slice(0, 300));
    assert.equal(afterSettle.body.deduplicatedFrom, slowId, 'an undelivered retained result is deduplicated');
    assert.equal(afterSettle.body.returnValue, 'SlowDedupe');
    assert.equal(await countNamed('SlowDedupe'), 1, 'the count is still 1 after dedupe');

    console.log('--- (a) 5 parallel execute_luau → queued_ahead 0..4, waitedMs ---');
    const started = Date.now();
    const parallel = await Promise.all([0, 1, 2, 3, 4].map((i) => call({ code: `task.wait(2) return "p${i}"`, dedupe: false })));
    const elapsedMs = Date.now() - started;
    const queuedAhead = parallel.map((r) => r.body.queued_ahead);
    const waited = parallel.map((r) => r.body.waitedMs);
    log('parallel', { elapsedMs, queuedAhead, waited, operationIds: parallel.map((r) => r.body.operationId) });
    for (const r of parallel) assert.equal(r.isError, false, JSON.stringify(r.body).slice(0, 300));
    assert.deepEqual([...queuedAhead].sort(), [0, 1, 2, 3, 4], 'queued_ahead values are 0..4');
    for (const w of waited) assert.ok(Number.isInteger(w) && w >= 0, `waitedMs is an integer >= 0: ${w}`);

    console.log('--- (a) export_rbxm result carries queued_ahead + waitedMs ---');
    const outputPath = path.join(os.tmpdir(), `field07-${process.pid}.rbxm`);
    const exported = await client.callToolResult('export_rbxm', {
      instance_id: instanceId, instance_paths: [`game.Workspace.${ROOT}`], output_path: outputPath,
    }, 60_000);
    log('export', { body: exported.body });
    assert.equal(exported.isError, false);
    assert.equal(typeof exported.body.queued_ahead, 'number');
    assert.equal(typeof exported.body.waitedMs, 'number');
    assert.equal(typeof exported.body.operationId, 'string');
    fs.rmSync(outputPath, { force: true });

    console.log('--- (c) timeout error text: get_request_status guidance + operation_id ---');
    const timeoutId = `field07-timeout-${Date.now()}`;
    const timedOut = await call({ code: 'task.wait(40) return "late"', operation_id: timeoutId }, 90_000);
    log('timeout', { body: timedOut.body });
    assert.equal(timedOut.isError, true, 'the bridge returns a timeout error after 30 s');
    assert.equal(timedOut.body.requestId, timeoutId);
    assert.ok(String(timedOut.body.message).includes(`call get_request_status with operation_id ${timeoutId}; do not resend`), `guidance sentence: ${timedOut.body.message}`);
    const status = await client.callToolResult('get_request_status', { request_id: timeoutId });
    log('status after timeout', { body: status.body });
    assert.equal(status.body.requestId, timeoutId);
  } finally {
    await call({ code: `local f = workspace:FindFirstChild("${ROOT}") if f then f:Destroy() end return "cleaned"`, dedupe: false }).catch(() => {});
  }
});
