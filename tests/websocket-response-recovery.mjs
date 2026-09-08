#!/usr/bin/env node
// Real Studio retry clocks and native sockets cannot be advanced by JS fake timers.
// This transparent proxy delays acknowledgements and drops one complete response;
// it runs the installed production plugin, not an alternate Lua socket adapter.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket, WebSocketServer } from 'ws';
import { configureStudioDirectoryIsolation, createIsolatedStudioDirectory } from '../scripts/studio-lifecycle.mjs';
import { DIST, REPO_ROOT } from './lib/mcp-client.mjs';
import { callMcpHttpTool } from './lib/mcp-http-client.mjs';
import { openManagedStudioSession } from './lib/managed-studio-session.mjs';
import { acquireSuitePort } from './lib/test-port.mjs';

const portLease = await acquireSuitePort({ env: {} });
const pairs = new Set();
const frames = new Map();
const heldAcks = [];
const heldId = randomUUID();
const droppedId = randomUUID();
const completionId = randomUUID();
const lateExecutionId = randomUUID();
const marker = `__MCP_ResponseRecovery_${randomUUID()}`;
let holdAck = true;
let dropped = false;
let heldCompletionResponse;
let heartbeats = 0;
let sequence = 0;
let session;
let worker;
let failure;
const cleanupErrors = [];
const websocketServer = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });
const front = createServer((incoming, outgoing) => {
  const forwarded = request({
    hostname: '127.0.0.1', port: portLease.port, path: incoming.url, method: incoming.method,
    headers: { ...incoming.headers, host: `127.0.0.1:${portLease.port}` },
  }, response => {
    outgoing.writeHead(response.statusCode, response.headers);
    response.pipe(outgoing);
  });
  forwarded.on('error', () => { outgoing.writeHead(502); outgoing.end(); });
  incoming.pipe(forwarded);
});
front.on('upgrade', (incoming, socket, head) => {
  websocketServer.handleUpgrade(incoming, socket, head, downstream => {
    const upstream = new WebSocket(`ws://127.0.0.1:${portLease.port}${incoming.url}`, {
      maxPayload: 64 * 1024 * 1024,
      headers: { 'X-Studio-Token': incoming.headers['x-studio-token'] ?? '' },
    });
    const pair = { upstream, downstream, sequence: ++sequence };
    pairs.add(pair);
    const buffered = [];
    const closePair = () => {
      pairs.delete(pair);
      upstream.terminate();
      downstream.terminate();
    };
    upstream.on('error', closePair);
    downstream.on('error', closePair);
    upstream.on('close', closePair);
    downstream.on('close', closePair);
    upstream.on('open', () => {
      for (const body of buffered) upstream.send(body);
      buffered.length = 0;
    });
    downstream.on('message', bytes => {
      const body = bytes.toString();
      const message = JSON.parse(body);
      if (message.kind === 'response') {
        const record = frames.get(message.requestId) ?? { count: 0, connections: new Set() };
        record.count++;
        record.connections.add(pair.sequence);
        frames.set(message.requestId, record);
        if (message.requestId === completionId) {
          heldCompletionResponse = { upstream, body };
          return;
        }
        if (message.requestId === droppedId && !dropped) {
          dropped = true;
          closePair();
          return;
        }
      }
      if (upstream.readyState === WebSocket.OPEN) upstream.send(body);
      else buffered.push(body);
    });
    upstream.on('message', bytes => {
      const body = bytes.toString();
      const message = JSON.parse(body);
      if (message.kind === 'heartbeat') heartbeats++;
      if (message.kind === 'ack' && message.requestId === heldId && holdAck) {
        heldAcks.push({ downstream, body });
        return;
      }
      if (downstream.readyState === WebSocket.OPEN) downstream.send(body);
    });
  });
});

