#!/usr/bin/env node

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { executeReleaseStage, runRelease } from './run-release.mjs';
import {
  assertFunctionalArtifactSource,
  runFunctionalInMatchingSession,
  validatePreparedArtifacts,
} from './lib/installer-session.mjs';

const expectedCommands = [
  ['tests/run-with-test-port.mjs', 'tests/auto-install-plugin-e2e.mjs', '--with-functional'],
  ['tests/run-with-test-port.mjs', 'tests/wsl-process-identity-launch.mjs'],
  ['tests/run-with-test-port.mjs', 'tests/studio-lifecycle-regressions.mjs'],
  ['tests/parallel-studio-isolation-smoke.mjs'],
];

{
  const calls = [];
  const env = { RSMCP_STUDIO_TEST_PREPARED: '1', RSMCP_STUDIO_TEST_PROFILE: 'release-profile' };
  const result = await runRelease({
    env,
    log: () => {},
    async execute(command, args, options) {
      assert.equal(command, process.execPath);
      assert.equal(options.env, env, 'all stages stay within the supplied profile environment');
      calls.push(args);
      return { code: 0 };
    },
  });
  assert.equal(result.code, 0);
  assert.deepEqual(calls, expectedCommands, 'the full gate preserves order without nested profile/npm wrappers or a second functional launch');
  assert.deepEqual(result.skipped, []);
}

for (const failure of [
  { code: 7 },
  { code: 0, signal: 'SIGTERM' },
  { code: null, spawnError: new Error('spawn ENOENT') },
  new Error('synchronous spawn failure'),
]) {
  const calls = [];
  const lines = [];
  const result = await runRelease({
    log: (line) => lines.push(line),
    async execute(_command, args) {
      calls.push(args);
      if (calls.length === 1) return { code: 0 };
      if (failure instanceof Error) throw failure;
      return failure;
    },
  });
  assert.equal(result.code, 1);
  assert.deepEqual(calls, expectedCommands.slice(0, 2), 'failure is not retried and remaining phases never start');
  assert.equal(result.results[0].code, 0);
  assert.notEqual(result.results[1].code, 0);
  assert.deepEqual(result.skipped.map((stage) => stage.args), expectedCommands.slice(2));
  assert(lines.some((line) => line.includes('NOT RUN  lifecycle regressions')));
  assert(lines.some((line) => line.includes('NOT RUN  parallel Studio isolation')));
}

{
  const controller = new AbortController();
  let calls = 0;
  const result = await runRelease({
    signal: controller.signal,
    log: () => {},
    async execute() {
      calls++;
      controller.abort(new Error('parent interrupted'));
      return { code: 0 };
    },
  });
  assert.equal(result.code, 1, 'a parent signal cannot be mistaken for child success');
  assert.equal(calls, 1);
  assert.equal(result.skipped.length, 3);
}

{
  const child = new EventEmitter();
  let settled = false;
  const completion = executeReleaseStage('node', ['fixture'], {
    spawnImpl: () => child,
  }).then((result) => { settled = true; return result; });
  child.emit('exit', 0, null);
  await Promise.resolve();
  assert.equal(settled, false, 'exit alone does not skip output draining');
  child.emit('close', 0, null);
  assert.deepEqual(await completion, { code: 0, signal: null, spawnError: undefined });
}

{
  const child = new EventEmitter();
  const spawnError = new Error('ENOENT');
  const completion = executeReleaseStage('missing', [], { spawnImpl: () => child });
  child.emit('error', spawnError);
  child.emit('close', -2, null);
  assert.equal((await completion).spawnError, spawnError);
  assert.equal((await executeReleaseStage('missing', [], {
    spawnImpl() { throw spawnError; },
  })).spawnError, spawnError);
}

