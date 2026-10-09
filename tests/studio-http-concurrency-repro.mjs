#!/usr/bin/env node

// Measures Studio's concurrency limit for plugin
// HttpService:RequestAsync calls and what happens when a play server shuts
// down while that limit is full:
//   A. ramp hung requests from the edit DataModel until a quick request can
//      no longer start; that count is the limit,
//   B. repeat with extra WebStreamClients open, to see whether sockets count,
//   C. fill the limit from the play server, then probe from the edit
//      DataModel, to see whether the limit is per DataModel or per process,
//   D. control: EndTest with one free slot,
//   E. repro: EndTest with the limit full; then check whether the dead play
//      server's requests still hold slots, and whether releasing them
//      recovers Studio.
// Hung requests are held by a local listener that can release them, so each
// phase is reversible. A–C and F are measurements. D and E are the regression
// gate: the play server must unregister and Studio must return to edit mode
// within a few seconds even when every plugin HTTP slot is taken.

import http from 'node:http';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocketServer } from 'ws';
import { resolveStudioLogsDir } from '../scripts/studio-lifecycle.mjs';
import { BASE_PORT, assert, runTest, startPlaytestAndWait, waitForEditPeer } from './lib/mcp-client.mjs';
import { callMcpHttpTool } from './lib/mcp-http-client.mjs';

const RUN = `rsmcp-httpslots-${Date.now().toString(36)}`;
const MAX_RAMP = 24;
const QUICK_WAIT_SECONDS = 2;
// Studio's own teardown takes 1–2 s; a missed unregister costs 30 s or more.
const SHUTDOWN_BOUND_MS = 8_000;

function tool(name, args = {}, timeoutMs = 30_000) {
  const instanceId = process.env.MCP_INSTANCE_ID;
  const routed = instanceId && ['execute_luau', 'solo_playtest'].includes(name) && args.instance_id === undefined
    ? { ...args, instance_id: instanceId }
    : args;
  return callMcpHttpTool(name, routed, { port: BASE_PORT, env: process.env, timeoutMs });
}

async function luau(target, code, timeoutMs = 20_000) {
  const result = await tool('execute_luau', { target, code }, timeoutMs);
  return result.returnValue;
}

async function health() {
  const response = await fetch(`http://127.0.0.1:${BASE_PORT}/health`, { signal: AbortSignal.timeout(5_000) });
  return response.json();
}

function serverConnectedAts(body) {
  const instanceId = process.env.MCP_INSTANCE_ID;
  return (body.peers ?? [])
    .filter((peer) => peer.role === 'server' && (instanceId === undefined || peer.instanceId === instanceId))
    .map((peer) => peer.connectedAt);
}

function startListener() {
  const arrivals = [];
  const held = new Map();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    arrivals.push({ at: Date.now(), path: url.pathname, tag: url.searchParams.get('tag') });
    req.resume();
    if (url.pathname === '/hang') {
      const tag = url.searchParams.get('tag');
      if (!held.has(tag)) held.set(tag, []);
      held.get(tag).push(res);
      return;
    }
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
    });
  });
  const sockets = new WebSocketServer({ server, path: '/ws' });
  let openSockets = 0;
  sockets.on('connection', (socket) => {
    openSockets += 1;
    socket.on('close', () => { openSockets -= 1; });
  });
  const { promise, resolve, reject } = Promise.withResolvers();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  return {
    port: promise,
    arrived: (pathName, tag) => arrivals.filter((entry) => entry.path === pathName && entry.tag === tag).length,
    heldCount: (tag) => held.get(tag)?.length ?? 0,
    openSockets: () => openSockets,
    release(tag) {
      for (const res of held.get(tag) ?? []) {
        if (!res.writableEnded) {
          res.writeHead(200, { 'content-type': 'text/plain' });
          res.end('released');
        }
      }
      held.delete(tag);
    },
    close() {
      for (const tag of [...held.keys()]) this.release(tag);
      for (const socket of sockets.clients) socket.terminate();
      server.closeAllConnections?.();
      return new Promise((done) => server.close(() => done()));
    },
  };
}

const hangSource = (url, tag, count) => `
local HttpService = game:GetService("HttpService")
for i = 1, ${count} do
	task.spawn(function()
		pcall(function() return HttpService:RequestAsync({ Url = "${url}/hang?tag=${tag}&i=" .. i, Method = "GET" }) end)
	end)
end
return "spawned"
`;

const quickSource = (url, tag, waitSeconds = QUICK_WAIT_SECONDS) => `
local HttpService = game:GetService("HttpService")
local done = false
task.spawn(function()
	done = pcall(function() return HttpService:RequestAsync({ Url = "${url}${url.includes('?') ? '&' : '/quick?'}tag=${tag}", Method = "GET" }) end)
end)
local started = os.clock()
while not done and os.clock() - started < ${waitSeconds} do task.wait(0.05) end
return done and "completed" or "blocked"
`;

