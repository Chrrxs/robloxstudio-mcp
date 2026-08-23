#!/usr/bin/env node

import assert from 'node:assert/strict';
import { openManagedStudioSession } from './lib/managed-studio-session.mjs';

const PORT = 43123;
const PLACE_PATH = '/tmp/rsmcp-runner-unit/RunnerBaseplate.rbxl';

function harness(handleTool, { startError } = {}) {
  const events = [];
  let controlEnv;
  const adapters = {
    createControl(env) {
      controlEnv = env;
      events.push('control:create');
      return {
        async start() {
          events.push('control:start');
          if (startError) throw startError;
        },
        async stop() {
          events.push('control:stop');
        },
      };
    },
    async stagePlace() {
      events.push('place:stage');
      return {
        path: PLACE_PATH,
        async cleanup() {
          events.push('place:cleanup');
        },
      };
    },
    async configureDirectoryIsolation() {
      events.push('isolation:configure');
    },
    async delay() {
      events.push('delay');
    },
    async callTool(name, args, options) {
      assert.equal(name, 'manage_instance');
      assert.equal(options.port, PORT);
      assert.equal(options.env, controlEnv);
      assert.match(options.env.ROBLOX_STUDIO_AUTH_TOKEN, /^[a-f0-9]{64}$/);
      return handleTool(args, options, events);
    },
  };
  return {
    adapters,
    events,
    get controlEnv() {
      return controlEnv;
    },
  };
}

{
  let adapterTouched = false;
  const runtimeEnv = { ROBLOX_STUDIO_AUTH_TOKEN: 'caller-token' };
  const session = await openManagedStudioSession(
    {
      port: PORT,
      existingInstanceId: 'anon:existing',
      env: runtimeEnv,
    },
    {
      createControl() {
        adapterTouched = true;
        throw new Error('existing instances do not need a control process');
      },
      async callTool() {
        adapterTouched = true;
        throw new Error('existing instances do not need an HTTP launch');
      },
    },
  );

  assert.equal(session.instanceId, 'anon:existing');
  assert.equal(session.managed, false);
  await session.close();
  await session.close();
  assert.equal(adapterTouched, false, 'an explicitly supplied instance is reused without lifecycle calls');
  assert.deepEqual(runtimeEnv, { ROBLOX_STUDIO_AUTH_TOKEN: 'caller-token' });
}

{
  const runtimeEnv = {
    ROBLOX_STUDIO_AUTH_TOKEN: 'previous-token',
    ROBLOX_STUDIO_NO_AUTH: '1',
    ROBLOX_STUDIO_PORT: '12345',
    ROBLOX_STUDIO_REQUIRE_PRIMARY: 'caller-value',
    RSMCP_AUTO_ASSIGNED_PORT: '1',
    UNRELATED: 'preserved',
    RSMCP_STUDIO_WORKING_DIRECTORY: '/tmp/rsmcp-worker-unit',
  };
  const originalEnv = { ...runtimeEnv };
  const run = harness(async (args, options, events) => {
    if (args.action === 'status' && !args.launch_id) {
      events.push('tool:baseline');
      return {
        managed: [{ launch_id: 'existing-launch', local_place_file: '/tmp/other.rbxl' }],
      };
    }
    if (args.action === 'launch') {
      events.push('tool:launch');
      assert.deepEqual(args, {
        action: 'launch',
        source: 'local_file',
        local_place_file: PLACE_PATH,
        require_process_identity: true,
        timeout_ms: 120000,
        studio_working_directory: '/tmp/rsmcp-worker-unit',
      });
      assert.equal(options.timeoutMs, 30000);
      return { launch_id: 'launch-1', process_authorized: false };
    }
    if (args.action === 'authorize') {
      events.push('tool:authorize');
      assert.deepEqual(args, { action: 'authorize', launch_id: 'launch-1' });
      return { launch_id: 'launch-1', process_authorized: true };
    }
    if (args.action === 'complete') {
      events.push('tool:complete');
      assert.deepEqual(args, { action: 'complete', launch_id: 'launch-1' });
      return { launch_id: 'launch-1', process_ownership_released: true };
    }
    if (args.action === 'status') {
      events.push('tool:connection');
      assert.deepEqual(args, { action: 'status', launch_id: 'launch-1' });
      return {
        launch_id: 'launch-1',
        instance_id: 'anon:managed',
        connected: true,
        roles: ['edit'],
        state: 'connected',
      };
    }
    events.push('tool:close');
    assert.deepEqual(args, { action: 'close', launch_id: 'launch-1' });
    return { close_status: 'closed', state: 'exited' };
  });

  const session = await openManagedStudioSession(
    { port: PORT, env: runtimeEnv },
    run.adapters,
  );
  assert.equal(session.instanceId, 'anon:managed');
  assert.equal(session.managed, true);
  assert.equal(session.studioWorkingDirectory, '/tmp/rsmcp-worker-unit');
  assert.match(runtimeEnv.ROBLOX_STUDIO_AUTH_TOKEN, /^[a-f0-9]{64}$/);
  assert.notEqual(runtimeEnv.ROBLOX_STUDIO_AUTH_TOKEN, 'previous-token');
  assert.equal(runtimeEnv.ROBLOX_STUDIO_PORT, String(PORT));
  assert.equal(runtimeEnv.RSMCP_AUTO_ASSIGNED_PORT, '0');
  assert.equal(runtimeEnv.ROBLOX_STUDIO_NO_AUTH, undefined);
  assert.equal(runtimeEnv.ROBLOX_STUDIO_REQUIRE_PRIMARY, undefined);
  assert.equal(run.controlEnv.ROBLOX_STUDIO_REQUIRE_PRIMARY, '1');
  assert.equal(run.controlEnv.RSMCP_AUTO_ASSIGNED_PORT, '0');
  assert.equal(run.controlEnv.ROBLOX_STUDIO_AUTH_TOKEN, runtimeEnv.ROBLOX_STUDIO_AUTH_TOKEN);

  await session.close();
  await session.close();
  assert.deepEqual(runtimeEnv, originalEnv);
  assert.deepEqual(run.events, [
    'control:create',
    'control:start',
    'place:stage',
    'tool:baseline',
    'isolation:configure',
    'tool:launch',
    'tool:authorize',
    'tool:complete',
    'tool:connection',
    'tool:close',
    'control:stop',
    'isolation:configure',
    'place:cleanup',
  ]);
}