{
  assert.doesNotThrow(() => assertFunctionalArtifactSource('local'));
  assert.throws(() => assertFunctionalArtifactSource('latest'), /requires current local-pack/);
  const env = {
    ROBLOX_STUDIO_PORT: '59999',
    ROBLOX_STUDIO_AUTH_TOKEN: 'fixture-auth-token',
    RSMCP_STUDIO_TEST_PREPARED: '1',
    RSMCP_STUDIO_DIRECTORY_ISOLATED: '1',
    RSMCP_AUTO_ASSIGNED_PORT: '1',
    ROBLOX_STUDIO_REQUIRE_PRIMARY: '1',
    ROBLOX_STUDIO_NO_AUTH: '1',
  };
  const client = {
    cwd: '/fixture/worktree',
    env: {
      ROBLOX_STUDIO_AUTH_TOKEN: 'owning-primary-auth-token',
      ROBLOX_STUDIO_NO_AUTH: '0',
      MCP_PLUGINS_DIR: '/fixture/plugins',
      RSMCP_STUDIO_WORKING_DIRECTORY: '/fixture/studio',
      ROBLOXSTUDIO_MCP_MANAGED_INSTANCE_REGISTRY_DIR: '/fixture/registry',
    },
    stop() { throw new Error('borrower must not close the owning MCP client'); },
  };
  const artifact = { source: 'local-pack', variant: 'main' };
  const calls = [];
  const options = {
    artifact,
    instanceId: 'matching-instance-exact',
    client,
    env,
    async execute(command, args, execution) { calls.push({ command, args, execution }); },
  };
  await runFunctionalInMatchingSession(options);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, process.execPath);
  assert.deepEqual(calls[0].args, ['tests/run-all.mjs'], 'borrowed runner must not use --managed');
  assert.deepEqual(calls[0].execution.env, {
    ...env,
    ...client.env,
    MCP_INSTANCE_ID: options.instanceId,
    RSMCP_AUTO_ASSIGNED_PORT: '0',
    ROBLOX_STUDIO_REQUIRE_PRIMARY: '0',
  }, 'borrowed processes keep the primary token and port, but never attempt primary ownership');
  assert.equal(calls[0].execution.cwd, client.cwd);
  assert(calls[0].execution.timeoutMs >= 10 * 60 * 1000 && calls[0].execution.timeoutMs <= 60 * 60 * 1000);
  assert.equal(calls[0].execution.forwardOutput, true);
  const failure = new Error('functional suite failed');
  await assert.rejects(runFunctionalInMatchingSession({
    ...options,
    async execute() { throw failure; },
  }), (error) => error === failure, 'functional failure propagates to the owning installer finally');
  for (const invalid of [
    { artifact: { source: 'latest', variant: 'main' } },
    { artifact: { source: 'local-pack', variant: 'inspector' } },
    { instanceId: '' },
  ]) {
    await assert.rejects(runFunctionalInMatchingSession({
      ...options,
      ...invalid,
      execute() { assert.fail('an ineligible session must not launch functional tests'); },
    }), /requires/);
  }
}

{
  const root = mkdtempSync(join(tmpdir(), 'rsmcp-prepared-release-fixture-'));
  const put = (relative, source) => {
    const target = join(root, relative);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, source);
  };
  const version = '99.0.0';
  const plugin = (variant, value = version) => `local CURRENT_VERSION = "${value}";\nlocal PLUGIN_VARIANT = "${variant}";`;
  try {
    put('package.json', JSON.stringify({ version }));
    for (const workspace of ['robloxstudio-mcp', 'robloxstudio-mcp-inspector']) {
      put(`packages/${workspace}/package.json`, JSON.stringify({ version }));
      put(`packages/${workspace}/dist/index.js`, 'export const compiled = true;');
    }
    put('studio-plugin/MCPPlugin.rbxmx', plugin('main'));
    put('studio-plugin/MCPInspectorPlugin.rbxmx', plugin('inspector'));
    validatePreparedArtifacts(root);
    put('studio-plugin/MCPInspectorPlugin.rbxmx', plugin('inspector', '98.0.0'));
    assert.throws(() => validatePreparedArtifacts(root), /CURRENT_VERSION/);
    put('studio-plugin/MCPInspectorPlugin.rbxmx', plugin('main'));
    assert.throws(() => validatePreparedArtifacts(root), /PLUGIN_VARIANT/);
    put('studio-plugin/MCPInspectorPlugin.rbxmx', plugin('inspector'));
    put('packages/robloxstudio-mcp/package.json', JSON.stringify({ version: '98.0.0' }));
    assert.throws(() => validatePreparedArtifacts(root), /version .* does not match/);
    put('packages/robloxstudio-mcp/package.json', JSON.stringify({ version }));
    rmSync(join(root, 'packages/robloxstudio-mcp-inspector/dist/index.js'));
    assert.throws(() => validatePreparedArtifacts(root), /server output is missing/);
    put('packages/robloxstudio-mcp-inspector/dist/index.js', 'export const compiled = true;');
    rmSync(join(root, 'studio-plugin/MCPPlugin.rbxmx'));
    assert.throws(() => validatePreparedArtifacts(root), /ENOENT/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

console.log('Release orchestration, matching-session reuse, and prepared-artifact regressions passed.');
