#!/usr/bin/env node

// Diagnostic for play-server shutdown. A play server shut down while its
// transport is still active (Studio's Stop button, a direct EndTest) runs the
// plugin's BindToClose handler, which unregisters the peer. The MCP
// stop_playtest path suspends the transport before EndTest, so BindToClose has
// nothing left to do. Each cycle ends a solo playtest through one stop path and
// measures, relative to the trigger:
//   - when the plugin's unregister lands (that server Peer leaves /health;
//     a closed socket alone does not unregister it for 30 s),
//   - how long Studio's drain waited on the plugin's BindToClose,
//   - when the edit DataModel is back in edit mode and answering requests,
//   - optional independent BindToClose RequestAsync probes.
// It reports measurements and exits 0 once they are collected, so an
// observed hang is data, not a harness failure.
//
// Scenarios (comma list; the profile harness drops caller environment, so the
// default list is what harness runs use):
//   mcp-stop        solo_playtest stop (control; suspends before EndTest)
//   endtest         StudioTestService:EndTest from the server DataModel
//   endtest-quick-restart  endtest, then solo_playtest start at once
//   probe           EndTest plus an independent BindToClose RequestAsync
//   http-saturation EndTest while server-side RequestAsync calls hang forever
//                   (wedges plugin HTTP until Studio restarts; run it last)
// studio-http-concurrency-repro.mjs isolates the plugin HTTP limit itself.
//
// Outside the Windows profile harness (for example Studio under Wine/Proton):
//   MCP_INSTANCE_ID=<id> RSMCP_STUDIO_LOGS_DIR=<prefix>/drive_c/users/<user>/AppData/Local/Roblox/logs \
//   RSMCP_SHUTDOWN_SCENARIOS=endtest:3,probe:3 node tests/run-all.mjs --test play-server-shutdown-disconnect-repro.mjs
// On Linux each cycle also records Recv-Q/Send-Q of sockets on the MCP port.

import { execFileSync } from 'node:child_process';
import http from 'node:http';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { resolveStudioLogsDir } from '../scripts/studio-lifecycle.mjs';
import {
  BASE_PORT,
  runTest,
  startPlaytestAndWait,
  waitForEditPeer,
} from './lib/mcp-client.mjs';
import { callMcpHttpTool } from './lib/mcp-http-client.mjs';

const DEFAULT_SCENARIOS = 'mcp-stop:2,endtest:3,endtest-quick-restart:3,probe:2';
const SCENARIOS = (process.env.RSMCP_SHUTDOWN_SCENARIOS ?? DEFAULT_SCENARIOS).split(',').map((entry) => {
  const [name, count] = entry.trim().split(':');
  return { name, cycles: Number.parseInt(count ?? '1', 10) };
});
const SETTLE_TIMEOUT_MS = 45_000;
const PEER_GONE_TIMEOUT_MS = 45_000;
// Longer than the server's 30 s pong timeout plus one 10 s heartbeat.
const IDLE_MS = 50_000;
const SATURATION_REQUESTS = 12;
const RUN = `rsmcp-shutdown-${Date.now().toString(36)}`;
const PLUGIN_HANDLER = 'MCPPlugin.modules.StudioWebSocket';

function tool(name, args = {}, timeoutMs = 30_000) {
  const instanceId = process.env.MCP_INSTANCE_ID;
  const routed = instanceId && ['execute_luau', 'solo_playtest'].includes(name) && args.instance_id === undefined
    ? { ...args, instance_id: instanceId }
    : args;
  return callMcpHttpTool(name, routed, { port: BASE_PORT, env: process.env, timeoutMs });
}

async function health() {
  const response = await fetch(`http://127.0.0.1:${BASE_PORT}/health`, { signal: AbortSignal.timeout(5_000) });
  return response.json();
}

function ourPeers(body, role) {
  const instanceId = process.env.MCP_INSTANCE_ID;
  return (body.peers ?? []).filter((peer) =>
    peer.role === role && (instanceId === undefined || peer.instanceId === instanceId));
}

// Kernel queue depths for every TCP socket on the MCP port. A Studio-side
// Recv-Q that keeps growing means Studio stopped reading that socket.
function socketQueues() {
  if (process.platform !== 'linux') return undefined;
  try {
    return execFileSync('ss', ['-tnH', `( sport = :${BASE_PORT} or dport = :${BASE_PORT} )`], { encoding: 'utf8' })
      .trim().split('\n').filter(Boolean).map((line) => line.trim().replace(/\s+/g, ' '));
  } catch (error) {
    return [`ss failed: ${error instanceof Error ? error.message : String(error)}`];
  }
}