const openSocketsSource = (wsUrl, count) => `
local HttpService = game:GetService("HttpService")
_G.__rsmcpReproSockets = _G.__rsmcpReproSockets or {}
for i = 1, ${count} do
	local ok, client = pcall(function()
		return HttpService:CreateWebStreamClient(Enum.WebStreamClientType.WebSocket, { Url = "${wsUrl}" })
	end)
	if ok then table.insert(_G.__rsmcpReproSockets, client) end
end
return tostring(#_G.__rsmcpReproSockets)
`;

const closeSocketsSource = `
for _, client in ipairs(_G.__rsmcpReproSockets or {}) do pcall(function() client:Close() end) end
_G.__rsmcpReproSockets = {}
return "closed"
`;

async function waitFor(predicate, timeoutMs, pollMs = 50) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await delay(pollMs);
  }
  return false;
}

// Adds one hung request at a time and checks whether a quick request can
// still start. Returns the number of hung requests at which it could not.
async function rampLimit(listener, url, target, tag) {
  for (let count = 1; count <= MAX_RAMP; count += 1) {
    await luau(target, hangSource(url, `${tag}`, 1));
    const reached = await waitFor(() => listener.heldCount(tag) >= count, 3_000);
    if (!reached) return { limit: count - 1, note: `hung request ${count} never reached the listener (queued)` };
    const quickTag = `${tag}-q${count}`;
    const quick = await luau(target, quickSource(url, quickTag));
    if (quick !== 'completed') return { limit: count, note: `quick request blocked with ${count} hung` };
  }
  return { limit: null, note: `no limit up to ${MAX_RAMP}` };
}

async function quickProbe(listener, url, target, tag) {
  const result = await luau(target, quickSource(url, tag)).catch((error) => `error: ${error.message}`);
  return { result, arrived: listener.arrived('/quick', tag) };
}

async function waitForEditMode(timeoutMs) {
  const startedAt = Date.now();
  const reached = await waitFor(async () => {
    try {
      return await luau('edit', 'return tostring(game:GetService("StudioTestService").EditModeActive)', 5_000) === 'true';
    } catch {
      return false;
    }
  }, timeoutMs, 200);
  return reached ? Date.now() - startedAt : null;
}

// EndTest from the server with `hung` requests holding slots there.
async function shutdownWithHungRequests(listener, url, tag, hung) {
  await startPlaytestAndWait({ callTool: tool }, { timeoutSec: 60, pollMs: 250 });
  const before = serverConnectedAts(await health());
  if (hung > 0) {
    await luau('server', hangSource(url, tag, hung));
    await waitFor(() => listener.heldCount(tag) >= hung, 5_000);
  }
  const heldAtTrigger = listener.heldCount(tag);
  await luau('server', `task.delay(0.25, function() print("[RSMCP-PROBE] ${RUN} ${tag} endtest") game:GetService("StudioTestService"):EndTest("${RUN}") end) return "ok"`);
  const triggerAt = Date.now() + 250;
  const editModeMs = await waitForEditMode(45_000);
  let goneAt;
  await waitFor(async () => {
    const now = serverConnectedAts(await health());
    if (!before.some((connectedAt) => now.includes(connectedAt))) {
      goneAt = Date.now();
      return true;
    }
    return false;
  }, 45_000, 100);
  return {
    hung,
    heldAtTrigger,
    serverPeerGoneMs: goneAt === undefined ? null : goneAt - triggerAt,
    editModeMs: editModeMs === null ? null : editModeMs - 250,
  };
}

function readLogs(sinceMs) {
  try {
    const root = resolveStudioLogsDir();
    const files = readdirSync(root).map((name) => path.join(root, name))
      .filter((file) => statSync(file).mtimeMs >= sinceMs - 60_000)
      .filter((file) => readFileSync(file, 'utf8').includes(RUN));
    return files.flatMap((file) => readFileSync(file, 'utf8').split(/\r?\n/))
      .filter((line) => {
        const at = Date.parse(line.slice(0, 24));
        return Number.isFinite(at) && at >= sinceMs;
      })
      .filter((line) => /CloseDataModel\].*(Drain|BindToClose)|still waiting|past shutdown deadline|RSMCP-PROBE|HttpTraceError.*127\.0\.0\.1|robloxstudio-mcp\]/i.test(line));
  } catch (error) {
    return [`log read failed: ${error instanceof Error ? error.message : String(error)}`];
  }
}

