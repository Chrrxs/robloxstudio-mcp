#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { createConnection } from 'node:net';
import {
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { BASE_PORT, McpClient, DIST, assert } from './lib/mcp-client.mjs';
import { resolveAuthToken } from '../packages/core/dist/auth.js';
import {
  closeStudioProcess,
  configureStudioDirectoryIsolation,
  createIsolatedStudioDirectory,
  resolveStudioLogsDir,
} from '../scripts/studio-lifecycle.mjs';

const INSTANCE_UUID = randomUUID();
const INSTANCE_ID = `anon:${INSTANCE_UUID}`;
const REPRO_PLUGIN_NAME = '000_RSMCP_EditHistoryRepro.rbxmx';
const SERVER_ENV = {
  ROBLOX_STUDIO_PROXY_PROMOTION_INTERVAL_MS: '600000',
};

function isPortOpen(port) {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.setTimeout(1000);
    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.on('error', () => resolve(false));
  });
}

function stringAttributeBlob(name, value) {
  const nameBytes = Buffer.from(name, 'utf8');
  const valueBytes = Buffer.from(value, 'utf8');
  const blob = Buffer.alloc(4 + 4 + nameBytes.length + 1 + 4 + valueBytes.length);
  let offset = 0;
  blob.writeUInt32LE(1, offset);
  offset += 4;
  blob.writeUInt32LE(nameBytes.length, offset);
  offset += 4;
  nameBytes.copy(blob, offset);
  offset += nameBytes.length;
  blob[offset] = 2; // Roblox AttributesSerialize string value tag.
  offset += 1;
  blob.writeUInt32LE(valueBytes.length, offset);
  offset += 4;
  valueBytes.copy(blob, offset);
  return blob.toString('base64');
}

function lifecyclePlaceXml() {
  const attributes = stringAttributeBlob('__MCPPlaceId', INSTANCE_UUID);
  return `<?xml version="1.0" encoding="utf-8"?>
<roblox version="4">
  <External>null</External>
  <External>nil</External>
  <Item class="Workspace" referent="RBX0">
    <Properties><string name="Name">Workspace</string></Properties>
  </Item>
  <Item class="ServerStorage" referent="RBX1">
    <Properties>
      <string name="Name">ServerStorage</string>
      <BinaryString name="AttributesSerialize">${attributes}</BinaryString>
    </Properties>
  </Item>
</roblox>
`;
}

function reproPluginXml(marker, invalidUtf8 = false) {
  const messageExpression = invalidUtf8
    ? `${JSON.stringify(marker)} .. string.char(0xA3, 0xB7, 0xC7)`
    : JSON.stringify(marker);
  return `<?xml version="1.0" encoding="utf-8"?>
<roblox version="4">
  <Item class="Script" referent="0">
    <Properties>
      <string name="Name">RSMCP_EditHistoryRepro</string>
      <token name="RunContext">0</token>
      <string name="Source"><![CDATA[error(${messageExpression}, 0)]]></string>
    </Properties>
  </Item>
</roblox>
`;
}

async function launchLocalPlace(client, placeFile, workingDirectory, launchedProcesses) {
  await configureStudioDirectoryIsolation({ requireStudioClosed: false });
  const launch = await client.callTool('manage_instance', {
    action: 'launch',
    source: 'local_file',
    local_place_file: placeFile,
    studio_working_directory: workingDirectory,
    require_process_identity: true,
    wait_for_connection: false,
    timeout_ms: 120000,
  });
  assert(!!launch.launch_id, `identity launch returned launch_id (${JSON.stringify(launch)})`);
  assert(Number.isSafeInteger(launch.pid), `identity launch returned pid (${JSON.stringify(launch)})`);
  assert(
    typeof launch.process_started_at_file_time === 'string',
    `identity launch returned process creation time (${JSON.stringify(launch)})`,
  );
  launchedProcesses.push({
    processId: launch.pid,
    startedAtFileTime: launch.process_started_at_file_time,
  });

  const authorized = await client.callTool('manage_instance', {
    action: 'authorize',
    launch_id: launch.launch_id,
  });
  assert(authorized.process_authorized === true, 'identity launch was authorized');
  const completed = await client.callTool('manage_instance', {
    action: 'complete',
    launch_id: launch.launch_id,
  });
  assert(completed.process_ownership_released === true, 'identity launch ownership was released');

  const deadline = Date.now() + 120000;
  let status;
  while (Date.now() < deadline) {
    status = await client.callTool('manage_instance', {
      action: 'status',
      launch_id: launch.launch_id,
    });
    if (status.connected && status.instance_id) {
      return { ...status, launch_id: launch.launch_id };
    }
    if (status.state === 'failed' || status.state === 'exited') break;
    await delay(250);
  }
  throw new Error(`Managed Studio launch did not connect: ${JSON.stringify(status)}`);
}

