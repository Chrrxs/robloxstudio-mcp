#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  closeStudioProcess,
  configureStudioDirectoryIsolation,
  createIsolatedStudioDirectory,
  ISOLATED_STUDIO_PLUGINS_DIR_NAME,
  readStudioPluginDirectorySetting,
  resolveStudioLogsDir,
} from '../scripts/studio-lifecycle.mjs';
import { DIST, McpClient, REPO_ROOT } from './lib/mcp-client.mjs';
import { acquireSuitePort } from './lib/test-port.mjs';

const WORKER_COUNT = 2;
const PROCESS_LOG_TIMEOUT_MS = 15000;
const LAUNCH_TIMEOUT_MS = 30000;
const WORKTREE_PLUGIN = path.join(REPO_ROOT, 'studio-plugin', 'MCPPlugin.rbxmx');

async function installPlugin(worker, port, workerIndex) {
  const env = {
    ...process.env,
    MCP_PLUGINS_DIR: worker.pluginsDirectory,
    ROBLOX_STUDIO_PORT: String(port),
    ROBLOX_STUDIO_REQUIRE_PRIMARY: '1',
    RSMCP_AUTO_ASSIGNED_PORT: '0',
    RSMCP_STUDIO_WORKING_DIRECTORY: worker.workingDirectory,
  };
  const studioExecutable = process.env[`RSMCP_PARALLEL_STUDIO_EXE_${workerIndex + 1}`]
    ?? process.env.ROBLOX_STUDIO_EXE;
  if (studioExecutable) env.ROBLOX_STUDIO_EXE = studioExecutable;
  else delete env.ROBLOX_STUDIO_EXE;

  const child = spawn(
    process.execPath,
    [DIST, '--install-bundled-plugin', '--plugin-path', WORKTREE_PLUGIN],
    {
      env,
      stdio: 'inherit',
    },
  );
  const [code, signal] = await once(child, 'exit');
  if (signal || code !== 0) {
    throw new Error(`Plugin installer ${workerIndex + 1} exited ${signal ?? code ?? 1}`);
  }
  return {
    env,
    pluginPath: path.join(worker.pluginsDirectory, 'MCPPlugin.rbxmx'),
  };
}

function studioLogNames(logsDirectory) {
  return new Set(readdirSync(logsDirectory).filter((name) => name.includes('_Studio_')));
}

async function waitForStudioProcessLog({ logsDirectory, baselineLogs, launch }) {
  const deadline = Date.now() + PROCESS_LOG_TIMEOUT_MS;
  let lastObservedLogs = [];
  while (Date.now() < deadline) {
    lastObservedLogs = readdirSync(logsDirectory)
      .filter((name) => name.includes('_Studio_') && !baselineLogs.has(name));
    for (const name of lastObservedLogs) {
      let contents;
      try {
        contents = readFileSync(path.join(logsDirectory, name), 'utf8');
      } catch {
        continue;
      }
      if (contents.includes(`process '${launch.pid}'`)) return name;
    }
    await delay(250);
  }
  throw new Error(
    `Studio process ${launch.pid} did not log its startup identity within ${PROCESS_LOG_TIMEOUT_MS}ms ` +
    `(new Studio logs: ${JSON.stringify(lastObservedLogs)})`,
  );
}

async function launchWorker(control, worker, recordLaunch) {
  const launch = await control.callTool('manage_instance', {
    action: 'launch',
    source: 'baseplate',
    require_process_identity: true,
    studio_working_directory: worker.workingDirectory,
    timeout_ms: LAUNCH_TIMEOUT_MS,
  });
  if (!launch?.launch_id) throw new Error(`manage_instance did not return launch ownership: ${JSON.stringify(launch)}`);
  if (
    !Number.isSafeInteger(launch.pid) ||
    launch.pid < 1 ||
    typeof launch.process_started_at_file_time !== 'string'
  ) {
    throw new Error(`manage_instance did not return exact process identity: ${JSON.stringify(launch)}`);
  }
  if (launch.studio_working_directory !== worker.workingDirectory) {
    throw new Error(
      `manage_instance reported working directory ${JSON.stringify(launch.studio_working_directory)} ` +
      `instead of ${JSON.stringify(worker.workingDirectory)}`,
    );
  }
  recordLaunch(launch);
  const authorized = await control.callTool('manage_instance', {
    action: 'authorize',
    launch_id: launch.launch_id,
  });
  if (authorized?.process_authorized !== true) {
    throw new Error(`manage_instance did not authorize launch ${launch.launch_id}`);
  }
  const completed = await control.callTool('manage_instance', {
    action: 'complete',
    launch_id: launch.launch_id,
  });
  if (completed?.process_ownership_released !== true) {
    throw new Error(`manage_instance did not release launch ${launch.launch_id}`);
  }
  return launch;
}