// Timestamped /health samples. A server Peer is identified by connectedAt.
function startHealthPoller() {
  const samples = [];
  let running = true;
  const done = (async () => {
    while (running) {
      const at = Date.now();
      try {
        const body = await health();
        const edit = ourPeers(body, 'edit')[0];
        samples.push({
          at,
          servers: ourPeers(body, 'server').map((peer) => peer.connectedAt),
          sockets: body.activeWebSockets,
          editActivity: edit?.lastActivity,
          editConnectedAt: edit?.connectedAt,
        });
      } catch (error) {
        samples.push({ at, error: String(error) });
      }
      await delay(50);
    }
  })();
  return { samples, stop: async () => { running = false; await done; } };
}

function lastSample(samples) {
  for (let index = samples.length - 1; index >= 0; index -= 1) {
    if (samples[index].error === undefined) return samples[index];
  }
  return undefined;
}

function firstAfter(samples, since, predicate) {
  return samples.find((sample) => sample.at >= since && sample.error === undefined && predicate(sample))?.at;
}

function startProbeListener() {
  const arrivals = [];
  const held = new Set();
  const server = http.createServer((req, res) => {
    arrivals.push({ at: Date.now(), url: req.url });
    req.resume();
    if (req.url.startsWith('/hang')) {
      held.add(res);
      return;
    }
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
    });
  });
  const { promise, resolve, reject } = Promise.withResolvers();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  return {
    arrivals,
    port: promise,
    close: () => {
      for (const res of held) res.destroy();
      server.closeAllConnections?.();
      return new Promise((done) => server.close(() => done()));
    },
  };
}

async function luau(target, code, timeoutMs = 15_000) {
  return tool('execute_luau', { target, code }, timeoutMs);
}

async function waitForEditMode(since) {
  const deadline = since + SETTLE_TIMEOUT_MS;
  let failures = 0;
  let last;
  while (Date.now() < deadline) {
    try {
      const result = await luau('edit', 'return tostring(game:GetService("StudioTestService").EditModeActive)', 5_000);
      last = result.returnValue;
      if (result.success === true && result.returnValue === 'true') return { at: Date.now(), failures, last };
    } catch (error) {
      failures += 1;
      last = error instanceof Error ? error.message : String(error);
    }
    await delay(100);
  }
  return { at: undefined, failures, last };
}

function mark(tag) {
  return `print("[RSMCP-PROBE] ${RUN} ${tag} t=" .. DateTime.now().UnixTimestampMillis)`;
}

function probeSource(tag, probeUrl) {
  return `
local HttpService = game:GetService("HttpService")
game:BindToClose(function()
	${mark(`${tag} probe_start`)}
	local ok, res = pcall(function()
		return HttpService:RequestAsync({ Url = "${probeUrl}/probe?run=${RUN}&tag=${tag}", Method = "POST", Body = "x", Headers = { ["Content-Type"] = "text/plain" } })
	end)
	print("[RSMCP-PROBE] ${RUN} ${tag} probe_end ok=" .. tostring(ok) .. " detail=" .. (ok and tostring(res.StatusCode) or tostring(res)) .. " t=" .. DateTime.now().UnixTimestampMillis)
end)
return "probe-installed"
`;
}

function saturationSource(tag, probeUrl) {
  return `
local HttpService = game:GetService("HttpService")
for i = 1, ${SATURATION_REQUESTS} do
	task.spawn(function()
		pcall(function()
			return HttpService:RequestAsync({ Url = "${probeUrl}/hang?run=${RUN}&tag=${tag}&i=" .. i, Method = "GET" })
		end)
	end)
end
return "saturating"
`;
}

const endTestSource = (tag) => `
task.delay(0.25, function()
	${mark(`${tag} trigger`)}
	game:GetService("StudioTestService"):EndTest("${RUN}")
end)
return "scheduled"
`;

async function startNextPlaytest(deadlineMs = 30_000) {
  const startedAt = Date.now();
  let last;
  while (Date.now() - startedAt < deadlineMs) {
    try {
      const result = await tool('solo_playtest', { action: 'start', mode: 'play' });
      if (result.success === true) return { at: Date.now(), attempts: last?.attempts ?? 1 };
      last = { detail: JSON.stringify(result), attempts: (last?.attempts ?? 0) + 1 };
    } catch (error) {
      last = { detail: error instanceof Error ? error.message : String(error), attempts: (last?.attempts ?? 0) + 1 };
    }
    await delay(200);
  }
  return { at: undefined, ...last };
}

async function waitForServerPeer(excluded, timeoutMs, samples) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const fresh = lastSample(samples)?.servers.find((connectedAt) => !excluded.has(connectedAt));
    if (fresh !== undefined) return fresh;
    await delay(100);
  }
  return undefined;
}