try {
  front.listen(0, '127.0.0.1');
  await once(front, 'listening');
  const address = front.address();
  assert.ok(address && typeof address === 'object');
  await configureStudioDirectoryIsolation({ requireStudioClosed: false });
  worker = createIsolatedStudioDirectory({ prefix: 'websocket-response-recovery' });
  const runtimeEnv = {
    ...process.env,
    MCP_PLUGINS_DIR: worker.pluginsDirectory,
    RSMCP_STUDIO_WORKING_DIRECTORY: worker.workingDirectory,
    ROBLOX_STUDIO_PORT: String(portLease.port),
    RSMCP_AUTO_ASSIGNED_PORT: '0',
  };
  const installer = spawn(process.execPath, [DIST, '--install-bundled-plugin', '--plugin-path', path.join(REPO_ROOT, 'studio-plugin', 'MCPPlugin.rbxmx')], {
    env: { ...runtimeEnv, ROBLOX_STUDIO_PORT: String(address.port) }, stdio: 'inherit',
  });
  const [installCode, installSignal] = await once(installer, 'exit');
  assert.equal(installSignal, null);
  assert.equal(installCode, 0);
  assert.ok(readFileSync(path.join(worker.pluginsDirectory, 'MCPPlugin.rbxmx'), 'utf8').includes(`http://localhost:${address.port}`));
  await portLease.handoff();
  session = await openManagedStudioSession({ port: portLease.port, env: runtimeEnv });
  const call = (name, args) => callMcpHttpTool(name, args, { port: portLease.port, env: runtimeEnv, timeoutMs: 35000 });
  const mutate = (operation_id, result) => call('execute_luau', {
    instance_id: session.instanceId, target: 'edit', operation_id,
    code: `local key=${JSON.stringify(marker)}; local n=(workspace:GetAttribute(key) or 0)+1; workspace:SetAttribute(key,n); return ${result}`,
  });
  const large = await mutate(heldId, 'string.rep("x", 128 * 1024)');
  assert.equal(large.success, true);
  assert.equal(large.returnValue, 'x'.repeat(128 * 1024));
  const baselineHeartbeats = heartbeats;
  // Cover the old 0.5/1/2/4/5-second retry cadence while real inbound heartbeats
  // keep the Studio socket alive. A delayed ACK must not queue another copy.
  await delay(16000);
  assert.ok(heldAcks.length > 0, 'the proxy actually withheld an acknowledgement');
  assert.ok(heartbeats > baselineHeartbeats, 'inbound heartbeats stayed live');
  assert.equal(frames.get(heldId)?.count, 1, 'only one large response was sent on the unacknowledged live connection');
  holdAck = false;
  for (const ack of heldAcks) {
    assert.equal(ack.downstream.readyState, WebSocket.OPEN);
    ack.downstream.send(ack.body);
  }
  console.log('Native delayed ACK: one 128KiB response, no duplicate frames, live heartbeats.');

  // Observe the handler running separately from a completed mutation whose
  // result is withheld. A client deadline must retain this distinction.
  const completionCall = call('execute_luau', {
    instance_id: session.instanceId, target: 'edit', operation_id: completionId,
    code: `task.wait(2); local key=${JSON.stringify(marker)}; local n=(workspace:GetAttribute(key) or 0)+1; workspace:SetAttribute(key,n); return n`,
  }).then(value => ({ value }), error => ({ error }));
  const waitForStatus = async (requestId, predicate) => {
    const deadline = performance.now() + 15000;
    let observed;
    do {
      observed = await call('get_request_status', { request_id: requestId });
      if (predicate(observed)) return observed;
      await delay(50);
    } while (performance.now() < deadline);
    assert.fail(`Status observation deadline: ${JSON.stringify(observed)}`);
  };
  const executing = await waitForStatus(completionId, status => status.stage === 'executing');
  assert.equal(typeof executing.executionStartedAt, 'number');
  assert.equal(executing.executionCompletedAt, undefined);
  const delivering = await waitForStatus(completionId, status => status.stage === 'response_delivery');
  assert.equal(typeof delivering.executionCompletedAt, 'number');
  assert.equal(delivering.executionOutcome, 'success');
  assert.equal(delivering.response, undefined, 'completion progress is not the result body');
  const timedOut = await completionCall;
  assert.ok(timedOut.error, 'withholding the result must end the HTTP request waiter');
  assert.equal(timedOut.error.body.error, 'request_timeout');
  assert.equal(timedOut.error.body.stage, 'response_delivery');
  assert.equal(timedOut.error.body.executionOutcome, 'success');
  assert.ok(heldCompletionResponse, 'the proxy actually withheld the final response');
  assert.equal(heldCompletionResponse.upstream.readyState, WebSocket.OPEN);
  heldCompletionResponse.upstream.send(heldCompletionResponse.body);
  const recovered = await waitForStatus(completionId, status => status.state === 'settled');
  assert.equal(recovered.outcome, 'success');
  assert.equal(recovered.response.returnValue, '2');
  assert.equal(frames.get(completionId)?.count, 1);
  console.log('Native progress: observed execution, completed mutation with timed-out result delivery, late result recovered.');

  // The bridge deadline is not a forced Luau execution deadline. A yielding
  // handler can finish after its waiter timed out; cancellation is no rollback.
  const lateCall = call('execute_luau', {
    instance_id: session.instanceId, target: 'edit', operation_id: lateExecutionId,
    code: `task.wait(32); local key=${JSON.stringify(marker)}; local n=(workspace:GetAttribute(key) or 0)+1; workspace:SetAttribute(key,n); return n`,
  }).then(value => ({ value }), error => ({ error }));
  await waitForStatus(lateExecutionId, status => status.stage === 'executing');
  const executionWaiter = await lateCall;
  assert.ok(executionWaiter.error);
  assert.equal(executionWaiter.error.body.error, 'request_timeout');
  assert.equal(executionWaiter.error.body.stage, 'executing');
  assert.equal(executionWaiter.error.body.executionOutcome, 'unknown');
  assert.equal(executionWaiter.error.body.executionCompletedAt, undefined);
  const lateExecution = await waitForStatus(lateExecutionId, status => status.state === 'settled');
  assert.equal(lateExecution.outcome, 'success');
  assert.equal(lateExecution.response.returnValue, '3');
  assert.equal(frames.get(lateExecutionId)?.count, 1);
  console.log('Native deadline: execution remained unknown at waiter timeout, then completed once and recovered.');

  // Drop the response before the bridge can record it, then require recovery of
  // the retained outcome on a different connection, never a second execution.
  await mutate(droppedId, 'n').catch(() => undefined);
  const deadline = performance.now() + 15000;
  let status;
  do {
    status = await call('get_request_status', { request_id: droppedId });
    if (status.outcome === 'success') break;
    await delay(100);
  } while (performance.now() < deadline);
  assert.equal(dropped, true);
  assert.equal(status.outcome, 'success');
  assert.equal(status.response.returnValue, '4');
  assert.equal(frames.get(droppedId)?.count, 2);
  assert.equal(frames.get(droppedId)?.connections.size, 2, 'retained response was resent only after socket replacement');
  const verification = await call('execute_luau', {
    instance_id: session.instanceId, target: 'edit',
    code: `local key=${JSON.stringify(marker)}; local n=workspace:GetAttribute(key); workspace:SetAttribute(key,nil); return n`,
  });
  assert.equal(verification.returnValue, '4', 'four requested mutations executed exactly once each');
  console.log('Native interrupted response: recovered on a new socket, exactly four total mutations.');
} catch (error) {
  failure = error;
} finally {
  try {
    await session?.close();
    worker?.cleanup();
  } catch (error) { cleanupErrors.push(error); }
  for (const pair of pairs) { pair.upstream.terminate(); pair.downstream.terminate(); }
  const closed = once(websocketServer, 'close');
  websocketServer.close();
  await closed;
  if (front.listening) {
    const stopped = once(front, 'close');
    front.close();
    front.closeAllConnections();
    await stopped;
  }
  try { await portLease.release(); } catch (error) { cleanupErrors.push(error); }
}
if (failure || cleanupErrors.length) {
  throw new AggregateError([...(failure ? [failure] : []), ...cleanupErrors], 'Native WebSocket response recovery failed');
}
console.log('Native production WebSocket response recovery passed.');