async function serverInstances() {
  const { token } = resolveAuthToken();
  const response = await fetch(`http://127.0.0.1:${BASE_PORT}/instances`, {
    headers: token ? { 'X-MCP-Auth': token } : undefined,
  });
  if (!response.ok) throw new Error(`/instances returned HTTP ${response.status}`);
  return response.json();
}

async function waitForSessionActivityAdvance(pluginSessionId, priorActivity, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const body = await serverInstances();
    const session = (body.instances ?? []).find(
      (instance) => instance.pluginSessionId === pluginSessionId,
    );
    if (session?.lastActivity > priorActivity) return;
    await delay(25);
  }
  throw new Error(`Session ${pluginSessionId} did not activate its event stream within ${timeoutMs}ms`);
}

async function waitForStudioLogLine(needle, startedAt, timeoutMs = 20_000) {
  const logsDir = resolveStudioLogsDir();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const candidates = readdirSync(logsDir)
      .filter((name) => name.includes('_Studio_'))
      .map((name) => path.join(logsDir, name))
      .filter((file) => statSync(file).mtimeMs >= startedAt - 1000);
    for (const file of candidates) {
      if (readFileSync(file, 'utf8').includes(needle)) return Date.now();
    }
    await delay(100);
  }
  throw new Error(`Studio log did not contain ${JSON.stringify(needle)} within ${timeoutMs}ms`);
}

function matchingEditSessions(body) {
  return (body.instances ?? []).filter(
    (instance) => instance.instanceId === INSTANCE_ID && instance.role === 'edit',
  );
}

async function assertLogMarker(client, marker, expectedCount, expectedLevel = 'ERR') {
  const logs = await client.callTool('get_runtime_logs', {
    instance_id: INSTANCE_ID,
    target: 'edit',
    filter: marker,
  }, 5_000);
  const matches = (logs.entries ?? []).filter((entry) => entry.message.includes(marker));
  assert(matches.length === expectedCount, `${marker} appears ${expectedCount} time(s) in edit startup history`);
  if (expectedCount > 0) {
    assert(matches.every((entry) => entry.level === expectedLevel), `${marker} preserves ${expectedLevel} level`);
  }
  return matches;
}

