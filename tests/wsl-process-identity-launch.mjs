#!/usr/bin/env node

import { closeStudioProcess } from '../scripts/studio-lifecycle.mjs';
import { McpClient, DIST, assert } from './lib/mcp-client.mjs';

async function main() {
  let client;
  let launchId;
  let processIdentity;
  let bodyError;

  try {
    client = new McpClient('wsl-process-identity-launch', {
      command: 'node',
      args: [DIST],
      startupTimeoutMs: 60000,
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
        await client.callTool('manage_instance', {
          action: 'close',
          launch_id: launchId,
        });
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (processIdentity) {
      try {
        await closeStudioProcess(processIdentity);
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

try {
  await main();
} catch (error) {
  console.error(`\n❌ WSL process identity launch regression FAILED: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exitCode = 1;
}
