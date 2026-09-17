#!/usr/bin/env node

import assert from 'node:assert/strict';
import { runProcessIdentityRegression } from './wsl-process-identity-launch.mjs';

function fixture({ unknownLaunch = false, closeFails = false, startFails = false, drainFails = false } = {}) {
  const events = [];
  const adapters = {
    assertProfile() { events.push('profile'); },
    assertIsolation() { events.push('settings'); },
    async createWorker() {
      events.push('worker');
      return {
        workingDirectory: '/fixture/worker',
        managedInstanceRegistryDirectory: '/fixture/worker/registry',
        environment: { RSMCP_STUDIO_TEST_WORKER_JOB: 'Local\\RsmcpStudioWorker-0123456789abcdef0123456789abcdef' },
        async cleanup() {
          events.push('cleanup');
          if (drainFails) throw new Error('job drain failed; retained worker');
        },
      };
    },
    createClient(options) {
      assert.equal(options.env.ROBLOXSTUDIO_MCP_MANAGED_INSTANCE_REGISTRY_DIR, '/fixture/worker/registry');
      assert.equal(options.env.RSMCP_STUDIO_TEST_WORKER_JOB, 'Local\\RsmcpStudioWorker-0123456789abcdef0123456789abcdef');
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
assert.equal(unknown.events.at(-1), 'cleanup', 'Unknown launch still drains the independently retained worker job');

const unclosed = fixture({ closeFails: true });
await assert.rejects(runProcessIdentityRegression(unclosed.adapters), AggregateError);
assert.equal(unclosed.events.at(-1), 'cleanup', 'Root-close failure must not skip worker lifetime drain');

const failedStart = fixture({ startFails: true });
await assert.rejects(runProcessIdentityRegression(failedStart.adapters), /start failed/);
assert.equal(failedStart.events.at(-1), 'cleanup', 'pre-launch startup failure can remove its worker');

const undrained = fixture({ drainFails: true });
await assert.rejects(runProcessIdentityRegression(undrained.adapters), AggregateError);
assert.equal(undrained.events.at(-1), 'cleanup');

console.log('Process identity ownership fixtures passed');