function readOurLogs(sinceMs) {
  let root;
  try {
    root = process.env.RSMCP_STUDIO_LOGS_DIR || resolveStudioLogsDir();
  } catch (error) {
    return { error: String(error) };
  }
  const files = readdirSync(root)
    .map((name) => path.join(root, name))
    .filter((file) => { try { return statSync(file).mtimeMs >= sinceMs - 60_000; } catch { return false; } });
  const ours = files.filter((file) => readFileSync(file, 'utf8').includes(RUN));
  const lines = [];
  for (const file of ours) {
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const at = Date.parse(line.slice(0, 24));
      if (Number.isFinite(at) && at >= sinceMs) lines.push({ at, line });
    }
  }
  lines.sort((left, right) => left.at - right.at);
  return { files: ours.map((file) => path.basename(file)), lines };
}

// Per trigger: how long the drain waited on the plugin's BindToClose and
// whether Studio reported missing the shutdown deadline.
function drainReport(lines, fromMs, toMs) {
  const window = lines.filter(({ at }) => at >= fromMs - 1_000 && at < toMs);
  const waiting = window.find(({ line }) => /waiting on BindToClose in .*StudioWebSocket/.test(line) || /still waiting.*StudioWebSocket/i.test(line));
  const completed = window.find(({ at, line }) => waiting && at >= waiting.at && /completed BindToClose in .*StudioWebSocket/.test(line));
  return {
    pluginBindToCloseObserved: waiting !== undefined,
    pluginBindToCloseMs: waiting && completed ? completed.at - waiting.at : null,
    stillWaitingLines: window.filter(({ line }) => /still waiting/i.test(line)).length,
    pastDeadlineLines: window.filter(({ line }) => /past shutdown deadline/i.test(line)).length,
    probeLines: window.filter(({ line }) => /RSMCP-PROBE.*probe_(start|end)/.test(line)).map(({ line }) => line.replace(/^.*\[RSMCP-PROBE\] \S+ /, '')),
  };
}

const INTERESTING = [
  /CloseDataModel\].*(Drain|BindToClose)/,
  /still waiting/i,
  /past shutdown deadline/i,
  /RSMCP-PROBE/,
  /HttpTraceError.*(127\.0\.0\.1|localhost)/,
  /WebStreamClient\]/,
  /wstrack|TrackHttpRequest/,
  /robloxstudio-mcp/,
];