await runTest('Studio plugin HTTP concurrency and play-server shutdown', async () => {
  const startedAt = Date.now();
  const listener = startListener();
  const port = await listener.port;
  const url = `http://127.0.0.1:${port}`;
  const report = {};
  try {
    await waitForEditPeer({ callTool: tool }, { timeoutMs: 120_000 });
    const step = async (name, fn) => {
      try {
        report[name] = await fn();
      } catch (error) {
        report[name] = { error: error instanceof Error ? error.message : String(error) };
      }
      console.log(`${name}: ${JSON.stringify(report[name])}`);
    };

    await step('A_editLimit', async () => {
      const ramp = await rampLimit(listener, url, 'edit', 'A');
      listener.release('A');
      await delay(500);
      return { ...ramp, afterRelease: await quickProbe(listener, url, 'edit', 'A-after') };
    });

    await step('B_editLimitWithSockets', async () => {
      const opened = await luau('edit', openSocketsSource(`ws://127.0.0.1:${port}/ws`, 3));
      await waitFor(() => listener.openSockets() >= 3, 5_000);
      const listenerSockets = listener.openSockets();
      const ramp = await rampLimit(listener, url, 'edit', 'B');
      listener.release('B');
      await luau('edit', closeSocketsSource);
      await delay(500);
      return { opened, listenerSockets, ...ramp };
    });

    const limit = report.A_editLimit?.limit;
    if (!Number.isInteger(limit)) throw new Error(`no plugin HTTP limit found: ${JSON.stringify(report.A_editLimit)}`);

    // Same host, another host name, and an external host while the limit is
    // full: is the limit per host or shared by every plugin request?
    await step('F_limitScope', async () => {
      await luau('edit', hangSource(url, 'F', limit));
      await waitFor(() => listener.heldCount('F') >= limit, 5_000);
      const result = {
        held: listener.heldCount('F'),
        sameHost: await quickProbe(listener, url, 'edit', 'F-same'),
        localhostName: { result: await luau('edit', quickSource(`http://localhost:${port}`, 'F-localhost', 5)), arrived: listener.arrived('/quick', 'F-localhost') },
        external: { result: await luau('edit', quickSource('https://registry.npmjs.org/-/ping?', 'F-external', 8)) },
      };
      listener.release('F');
      await delay(500);
      result.externalAfterRelease = { result: await luau('edit', quickSource('https://registry.npmjs.org/-/ping?', 'F-external-after', 8)) };
      return result;
    });

    await step('C_crossDataModel', async () => {
      await startPlaytestAndWait({ callTool: tool }, { timeoutSec: 60, pollMs: 250 });
      await luau('server', hangSource(url, 'C', limit));
      await waitFor(() => listener.heldCount('C') >= limit, 5_000);
      const result = {
        heldByServer: listener.heldCount('C'),
        serverQuick: await quickProbe(listener, url, 'server', 'C-server'),
        editQuick: await quickProbe(listener, url, 'edit', 'C-edit'),
      };
      listener.release('C');
      await delay(500);
      await tool('solo_playtest', { action: 'stop' }, 45_000);
      return result;
    });

    await step('D_shutdownOneSlotFree', () => shutdownWithHungRequests(listener, url, 'D', limit - 1));
    listener.release('D');
    await delay(1_000);

    await step('E_shutdownLimitFull', async () => {
      const shutdown = await shutdownWithHungRequests(listener, url, 'E', limit);
      const afterDeath = {
        stillHeld: listener.heldCount('E'),
        editQuick: await quickProbe(listener, url, 'edit', 'E-edit-after-death'),
      };
      listener.release('E');
      await delay(1_000);
      const afterRelease = { editQuick: await quickProbe(listener, url, 'edit', 'E-edit-after-release') };
      let restart;
      try {
        await startPlaytestAndWait({ callTool: tool }, { timeoutSec: 45, pollMs: 250 });
        await tool('solo_playtest', { action: 'stop' }, 45_000);
        restart = 'ok';
      } catch (error) {
        restart = `failed: ${error instanceof Error ? error.message : String(error)}`;
      }
      return { ...shutdown, afterDeath, afterRelease, restart };
    });
  } finally {
    await listener.close();
    await delay(2_000);
    console.log('\n=== Studio log lines (filtered) ===');
    for (const line of readLogs(startedAt).slice(0, 400)) console.log(line);
    console.log('\n=== Summary ===');
    console.log(JSON.stringify({ run: RUN, report }, null, 2));
  }
  for (const phase of ['D_shutdownOneSlotFree', 'E_shutdownLimitFull']) {
    const result = report[phase];
    assert(result && !result.error, `${phase} completed: ${JSON.stringify(result)}`);
    assert(result.serverPeerGoneMs !== null && result.serverPeerGoneMs < SHUTDOWN_BOUND_MS,
      `${phase}: server Peer unregistered within ${SHUTDOWN_BOUND_MS} ms (got ${result.serverPeerGoneMs})`);
    assert(result.editModeMs !== null && result.editModeMs < SHUTDOWN_BOUND_MS,
      `${phase}: Studio back in edit mode within ${SHUTDOWN_BOUND_MS} ms (got ${result.editModeMs})`);
  }
  assert(report.E_shutdownLimitFull.restart === 'ok', `a new playtest starts after the slots free: ${report.E_shutdownLimitFull.restart}`);
}).then((ok) => process.exit(ok ? 0 : 1));