{
  const runtimeEnv = {};
  let statusCalls = 0;
  const run = harness(async (args, _options, events) => {
    if (args.action === 'status') {
      statusCalls++;
      events.push(statusCalls === 1 ? 'tool:baseline' : 'tool:reconcile');
      return statusCalls === 1
        ? { managed: [] }
        : {
          managed: [{
            launch_id: 'recovered-launch',
            local_place_file: PLACE_PATH,
          }],
        };
    }
    if (args.action === 'launch') {
      events.push('tool:launch');
      throw new Error('launch response was lost');
    }
    events.push('tool:close-recovered');
    assert.deepEqual(args, { action: 'close', launch_id: 'recovered-launch' });
    return { close_status: 'closed' };
  });

  await assert.rejects(
    openManagedStudioSession({ port: PORT, env: runtimeEnv }, run.adapters),
    /launch response was lost/,
  );
  assert.deepEqual(runtimeEnv, {});
  assert.deepEqual(run.events, [
    'control:create',
    'control:start',
    'place:stage',
    'tool:baseline',
    'tool:launch',
    'tool:reconcile',
    'tool:close-recovered',
    'control:stop',
    'place:cleanup',
  ]);
}

{
  const runtimeEnv = {};
  let statusCalls = 0;
  const run = harness(async (args, _options, events) => {
    if (args.action === 'status') {
      statusCalls++;
      events.push(statusCalls === 1 ? 'tool:baseline' : 'tool:reconcile');
      return statusCalls === 1
        ? { managed: [] }
        : { managed: [{ launch_id: 'orphan-launch', local_place_file: PLACE_PATH }] };
    }
    if (args.action === 'launch') {
      events.push('tool:launch');
      return {};
    }
    events.push('tool:close-orphan');
    assert.deepEqual(args, { action: 'close', launch_id: 'orphan-launch' });
    return { close_status: 'already_closed' };
  });

  await assert.rejects(
    openManagedStudioSession({ port: PORT, env: runtimeEnv }, run.adapters),
    /launch_id/,
  );
  assert.deepEqual(run.events, [
    'control:create',
    'control:start',
    'place:stage',
    'tool:baseline',
    'tool:launch',
    'tool:reconcile',
    'tool:close-orphan',
    'control:stop',
    'place:cleanup',
  ]);
}

