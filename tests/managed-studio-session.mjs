#!/usr/bin/env node

import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { mock } from 'node:test';
import { openManagedStudioSession } from './lib/managed-studio-session.mjs';
import { McpClient } from './lib/mcp-client.mjs';

const PORT = 43123;
const PLACE_PATH = '/tmp/rsmcp-runner-unit/RunnerBaseplate.rbxl';

function harness(handleTool, { startError, createError, profileError, isolationError, stageError } = {}) {
  let controlEnv;
  let profileVerified = false;
  let isolationVerified = false;
  const closedLaunches = [];
  const closedProcesses = [];
  const resources = { controls: 0, places: 0, stops: 0 };
  const adapters = {
    async assertTestProfile() {
      if (profileError) throw profileError;
      profileVerified = true;
    },
    async assertDirectoryIsolation() {
      assert(profileVerified, 'the dedicated profile must be checked before its settings');
      if (isolationError) throw isolationError;
      isolationVerified = true;
    },
    async configureDirectoryIsolation() {
      assert.fail('routine startup/cleanup must never rewrite GlobalSettings');
    },
    createControl(env) {
      assert(profileVerified && isolationVerified, 'unsafe profiles must not start a control process');
      controlEnv = env;
      if (createError) throw createError;
      return {
        async start() {
          resources.controls++;
          if (startError) throw startError;
        },
        async stop() {
          resources.controls--;
          resources.stops++;
        },
      };
    },
    async stagePlace() {
      if (stageError) throw stageError;
      resources.places++;
      return {
        path: PLACE_PATH,
        async cleanup() { resources.places--; },
      };
    },
    async closeProcessIdentity(identity) { closedProcesses.push(identity); },
    async delay(milliseconds) { mock.timers.tick(milliseconds); },
    async callTool(name, args, options) {
      assert(profileVerified && isolationVerified, 'unsafe profiles must not launch Studio');
      assert.equal(name, 'manage_instance');
      assert.equal(options.env.ROBLOXSTUDIO_MCP_MANAGED_INSTANCE_REGISTRY_DIR,
        controlEnv.ROBLOXSTUDIO_MCP_MANAGED_INSTANCE_REGISTRY_DIR);
      assert.equal(options.env.ROBLOX_STUDIO_AUTH_TOKEN, controlEnv.ROBLOX_STUDIO_AUTH_TOKEN);
      if (args.action === 'close') closedLaunches.push(args.launch_id);
      if (handleTool) return handleTool(args, options);
      if (args.action === 'status' && !args.launch_id) return { managed: [] };
      if (args.action === 'launch') return { launch_id: 'launch-owned' };
      if (args.action === 'authorize') return { process_authorized: true };
      if (args.action === 'complete') return { process_ownership_released: true };
      if (args.action === 'status') {
        return { instance_id: 'anon:managed', connected: true, roles: ['edit'] };
      }
      return { close_status: 'closed' };
    },
  };
  return {
    adapters, resources, closedLaunches, closedProcesses,
    get controlEnv() { return controlEnv; },
    assertReleased() {
      assert.equal(resources.controls, 0, 'no control process survives session cleanup');
      assert.equal(resources.places, 0, 'no staged place survives session cleanup');
      if (controlEnv) {
        assert.equal(existsSync(controlEnv.ROBLOXSTUDIO_MCP_MANAGED_INSTANCE_REGISTRY_DIR), false,
          'the session-owned registry is removed after startup failure or close');
      }
    },
  };
}