await runTest('play-server shutdown /disconnect repro', async () => {
  const startedAt = Date.now();
  const probe = startProbeListener();
  const probeUrl = `http://127.0.0.1:${await probe.port}`;
  const poller = startHealthPoller();
  const cycles = [];
  let idleReport;
  let sessionRunning = false;
  let knownServers = new Set();
  try {
    await waitForEditPeer({ callTool: tool }, { timeoutMs: 120_000 });
    const baseline = await health();
    console.log(`baseline: activeWebSockets=${baseline.activeWebSockets} scenarios=${JSON.stringify(SCENARIOS)}`);

    let index = 0;
    let consecutiveErrors = 0;
    for (const scenario of SCENARIOS) {
      for (let cycle = 1; cycle <= scenario.cycles; cycle += 1) {
        index += 1;
        const tag = `${scenario.name}-${cycle}`;
        try {
          if (!sessionRunning) {
            await startPlaytestAndWait({ callTool: tool }, { timeoutSec: 60, pollMs: 250 });
          }
          sessionRunning = false;
          const serverPeer = await waitForServerPeer(knownServers, 30_000, poller.samples);
          if (serverPeer === undefined) throw new Error(`${tag}: no server Peer registered`);
          for (const connectedAt of lastSample(poller.samples).servers) knownServers.add(connectedAt);

          if (scenario.name === 'probe') {
            const installed = await luau('server', probeSource(tag, probeUrl));
            if (installed.returnValue !== 'probe-installed') throw new Error(`${tag}: probe install failed: ${JSON.stringify(installed)}`);
          }
          if (scenario.name === 'http-saturation') {
            await luau('server', saturationSource(tag, probeUrl));
            const hangDeadline = Date.now() + 5_000;
            while (Date.now() < hangDeadline
              && probe.arrivals.filter((entry) => entry.url.startsWith('/hang') && entry.url.includes(`tag=${tag}&`)).length < SATURATION_REQUESTS) {
              await delay(50);
            }
          }

          let trigger;
          let triggerAt;
          if (scenario.name === 'mcp-stop') {
            await luau('server', mark(`${tag} trigger`));
            triggerAt = Date.now();
            try {
              trigger = await tool('solo_playtest', { action: 'stop' }, 45_000);
            } catch (error) {
              trigger = { error: error instanceof Error ? error.message : String(error) };
            }
          } else {
            const scheduled = await luau('server', endTestSource(tag));
            triggerAt = Date.now() + 250;
            trigger = { scheduled: scheduled.returnValue };
          }

          let restart;
          if (scenario.name === 'endtest-quick-restart') {
            restart = await startNextPlaytest();
            sessionRunning = restart.at !== undefined;
          }

          const gone = () => firstAfter(poller.samples, triggerAt, (sample) => !sample.servers.includes(serverPeer));
          const edit = sessionRunning ? { at: undefined, failures: 0, last: 'skipped (restarted)' } : await waitForEditMode(triggerAt);
          let echoMs = null;
          let echoError = null;
          const echoStart = Date.now();
          try {
            const echo = await luau('edit', `return "${RUN}-echo-${index}"`, 20_000);
            if (echo.returnValue === `${RUN}-echo-${index}`) echoMs = Date.now() - echoStart;
            else echoError = JSON.stringify(echo);
          } catch (error) {
            echoError = error instanceof Error ? error.message : String(error);
          }
          const goneDeadline = triggerAt + PEER_GONE_TIMEOUT_MS;
          while (Date.now() < goneDeadline && gone() === undefined) await delay(250);

          const row = {
            tag,
            trigger,
            restart,
            serverPeerGoneMs: gone() === undefined ? null : gone() - triggerAt,
            editModeMs: edit.at === undefined ? null : edit.at - triggerAt,
            editModeProbeFailures: edit.failures,
            editModeLast: edit.at === undefined ? edit.last : undefined,
            editEchoMs: echoMs,
            editEchoError: echoError,
            socketQueues: socketQueues(),
            triggerAt,
          };
          cycles.push(row);
          console.log(`cycle ${tag}: ${JSON.stringify({ ...row, triggerAt: undefined })}`);
          consecutiveErrors = 0;
        } catch (error) {
          consecutiveErrors += 1;
          const detail = error instanceof Error ? error.message : String(error);
          console.log(`cycle ${tag}: ERROR ${detail}`);
          cycles.push({ tag, error: detail, triggerAt: Date.now() });
          sessionRunning = false;
          await tool('solo_playtest', { action: 'stop' }, 45_000).catch(() => undefined);
          await delay(3_000);
          if (consecutiveErrors >= 2) throw error;
        }
      }
    }
    if (sessionRunning) {
      await tool('solo_playtest', { action: 'stop' }, 45_000).catch(() => undefined);
      sessionRunning = false;
    }

    // Idle edit socket: with no MCP traffic, edit-Peer activity only advances
    // if Studio answers the server's WebSocket pings (PR #112 servers).
    const idleStart = Date.now();
    await delay(IDLE_MS);
    const idle = poller.samples.filter((sample) => sample.at >= idleStart && sample.error === undefined);
    const activityValues = [...new Set(idle.map((sample) => sample.editActivity).filter((value) => value !== undefined))];
    idleReport = {
      idleMs: IDLE_MS,
      editActivityAdvances: Math.max(activityValues.length - 1, 0),
      minActiveWebSockets: idle.length ? Math.min(...idle.map((sample) => sample.sockets)) : null,
      editConnectedAtValues: [...new Set(idle.map((sample) => sample.editConnectedAt))],
      socketQueues: socketQueues(),
    };
    console.log(`idle: ${JSON.stringify(idleReport)}`);
  } finally {
    if (sessionRunning) await tool('solo_playtest', { action: 'stop' }, 45_000).catch(() => undefined);
    await poller.stop();
    await probe.close();
  }

  await delay(2_000);
  const logs = readOurLogs(startedAt);
  console.log('\n=== Studio log lines (filtered) ===');
  console.log(`files: ${JSON.stringify(logs.files ?? logs.error)}`);
  for (const { line } of (logs.lines ?? []).filter(({ line }) => INTERESTING.some((pattern) => pattern.test(line))).slice(0, 600)) {
    console.log(line);
  }
  const summary = cycles.map((row, position) => {
    const next = cycles[position + 1]?.triggerAt ?? Date.now();
    const { triggerAt, socketQueues: _queues, ...rest } = row;
    return { ...rest, ...(logs.lines ? drainReport(logs.lines, triggerAt, next) : {}) };
  });
  console.log('\n=== Summary ===');
  console.log(JSON.stringify({ run: RUN, pluginHandler: PLUGIN_HANDLER, cycles: summary, idle: idleReport }, null, 2));
}).then((ok) => process.exit(ok ? 0 : 1));