{
  const runtimeEnv = {};
  let statusCalls = 0;
  const run = harness(async (args, _options, events) => {
    if (args.action === 'status') {
      statusCalls += 1;
      events.push(statusCalls === 1 ? 'tool:baseline' : 'tool:reconcile');
      return { managed: [] };
    }
    if (args.action === 'launch') {
      events.push('tool:launch');
      return {
        pid: 7234,
        process_started_at_file_time: '133700123457',
      };
    }
    throw new Error(`unexpected action ${args.action}`);
  });
  run.adapters.closeProcessIdentity = async (identity) => {
    assert.deepEqual(identity, {
      processId: 7234,
      startedAtFileTime: '133700123457',
    });
    run.events.push('process:close-exact');
  };

  await assert.rejects(
    openManagedStudioSession({ port: PORT, env: runtimeEnv }, run.adapters),
    /launch_id/,
  );
  assert.deepEqual(run.events, [
    'control:create',
    'control:start',
    'place:stage',
    'tool:baseline',
    'tool:launch',
    'tool:reconcile',
    'process:close-exact',
    'control:stop',
    'place:cleanup',
  ]);
}

{
  const runtimeEnv = {};
  const run = harness(async (args, _options, events) => {
    events.push(`tool:${args.action}`);
    if (args.action === 'status' && !args.launch_id) return { managed: [] };
    if (args.action === 'launch') {
      return {
        launch_id: 'launch-close-check',
        pid: 7123,
        process_started_at_file_time: '133700123456',
      };
    }
    if (args.action === 'authorize') return { process_authorized: true };
    if (args.action === 'complete') return { process_ownership_released: true };
    if (args.action === 'status') {
      return {
        instance_id: 'anon:close-check',
        connected: true,
        roles: ['edit'],
      };
    }
    return { state: 'exited' };
  });
  run.adapters.closeProcessIdentity = async (identity) => {
    assert.deepEqual(identity, {
      processId: 7123,
      startedAtFileTime: '133700123456',
    });
    run.events.push('process:close-exact');
  };
  const session = await openManagedStudioSession(
    { port: PORT, env: runtimeEnv },
    run.adapters,
  );
  await assert.rejects(session.close(), /did not confirm.*was closed/);
  assert.deepEqual(runtimeEnv, {});
  assert.deepEqual(run.events.slice(-4), ['tool:close', 'process:close-exact', 'control:stop', 'place:cleanup']);
}

{
  const runtimeEnv = {};
  const statusTimeouts = [];
  const run = harness(async (args, options, events) => {
    events.push(`tool:${args.action}`);
    if (args.action === 'status' && !args.launch_id) return { managed: [] };
    if (args.action === 'launch') {
      assert.equal(args.timeout_ms, 25);
      return { launch_id: 'launch-deadline' };
    }
    if (args.action === 'authorize') return { process_authorized: true };
    if (args.action === 'complete') return { process_ownership_released: true };
    if (args.action === 'status') {
      statusTimeouts.push(options.timeoutMs);
      return { launch_id: 'launch-deadline', state: 'launching', connected: false, roles: [] };
    }
    return { close_status: 'closed' };
  });
  run.adapters.delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

  const startedAt = Date.now();
  await assert.rejects(
    openManagedStudioSession(
      { port: PORT, env: runtimeEnv, launchTimeoutMs: 25 },
      run.adapters,
    ),
    /did not establish an edit connection within 25ms/,
  );
  assert(Date.now() - startedAt < 1000, 'connection timeout initiates cleanup near its wall-clock deadline');
  assert(statusTimeouts.length > 0);
  assert(statusTimeouts.every((timeoutMs) => timeoutMs > 0 && timeoutMs <= 25));
  assert.deepEqual(runtimeEnv, {});
  assert.deepEqual(run.events.slice(-3), ['tool:close', 'control:stop', 'place:cleanup']);
}

{
  const runtimeEnv = { ROBLOX_STUDIO_NO_AUTH: 'true' };
  const run = harness(
    async () => {
      throw new Error('tool should not be called');
    },
    { startError: new Error('primary port is already owned') },
  );
  await assert.rejects(
    openManagedStudioSession({ port: PORT, env: runtimeEnv }, run.adapters),
    /primary port is already owned/,
  );
  assert.deepEqual(run.events, ['control:create', 'control:start', 'control:stop']);
  assert.deepEqual(runtimeEnv, { ROBLOX_STUDIO_NO_AUTH: 'true' });
}

console.log('managed Studio session passed');