mock.timers.enable({ apis: ['Date'] });
try {
  {
    const runtimeEnv = Object.freeze({ ROBLOX_STUDIO_AUTH_TOKEN: 'caller-token' });
    const forbidden = () => assert.fail('caller-owned sessions do not need lifecycle operations');
    const session = await openManagedStudioSession(
      { port: PORT, existingInstanceId: 'anon:existing', env: runtimeEnv },
      {
        assertTestProfile: forbidden,
        assertDirectoryIsolation: forbidden,
        createRegistry: forbidden,
        createControl: forbidden,
        callTool: forbidden,
      },
    );
    assert.equal(session.instanceId, 'anon:existing');
    assert.equal(session.managed, false);
    assert.equal(session.env, runtimeEnv);
    await session.close();
    await session.close();
  }

  {
    const runtimeEnv = Object.freeze({
      ROBLOX_STUDIO_AUTH_TOKEN: 'previous-token',
      ROBLOX_STUDIO_NO_AUTH: '1',
      ROBLOX_STUDIO_PORT: '12345',
      ROBLOX_STUDIO_REQUIRE_PRIMARY: 'caller-value',
      RSMCP_AUTO_ASSIGNED_PORT: '1',
      MCP_INSTANCE_ID: 'stale-instance',
      UNRELATED: 'preserved',
      RSMCP_STUDIO_WORKING_DIRECTORY: '/tmp/rsmcp-worker-unit',
    });
    const runs = [harness(), harness()];
    const sessions = await Promise.all(runs.map((run, index) => openManagedStudioSession(
      { port: PORT + index, env: runtimeEnv }, run.adapters,
    )));
    try {
      assert.notEqual(sessions[0].env.ROBLOX_STUDIO_AUTH_TOKEN, sessions[1].env.ROBLOX_STUDIO_AUTH_TOKEN);
      assert.notEqual(sessions[0].managedInstanceRegistryDirectory, sessions[1].managedInstanceRegistryDirectory);
      for (const [index, session] of sessions.entries()) {
        assert.equal(session.env.ROBLOX_STUDIO_PORT, String(PORT + index));
        assert.equal(session.env.ROBLOX_STUDIO_NO_AUTH, '0');
        assert.equal(session.env.ROBLOX_STUDIO_REQUIRE_PRIMARY, '0');
        assert.equal(session.env.MCP_INSTANCE_ID, '');
        assert.equal(session.env.UNRELATED, 'preserved');
        assert.equal(existsSync(session.managedInstanceRegistryDirectory), true);
        assert.equal(runs[index].controlEnv.ROBLOX_STUDIO_REQUIRE_PRIMARY, '1');
        assert.equal(session.env.ROBLOX_STUDIO_AUTH_TOKEN, runs[index].controlEnv.ROBLOX_STUDIO_AUTH_TOKEN);
      }
      await sessions[0].close();
      runs[0].assertReleased();
      assert.equal(existsSync(sessions[1].managedInstanceRegistryDirectory), true,
        'closing one session must not remove the other session registry');
      assert.equal(runs[1].resources.controls, 1, 'the sibling control remains live');
    } finally {
      await Promise.all(sessions.map((session) => session.close()));
    }
    for (const run of runs) {
      run.assertReleased();
      assert.deepEqual(run.closedLaunches, ['launch-owned'], 'close is idempotent and targets only its launch');
      assert.equal(run.resources.stops, 1);
    }
    assert.equal(runtimeEnv.ROBLOX_STUDIO_AUTH_TOKEN, 'previous-token');
  }

  {
    const ambientFlags = {
      ROBLOX_STUDIO_NO_AUTH: '1',
      ROBLOX_STUDIO_REQUIRE_PRIMARY: '1',
      MCP_INSTANCE_ID: 'ambient-instance',
    };
    const originalFlags = new Map(Object.keys(ambientFlags).map((key) => [key, process.env[key]]));
    const run = harness();
    const session = await openManagedStudioSession({ port: PORT, env: {} }, run.adapters);
    Object.assign(process.env, ambientFlags);
    try {
      for (const [env, primary] of [[session.env, '0'], [run.controlEnv, '1']]) {
        const keys = [...Object.keys(ambientFlags), 'ROBLOX_STUDIO_AUTH_TOKEN',
          'ROBLOXSTUDIO_MCP_MANAGED_INSTANCE_REGISTRY_DIR'];
        const child = new McpClient('session-env-fixture', {
          command: process.execPath,
          args: ['-e', `console.error(JSON.stringify(Object.fromEntries(${JSON.stringify(keys)}.map(key => [key, process.env[key]]))));`],
          env,
        });
        // Exercise the real spawn/environment merge without readiness polling or timers.
        child._waitForLog = () => once(child.proc, 'close');
        await child.start();
        assert.equal(child.exitCode, 0);
        const observed = JSON.parse(child.stderrLines.join('\\n'));
        assert.equal(observed.ROBLOX_STUDIO_NO_AUTH, '0', 'ambient no-auth cannot disable session authentication');
        assert.equal(observed.ROBLOX_STUDIO_REQUIRE_PRIMARY, primary, 'children may proxy while the control requires primary');
        assert.equal(observed.MCP_INSTANCE_ID, '', 'ambient instance selection cannot escape this session');
        assert.equal(observed.ROBLOX_STUDIO_AUTH_TOKEN, session.env.ROBLOX_STUDIO_AUTH_TOKEN);
        assert.equal(observed.ROBLOXSTUDIO_MCP_MANAGED_INSTANCE_REGISTRY_DIR, session.managedInstanceRegistryDirectory);
      }
    } finally {
      for (const [key, value] of originalFlags) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await session.close();
    }
    run.assertReleased();
  }

  {
    const runtimeEnv = { ROBLOXSTUDIO_MCP_MANAGED_INSTANCE_REGISTRY_DIR: '/caller/worker/registry' };
    const run = harness();
    run.adapters.createRegistry = () => assert.fail('a supplied worker registry must be retained');
    const session = await openManagedStudioSession({ port: PORT, env: runtimeEnv }, run.adapters);
    assert.equal(session.managedInstanceRegistryDirectory, runtimeEnv.ROBLOXSTUDIO_MCP_MANAGED_INSTANCE_REGISTRY_DIR);
    await session.close();
    assert.equal(runtimeEnv.ROBLOXSTUDIO_MCP_MANAGED_INSTANCE_REGISTRY_DIR, '/caller/worker/registry');
  }

  {
    const placePaths = [];
    const runs = [harness(), harness()];
    for (const run of runs) {
      delete run.adapters.stagePlace;
      const callTool = run.adapters.callTool;
      run.adapters.callTool = (name, args, options) => {
        if (args.action === 'launch') placePaths.push(args.local_place_file);
        return callTool(name, args, options);
      };
    }
    const sessions = await Promise.all(runs.map((run) => openManagedStudioSession(
      { port: PORT, env: {} }, run.adapters,
    )));
    try {
      assert.notEqual(path.basename(placePaths[0]), path.basename(placePaths[1]),
        'Studio filename matching cannot conflate the two staged baseplates');
      assert(placePaths.every((placePath) => existsSync(placePath)));
    } finally {
      await Promise.all(sessions.map((session) => session.close()));
    }
    assert(placePaths.every((placePath) => !existsSync(placePath)));
    for (const run of runs) run.assertReleased();
  }

  for (const failure of ['profileError', 'isolationError', 'createError', 'startError', 'stageError']) {
    const run = harness(undefined, { [failure]: new Error(`failed ${failure}`) });
    const runtimeEnv = Object.freeze({ ROBLOX_STUDIO_NO_AUTH: 'true' });
    await assert.rejects(
      openManagedStudioSession({ port: PORT, env: runtimeEnv }, run.adapters),
      new RegExp(`failed ${failure}`),
    );
    assert.deepEqual(run.closedLaunches, [], 'pre-launch failure cannot close unrelated Studio');
    if (failure === 'profileError' || failure === 'isolationError') {
      assert.equal(run.controlEnv, undefined, 'unsafe profiles fail before control allocation');
    }
    run.assertReleased();
  }

  {
    const run = harness();
    run.adapters.createRegistry = () => { throw new Error('registry allocation failed'); };
    await assert.rejects(openManagedStudioSession({ port: PORT, env: {} }, run.adapters), /registry allocation failed/);
    assert.equal(run.controlEnv, undefined);
    run.assertReleased();
  }

  for (const responseLost of [true, false]) {
    let statusCalls = 0;
    const run = harness(async (args) => {
      if (args.action === 'status') {
        statusCalls++;
        return { managed: [
          { launch_id: 'prior-launch', local_place_file: PLACE_PATH },
          { launch_id: 'other-place', local_place_file: '/tmp/unrelated.rbxl' },
          ...(statusCalls > 1 ? [{ launch_id: 'recovered-launch', local_place_file: PLACE_PATH }] : []),
        ] };
      }
      if (args.action === 'launch') {
        if (responseLost) throw new Error('launch response was lost');
        return {};
      }
      return { close_status: 'closed' };
    });
    await assert.rejects(
      openManagedStudioSession({ port: PORT, env: {} }, run.adapters),
      responseLost ? /launch response was lost/ : /launch_id/,
    );
    assert.deepEqual(run.closedLaunches, ['recovered-launch'], 'recovery closes only new launches of this staged place');
    run.assertReleased();
  }

  {
    const run = harness(async (args) => {
      if (args.action === 'status') return { managed: [] };
      if (args.action === 'launch') return { pid: 7234, process_started_at_file_time: '133700123457' };
      throw new Error(`unexpected action ${args.action}`);
    });
    await assert.rejects(openManagedStudioSession({ port: PORT, env: {} }, run.adapters), /launch_id/);
    assert.deepEqual(run.closedProcesses, [{ processId: 7234, startedAtFileTime: '133700123457' }],
      'a malformed launch response must still close the exact process identity');
    run.assertReleased();
  }

  {
    const run = harness(async (args) => {
      if (args.action === 'status' && !args.launch_id) return { managed: [] };
      if (args.action === 'launch') {
        return { launch_id: 'launch-close-check', pid: 7123, process_started_at_file_time: '133700123456' };
      }
      if (args.action === 'authorize') return { process_authorized: true };
      if (args.action === 'complete') return { process_ownership_released: true };
      if (args.action === 'status') return { instance_id: 'anon:close-check', connected: true, roles: ['edit'] };
      return { state: 'exited' };
    });
    const session = await openManagedStudioSession({ port: PORT, env: {} }, run.adapters);
    await assert.rejects(session.close(), /did not confirm.*was closed/);
    assert.deepEqual(run.closedProcesses, [{ processId: 7123, startedAtFileTime: '133700123456' }]);
    run.assertReleased();
  }

  {
    const statusTimeouts = [];
    const run = harness(async (args, options) => {
      if (args.action === 'status' && !args.launch_id) return { managed: [] };
      if (args.action === 'launch') return { launch_id: 'launch-deadline' };
      if (args.action === 'authorize') return { process_authorized: true };
      if (args.action === 'complete') return { process_ownership_released: true };
      if (args.action === 'status') {
        statusTimeouts.push(options.timeoutMs);
        return { launch_id: 'launch-deadline', state: 'launching', connected: false, roles: [] };
      }
      return { close_status: 'closed' };
    });
    const startedAt = Date.now();
    await assert.rejects(
      openManagedStudioSession({ port: PORT, env: {}, launchTimeoutMs: 25 }, run.adapters),
      /did not establish an edit connection within 25ms/,
    );
    assert.equal(Date.now() - startedAt, 25, 'cleanup starts when the connection deadline expires');
    assert.deepEqual(statusTimeouts, [25]);
    assert.deepEqual(run.closedLaunches, ['launch-deadline']);
    run.assertReleased();
  }

  {
    const run = harness();
    const callTool = run.adapters.callTool;
    run.adapters.callTool = async (name, args, options) => {
      const result = await callTool(name, args, options);
      if (args.action === 'launch') {
        return { ...result, pid: 7123, process_started_at_file_time: '133700123456' };
      }
      if (args.action === 'close') throw new Error('managed close failed');
      return result;
    };
    run.adapters.closeProcessIdentity = async () => { throw new Error('exact close failed'); };
    const session = await openManagedStudioSession({ port: PORT, env: {} }, run.adapters);
    try {
      await assert.rejects(session.close(), (error) => {
        assert.equal(error.retainedStudioResources, true);
        assert(error.message.includes(session.managedInstanceRegistryDirectory));
        return true;
      });
      assert.equal(existsSync(session.managedInstanceRegistryDirectory), true,
        'failed close retains the durable launch registry for recovery');
      assert.equal(run.resources.places, 1, 'failed close preserves the staged place');
      assert.equal(run.resources.controls, 0, 'retention does not leak the control process');
    } finally {
      rmSync(session.managedInstanceRegistryDirectory, { recursive: true, force: true });
    }
  }
} finally {
  mock.timers.reset();
}

console.log('managed Studio session passed');
