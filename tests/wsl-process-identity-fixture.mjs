#!/usr/bin/env node

import assert from 'node:assert/strict';
import { runProcessIdentityRegression } from './wsl-process-identity-launch.mjs';

function fixture({ unknownLaunch = false, closeFails = false, startFails = false } = {}) {
  const events = [];
  const adapters = {
    assertProfile() { events.push('profile'); },
    assertIsolation() { events.push('settings'); },
    createWorker() {
      events.push('worker');
      return {
        workingDirectory: '/fixture/worker',
        managedInstanceRegistryDirectory: '/fixture/worker/registry',
        cleanup() { events.push('cleanup'); },
      };
    },
    createClient(options) {
      assert.equal(options.env.ROBLOXSTUDIO_MCP_MANAGED_INSTANCE_REGISTRY_DIR, '/fixture/worker/registry');
      return {
        async start() {
          if (startFails) throw new Error('start failed');
        },
        async initialize() {},
        async callTool(name, args) {
          assert.equal(name, 'manage_instance');
          if (args.action === 'launch') {
            events.push('launch');
            assert.equal(args.studio_working_directory, undefined);
            if (unknownLaunch) throw new Error('unknown launch outcome');
            return { launch_id: 'owned', pid: 123, process_started_at_file_time: '456' };
          }
          assert.equal(args.launch_id, 'owned');
          events.push('close');
          if (closeFails) throw new Error('close failed');
          return { close_status: 'closed' };
        },
        async stop() { events.push('stop'); },
      };
    },
    async closeProcess(identity) {
      assert.deepEqual(identity, { processId: 123, startedAtFileTime: '456' });
      events.push('exact-close');
      if (closeFails) throw new Error('exact close failed');
    },
  };
  return { adapters, events };
}

const successful = fixture();
await runProcessIdentityRegression(successful.adapters);
assert.equal(successful.events.at(-1), 'cleanup');

const unknown = fixture({ unknownLaunch: true });
await assert.rejects(runProcessIdentityRegression(unknown.adapters), /unknown launch outcome/);
assert.ok(unknown.events.includes('stop'));
assert.ok(!unknown.events.includes('cleanup'), 'unknown launch retains its private registry');

const unclosed = fixture({ closeFails: true });
await assert.rejects(runProcessIdentityRegression(unclosed.adapters), AggregateError);
assert.ok(!unclosed.events.includes('cleanup'), 'failed managed and exact close retain recovery files');

const failedStart = fixture({ startFails: true });
await assert.rejects(runProcessIdentityRegression(failedStart.adapters), /start failed/);
assert.equal(failedStart.events.at(-1), 'cleanup', 'pre-launch startup failure can remove its worker');

console.log('Process identity ownership fixtures passed');