async function main() {
  if (await isPortOpen(BASE_PORT)) {
    throw new Error(`Port ${BASE_PORT} is already occupied. Stop existing MCP servers before running this E2E.`);
  }

  await configureStudioDirectoryIsolation({ requireStudioClosed: false });
  const worker = createIsolatedStudioDirectory({ prefix: 'lifecycle-regressions' });
  const placeFile = path.join(worker.workingDirectory, 'Lifecycle.rbxlx');
  const reproPlugin = path.join(worker.pluginsDirectory, REPRO_PLUGIN_NAME);
  const markerA = `[MCP-EDIT-HISTORY-E2E-A-${Date.now()}]`;
  const markerB = `[MCP-EDIT-HISTORY-E2E-B-${Date.now()}]`;
  const liveInvalidMarker = `[MCP-LIVE-INVALID-UTF8-${Date.now()}]`;
  const launchedProcesses = [];
  let client;
  let keepOldSessionAlive;
  let bodyError;

  try {
    writeFileSync(placeFile, lifecyclePlaceXml());
    writeFileSync(reproPlugin, reproPluginXml(markerA, true));

    client = new McpClient('studio-lifecycle-regressions', {
      command: 'node',
      args: [DIST, '--auto-install-plugin'],
      env: {
        ...SERVER_ENV,
        MCP_PLUGINS_DIR: worker.pluginsDirectory,
        RSMCP_STUDIO_WORKING_DIRECTORY: worker.workingDirectory,
      },
      startupTimeoutMs: 60000,
    });
    await client.start();
    await client.initialize();

    console.log('\n=== edit startup history captures pre-listener errors ===');
    const firstLaunch = await launchLocalPlace(
      client,
      placeFile,
      worker.workingDirectory,
      launchedProcesses,
    );
    assert(firstLaunch.instance_id === INSTANCE_ID, 'first launch uses the persisted anonymous instance id');
    const firstSessions = matchingEditSessions(await serverInstances());
    assert(firstSessions.length === 1, 'first launch has one edit registration');
    const firstSessionId = firstSessions[0].pluginSessionId;
    const startupInvalidEntries = await assertLogMarker(client, markerA, 1);
    assert(
      startupInvalidEntries[0].message.includes(`${markerA}\\xA3\\xB7\\xC7`),
      'edit startup history escapes malformed UTF-8 bytes without dropping the log message',
    );

    // Force termination prevents plugin.Unloading from reliably completing
    // /disconnect, reproducing the stale-registration fast-relaunch race.
    await closeStudioProcess(launchedProcesses[0]);
    await configureStudioDirectoryIsolation({ requireStudioClosed: false });
    writeFileSync(reproPlugin, reproPluginXml(markerB));
    const staleSession = (await serverInstances()).instances.find(
      (instance) => instance.pluginSessionId === firstSessionId,
    );
    assert(staleSession, 'terminated Studio session remains registered for takeover reproduction');
    const staleSessionActivity = staleSession.lastActivity;

    // Re-open the terminated peer's event stream long enough to reproduce a
    // duplicate that is still transport-active using the production SSE
    // contract.
    const oldStreamController = new AbortController();
    keepOldSessionAlive = {
      controller: oldStreamController,
      completion: (async () => {
        const response = await fetch(
          `http://127.0.0.1:${BASE_PORT}/events?pluginSessionId=${encodeURIComponent(firstSessionId)}`,
          {
            headers: { Accept: 'text/event-stream' },
            signal: oldStreamController.signal,
          },
        );
        if (!response.ok) {
          throw new Error(`Held stale-session event stream returned HTTP ${response.status}`);
        }
        if (!response.body) throw new Error('Held stale-session event stream has no response body');
        const reader = response.body.getReader();
        while (!oldStreamController.signal.aborted) {
          const event = await reader.read();
          if (event.done) {
            if (oldStreamController.signal.aborted) break;
            throw new Error('Held stale-session event stream closed unexpectedly');
          }
        }
      })().then(
        () => undefined,
        (error) => error,
      ),
    };
    await waitForSessionActivityAdvance(firstSessionId, staleSessionActivity);
    console.log('\n=== fast relaunch automatically takes over a stale predecessor ===');
    const relaunchedAt = Date.now();
    const secondLaunchPromise = launchLocalPlace(
      client,
      placeFile,
      worker.workingDirectory,
      launchedProcesses,
    );
    const conflictObservedAt = await waitForStudioLogLine(
      `/ready rejected for ${INSTANCE_ID}/edit: HTTP 409 Conflict`,
      relaunchedAt,
    );
    keepOldSessionAlive.controller.abort();
    const oldStreamError = await keepOldSessionAlive.completion;
    if (oldStreamError !== undefined && oldStreamError.name !== 'AbortError') throw oldStreamError;
    keepOldSessionAlive = undefined;
    assert(true, `replacement receives a real duplicate 409 after ${conflictObservedAt - relaunchedAt}ms`);

    const secondLaunch = await secondLaunchPromise;
    const connectedAt = Date.now();
    const relaunchElapsedMs = connectedAt - relaunchedAt;
    const recoveryAfterConflictMs = connectedAt - conflictObservedAt;
    assert(secondLaunch.instance_id === INSTANCE_ID, 'relaunch preserves the anonymous instance id');
    assert(relaunchElapsedMs < 25_000, `relaunch becomes routable without the 30s stale timeout (${relaunchElapsedMs}ms)`);
    assert(recoveryAfterConflictMs < 5_000, `relaunch recovers after the forced conflict (${recoveryAfterConflictMs}ms)`);

    const secondSessions = matchingEditSessions(await serverInstances());
    assert(secondSessions.length === 1, 'takeover leaves exactly one edit registration');
    assert(secondSessions[0].pluginSessionId !== firstSessionId, 'takeover routes through the new plugin session');

    const routed = await client.callTool('execute_luau', {
      instance_id: INSTANCE_ID,
      target: 'edit',
      code: 'return "relaunch-ok"',
    });
    assert(routed.success === true && routed.returnValue === 'relaunch-ok', 'an edit tool call routes through the relaunched Studio process');

    await assertLogMarker(client, markerB, 1);
    await assertLogMarker(client, markerA, 0);

    console.log('\n=== live malformed UTF-8 logs remain JSON-safe ===');
    const scheduled = await client.callTool('execute_luau', {
      instance_id: INSTANCE_ID,
      target: 'edit',
      code: `task.delay(0.25, function() warn(${JSON.stringify(liveInvalidMarker)} .. string.char(0xA3, 0xB7, 0xC7)) end); return "scheduled"`,
    });
    assert(scheduled.success === true && scheduled.returnValue === 'scheduled', 'malformed live log is scheduled after execute_luau responds');
    await delay(500);
    const unfiltered = await client.callTool('get_runtime_logs', {
      instance_id: INSTANCE_ID,
      target: 'edit',
      tail: 50,
    }, 5_000);
    assert(
      unfiltered.entries?.some((entry) => entry.message.includes(`${liveInvalidMarker}\\xA3\\xB7\\xC7`)),
      'original unfiltered tail=50 timeout reproduction returns the escaped malformed log',
    );
    const liveInvalidEntries = await assertLogMarker(client, liveInvalidMarker, 1, 'WARN');
    assert(
      liveInvalidEntries[0].message.includes(`${liveInvalidMarker}\\xA3\\xB7\\xC7`),
      'live MessageOut capture escapes malformed UTF-8 bytes without dropping the log message',
    );
    console.log('\n✅ Studio lifecycle regressions PASSED');
  } catch (error) {
    bodyError = error;
    throw error;
  } finally {
    const cleanupErrors = [];
    if (keepOldSessionAlive) {
      keepOldSessionAlive.controller.abort();
      const oldStreamError = await keepOldSessionAlive.completion;
      if (oldStreamError !== undefined && oldStreamError.name !== 'AbortError') {
        cleanupErrors.push(oldStreamError);
      }
    }
    if (client) {
      try {
        const status = await client.callTool('manage_instance', { action: 'status' });
        for (const record of status?.managed ?? []) {
          if (
            record.studio_working_directory === worker.workingDirectory &&
            typeof record.launch_id === 'string'
          ) {
            await client.callTool('manage_instance', {
              action: 'close',
              launch_id: record.launch_id,
            });
          }
        }
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    for (const identity of launchedProcesses) {
      try {
        await closeStudioProcess(identity);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (client) {
      try {
        await client.stop();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    try {
      await configureStudioDirectoryIsolation({ requireStudioClosed: false });
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      worker.cleanup();
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (cleanupErrors.length > 0) {
      if (bodyError) {
        throw new AggregateError(
          [bodyError, ...cleanupErrors],
          `Studio lifecycle regression failed and cleanup also failed: ${cleanupErrors.map(String).join('; ')}`,
          { cause: bodyError },
        );
      }
      throw new AggregateError(cleanupErrors, 'Studio lifecycle regression cleanup failed');
    }
  }
}

try {
  await main();
} catch (error) {
  console.error(`\n❌ Studio lifecycle regressions FAILED: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exitCode = 1;
}
