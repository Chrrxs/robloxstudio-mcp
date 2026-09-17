#!/usr/bin/env node

import { pathToFileURL } from 'node:url';
import {
  assertStudioDirectoryIsolation,
  assertStudioTestProfile,
  closeStudioProcess,
  createIsolatedStudioDirectory,
} from '../scripts/studio-lifecycle.mjs';
import { McpClient, DIST, assert } from './lib/mcp-client.mjs';

export async function runProcessIdentityRegression({
  assertProfile = assertStudioTestProfile,
  assertIsolation = assertStudioDirectoryIsolation,
  createWorker = createIsolatedStudioDirectory,
  createClient = (options) => new McpClient('wsl-process-identity-launch', options),
  closeProcess = closeStudioProcess,
} = {}) {
  let client;
  let launchId;
  let processIdentity;
  let bodyError;
  let worker;

  try {
    assertProfile();
    assertIsolation();
    worker = await createWorker({ prefix: 'process-identity' });
    client = createClient({
      command: process.execPath,
      args: [DIST],
      startupTimeoutMs: 60000,
      env: {
        ...process.env,
        ...worker.environment,
        ROBLOXSTUDIO_MCP_MANAGED_INSTANCE_REGISTRY_DIR: worker.managedInstanceRegistryDirectory,
      },
    });
    await client.start();
    await client.initialize();

    console.log('\n=== WSL process identity launch without a working directory ===');
    const launch = await client.callTool('manage_instance', {
      action: 'launch',
      source: 'baseplate',
      require_process_identity: true,
      wait_for_connection: false,
    });

    launchId = typeof launch.launch_id === 'string' && launch.launch_id
      ? launch.launch_id
      : undefined;
    const hasExactProcessIdentity = Number.isSafeInteger(launch.pid)
      && launch.pid > 0
      && typeof launch.process_started_at_file_time === 'string'
      && /^[1-9]\d*$/u.test(launch.process_started_at_file_time);
    if (hasExactProcessIdentity) {
      processIdentity = {
        processId: launch.pid,
        startedAtFileTime: launch.process_started_at_file_time,
      };
    }

    assert(!!launchId, `identity launch returned launch_id (${JSON.stringify(launch)})`);
    assert(hasExactProcessIdentity, `identity launch returned an exact process identity (${JSON.stringify(launch)})`);
    assert(
      launch.studio_working_directory === undefined,
      'identity launch preserves the omitted studio_working_directory',
    );

    const closed = await client.callTool('manage_instance', {
      action: 'close',
      launch_id: launchId,
    });
    assert(closed.close_status === 'closed', 'the suspended Studio launch is aborted by exact identity');
    console.log('\n✅ WSL process identity launch regression PASSED');
  } catch (error) {
    bodyError = error;
  } finally {
    const cleanupErrors = [];
    if (client && launchId) {
      try {
        const closed = await client.callTool('manage_instance', {
          action: 'close',
          launch_id: launchId,
        });
        assert(['closed', 'already_closed'].includes(closed.close_status), 'managed cleanup confirms Studio is closed');
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (processIdentity) {
      try {
        await closeProcess(processIdentity);
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
    if (worker) {
      try {
        await worker.cleanup();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }

    if (bodyError && cleanupErrors.length === 0) throw bodyError;
    if (bodyError || cleanupErrors.length > 0) {
      throw new AggregateError(
        [bodyError, ...cleanupErrors].filter(Boolean),
        bodyError
          ? 'WSL process identity launch regression failed and cleanup also failed.'
          : 'WSL process identity launch regression cleanup failed.',
        bodyError ? { cause: bodyError } : undefined,
      );
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await runProcessIdentityRegression();
  } catch (error) {
    console.error(`WSL process identity launch regression FAILED: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