async function closeWorker(control, launch) {
  if (!launch) return;
  try {
    const closed = await control.callTool('manage_instance', {
      action: 'close',
      launch_id: launch.launch_id,
    });
    if (closed?.close_status !== 'closed' && closed?.close_status !== 'already_closed') {
      throw new Error(`manage_instance did not confirm launch ${launch.launch_id} closed: ${JSON.stringify(closed)}`);
    }
  } catch (managedError) {
    try {
      await closeStudioProcess({
        processId: launch.pid,
        startedAtFileTime: launch.process_started_at_file_time,
      });
    } catch (identityError) {
      throw new AggregateError(
        [managedError, identityError],
        `Could not close owned Studio process ${launch.pid}`,
        { cause: managedError },
      );
    }
    throw managedError;
  }
}

await configureStudioDirectoryIsolation({ requireStudioClosed: false });
const logsDirectory = resolveStudioLogsDir();
const baselineLogs = studioLogNames(logsDirectory);
const workers = Array.from(
  { length: WORKER_COUNT },
  (_unused, index) => createIsolatedStudioDirectory({ prefix: `parallel-${index + 1}` }),
);
const portLeases = await Promise.all(
  Array.from({ length: WORKER_COUNT }, () => acquireSuitePort({ env: {} })),
);
const controls = [];
const launches = [];
let primaryError;

try {
  const installations = await Promise.all(workers.map((worker, index) =>
    installPlugin(worker, portLeases[index].port, index)));
  for (let index = 0; index < installations.length; index += 1) {
    const source = readFileSync(installations[index].pluginPath, 'utf8');
    const expectedUrl = `http://localhost:${portLeases[index].port}`;
    if (!source.includes(expectedUrl)) {
      throw new Error(`Worker ${index + 1} plugin is missing its isolated URL ${expectedUrl}`);
    }
    for (let other = 0; other < installations.length; other += 1) {
      if (other === index) continue;
      const otherUrl = `http://localhost:${portLeases[other].port}`;
      if (source.includes(otherUrl)) {
        throw new Error(`Worker ${index + 1} plugin contains worker ${other + 1}'s URL ${otherUrl}`);
      }
    }
  }

  await Promise.all(portLeases.map((lease) => lease.handoff()));
  await Promise.all(installations.map(async ({ env }, index) => {
    const control = new McpClient(`parallel-isolation-${index + 1}`, {
      env,
      startupTimeoutMs: 10000,
    });
    controls[index] = control;
    await control.start();
    await control.initialize();
  }));

  const launched = await Promise.all(controls.map(async (control, index) => {
    await configureStudioDirectoryIsolation({ requireStudioClosed: false });
    return launchWorker(control, workers[index], (launch) => {
      launches[index] = launch;
    });
  }));
  const processLogs = await Promise.all(launched.map((launch) =>
    waitForStudioProcessLog({ logsDirectory, baselineLogs, launch })));
  if (new Set(processLogs).size !== WORKER_COUNT) {
    throw new Error(`Both concurrent Studio processes matched the same log: ${JSON.stringify(processLogs)}`);
  }

  const activeSetting = readStudioPluginDirectorySetting();
  if (activeSetting.value !== ISOLATED_STUDIO_PLUGINS_DIR_NAME) {
    throw new Error(
      `Studio rewrote PluginsDir while concurrent workers were active: ${JSON.stringify(activeSetting.value)}`,
    );
  }

  console.log(`Parallel Studio directory isolation passed for ${WORKER_COUNT} concurrent launches.`);
} catch (error) {
  primaryError = error;
  throw error;
} finally {
  const cleanupFailures = [];
  const closes = await Promise.allSettled(launches.map((launch, index) =>
    closeWorker(controls[index], launch)));
  cleanupFailures.push(...closes
    .filter((result) => result.status === 'rejected')
    .map((result) => result.reason));
  const stops = await Promise.allSettled(controls.map((control) => control.stop()));
  cleanupFailures.push(...stops
    .filter((result) => result.status === 'rejected')
    .map((result) => result.reason));
  try {
    await configureStudioDirectoryIsolation({ requireStudioClosed: false });
  } catch (error) {
    cleanupFailures.push(error);
  }
  const releases = await Promise.allSettled(portLeases.map((lease) => lease.release()));
  cleanupFailures.push(...releases
    .filter((result) => result.status === 'rejected')
    .map((result) => result.reason));
  await delay(1000);
  for (const worker of workers) {
    try {
      worker.cleanup();
    } catch (error) {
      cleanupFailures.push(error);
    }
  }
  if (cleanupFailures.length > 0) {
    if (primaryError) {
      throw new AggregateError(
        [primaryError, ...cleanupFailures],
        `Parallel isolation failed and cleanup also failed: ${cleanupFailures.map(String).join('; ')}`,
        { cause: primaryError },
      );
    }
    throw new AggregateError(cleanupFailures, 'Parallel isolation cleanup failed');
  }
}
