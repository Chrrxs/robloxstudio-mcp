#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createTestProfileEnvironment,
  encodeTestProfilePayload,
  parseTestProfileArguments,
  runTestProfileCommand,
  runTestProfilePayload,
} from '../scripts/studio-test-profile.mjs';
import { windowsPowerShellEnvironment } from '../scripts/studio-lifecycle.mjs';

const mixedModuleEnvironment = {
  PSModulePath: 'C:\\preview\\Modules',
  winpsmodulepath: 'C:\\source-profile\\Modules',
  PATH: 'C:\\Windows\\System32',
};
assert.deepEqual(windowsPowerShellEnvironment(mixedModuleEnvironment), { PATH: mixedModuleEnvironment.PATH });
assert.equal(mixedModuleEnvironment.PSModulePath, 'C:\\preview\\Modules', 'sanitizing a subprocess never changes the source shell');

const command = ['tests/run-all.mjs', '--label', 'a "quoted" value', '', 'C:\\place with spaces\\', '$env:USERPROFILE; & whoami', '東京'];
const parsed = parseTestProfileArguments([
  'run', '--user', 'MACHINE\\StudioTests', '--repo', 'C:\\work with spaces\\repo', '--', ...command,
]);
const transported = JSON.parse(Buffer.from(encodeTestProfilePayload(parsed), 'base64').toString('utf8'));
assert.deepEqual(transported.command, command, 'PowerShell transport preserves arguments without evaluating shell text');
assert.equal(transported.repo, 'C:\\work with spaces\\repo');
assert.equal(parseTestProfileArguments(['enroll', '--user', 'MACHINE\\StudioTests', '--confirm-dedicated-profile']).confirmDedicatedProfile, true);
assert.throws(() => parseTestProfileArguments(['enroll', '--user', 'MACHINE\\StudioTests']), /confirm-dedicated-profile/);
assert.throws(() => parseTestProfileArguments(['run', '--user', 'MACHINE\\StudioTests']), /Usage/);
assert.throws(() => parseTestProfileArguments(['run', '--user', 'MACHINE\\StudioTests', '--password', 'secret', '--', 'tests/run-all.mjs']), /Invalid or duplicate launcher option --password/);
assert.throws(() => parseTestProfileArguments(['run', '--user', 'one', '--user', 'two', '--', 'tests/run-all.mjs']), /duplicate launcher option/);
assert.throws(() => parseTestProfileArguments(['run', '--user', 'MACHINE\\StudioTests', 'toString', 'ignored', '--', 'tests/run-all.mjs']), /Invalid or duplicate launcher option toString/);
assert.deepEqual(parseTestProfileArguments(['setup']), { mode: 'enroll', command: [], confirmDedicatedProfile: true });
assert.deepEqual(parseTestProfileArguments(['run', '--', 'tests/run-all.mjs']), { mode: 'run', command: ['tests/run-all.mjs'] });
assert.deepEqual(parseTestProfileArguments(['forget']), { mode: 'forget', command: [] });
assert.throws(() => parseTestProfileArguments(['forget', '--repo', 'C:\\work\\repo']), /Usage/);
assert.deepEqual(parseTestProfileArguments(['reset-safety', '--reason', 'Studio repaired']), {
  mode: 'run', command: [], resetSafetyReason: 'Studio repaired',
});
assert.throws(() => parseTestProfileArguments(['reset-safety']), /Usage/);
assert.throws(() => parseTestProfileArguments(['reset-safety', '--reason', ' ']), /Usage/);
assert.throws(() => parseTestProfileArguments(['reset-safety', '--reason', 'checked', '--', 'tests/run-all.mjs']), /Usage/);
assert.throws(() => parseTestProfileArguments(['run', '--reason', 'bypass', '--', 'tests/run-all.mjs']), /Invalid/);

const identity = {
  sid: 'S-1-5-21-100-200-300-1002',
  accountName: 'MACHINE\\StudioTests',
  profileDirectory: 'C:\\Users\\StudioTests',
  localAppData: 'C:\\Users\\StudioTests\\AppData\\Local',
  roamingAppData: 'C:\\Users\\StudioTests\\AppData\\Roaming',
  profileLoaded: true,
  interactiveSession: true,
  machinePath: '%SystemRoot%\\System32',
  userPath: '%USERPROFILE%\\bin',
};
const invocation = {
  sourceSid: 'S-1-5-21-100-200-300-1001',
  targetSid: identity.sid,
  nodeExecutable: 'C:\\Program Files\\nodejs\\node.exe',
};
const inherited = {
  SystemRoot: 'C:\\Windows',
  USERPROFILE: 'C:\\Users\\Personal',
  localappdata: 'C:\\Users\\Personal\\AppData\\Local',
  APPDATA: 'C:\\Users\\Personal\\AppData\\Roaming',
  HOME: 'C:\\Users\\Personal',
  TEMP: 'C:\\Users\\Personal\\AppData\\Local\\Temp',
  Path: 'C:\\Users\\Personal\\bin',
  MCP_INSTANCE_ID: 'personal-studio',
  MCP_PLUGINS_DIR: 'C:\\Users\\Personal\\Plugins',
  ROBLOXSTUDIO_MCP_MANAGED_INSTANCE_REGISTRY_DIR: 'C:\\Users\\Personal\\registry',
  ROBLOX_STUDIO_EXE: 'C:\\Users\\Personal\\Studio.exe',
  RSMCP_STUDIO_WORKING_DIRECTORY: 'C:\\Users\\Personal',
  RSMCP_STUDIO_TEST_SAFETY_DIR: 'C:\\Users\\Personal\\safety',
  RSMCP_STUDIO_TEST_PREPARED: '1',
  NODE_OPTIONS: '--require C:\\Users\\Personal\\hook.js',
  NODE_PATH: 'C:\\Users\\Personal\\node_modules',
  PSModulePath: 'C:\\Users\\Personal\\PowerShell\\Modules',
  WinPSModulePath: 'C:\\Users\\Personal\\WindowsPowerShell\\Modules',
  WSLENV: 'USERPROFILE/p',
  npm_config_cache: 'C:\\Users\\Personal\\npm-cache',
};
const env = createTestProfileEnvironment(identity, invocation, inherited);
assert.equal(env.USERPROFILE, identity.profileDirectory);
assert.equal(env.LOCALAPPDATA, identity.localAppData);
assert.equal(env.APPDATA, identity.roamingAppData);
assert.equal(env.TEMP, 'C:\\Users\\StudioTests\\AppData\\Local\\Temp');
assert.equal(env.USERNAME, 'StudioTests');
assert.equal(env.USERDOMAIN, 'MACHINE');
assert.equal(env.PATH, 'C:\\Program Files\\nodejs;C:\\Windows\\System32;C:\\Users\\StudioTests\\bin');
assert.equal(Object.values(env).some((value) => value.includes('Personal')), false, 'child receives no inherited personal profile paths');
for (const key of ['MCP_INSTANCE_ID', 'MCP_PLUGINS_DIR', 'ROBLOXSTUDIO_MCP_MANAGED_INSTANCE_REGISTRY_DIR', 'ROBLOX_STUDIO_EXE', 'RSMCP_STUDIO_WORKING_DIRECTORY', 'NODE_OPTIONS', 'NODE_PATH', 'PSModulePath', 'WinPSModulePath', 'WSLENV', 'npm_config_cache', 'Path', 'localappdata']) {
  assert.equal(key in env, false, `${key} must not leak into the dedicated harness`);
}
assert.equal('RSMCP_STUDIO_TEST_SAFETY_DIR' in env, false);
assert.equal('RSMCP_STUDIO_TEST_PREPARED' in env, false);
assert.equal(inherited.MCP_INSTANCE_ID, 'personal-studio', 'normalizing the child does not mutate caller state');
assert.throws(() => createTestProfileEnvironment(identity, { ...invocation, sourceSid: identity.sid }), /personal\/source Windows identity/);
assert.throws(() => createTestProfileEnvironment({ ...identity, sid: invocation.sourceSid }, invocation), /unexpected target SID/);
assert.throws(() => createTestProfileEnvironment({ ...identity, profileLoaded: false }, invocation), /loaded profile/);
assert.throws(() => createTestProfileEnvironment({ ...identity, interactiveSession: false }, invocation), /interactive Windows desktop/);
assert.throws(() => createTestProfileEnvironment({ ...identity, localAppData: 'C:\\Users\\Personal\\AppData\\Local' }, invocation), /redirected AppData/);

// Exercise the production child ordering without a native account, filesystem,
// or Studio. The safety lease must surround preflight, suite, and postflight.
for (const mode of ['enroll', 'run']) {
  const steps = mode === 'enroll'
    ? ['enroll-test-profile', 'suite', 'assert-test-profile']
    : ['assert-test-profile', 'suite', 'assert-test-profile'];
  for (const failureIndex of [-1, 0, 1, 2]) {
    const trace = [];
    let insideRun = false;
    let safetyCalls = 0;
    const exitCode = await runTestProfilePayload({
      ...invocation, mode, repo: 'C:\\fixture',
      command: mode === 'run' ? ['tests/run-all.mjs', '--managed'] : [],
      confirmDedicatedProfile: mode === 'enroll',
      prepareWorkspace: true,
    }, {
      identity,
      async runSafely(runEnv, operation) {
        safetyCalls++;
        assert.equal(runEnv.RSMCP_STUDIO_TEST_SAFETY_DIR,
          path.win32.join(identity.localAppData, 'robloxstudio-mcp', 'test-safety'));
        assert.equal(runEnv.RSMCP_STUDIO_TEST_PREPARED, '1');
        insideRun = true;
        try { return await operation(); } finally { insideRun = false; }
      },
      async execute(_command, args, options) {
        assert.equal(insideRun, true);
        assert.equal(options.env.USERPROFILE, identity.profileDirectory);
        const step = args[0] === 'tests/run-all.mjs' ? 'suite' : args[1];
        trace.push(step);
        return trace.length - 1 === failureIndex ? 23 : 0;
      },
      async resetSafety() { assert.fail('ordinary runs must not reset safety'); },
    });
    assert.equal(safetyCalls, 1);
    assert.equal(insideRun, false);
    assert.equal(exitCode, failureIndex < 0 ? 0 : 23);
    assert.deepEqual(trace, failureIndex < 0 ? steps : steps.slice(0, failureIndex + 1));
  }
}
let resetCalls = 0;
const resetExit = await runTestProfilePayload({
  ...invocation, mode: 'run', repo: 'C:\\fixture', command: [],
  resetSafetyReason: 'Studio repaired and login checked',
}, {
  identity,
  async runSafely() { assert.fail('reset must not start a live test run'); },
  async execute(_command, args, options) {
    assert.equal(args[1], 'assert-test-profile');
    assert.equal('RSMCP_STUDIO_TEST_PREPARED' in options.env, false, 'explicit unprepared repo cannot claim prepared artifacts');
    return 0;
  },
  async resetSafety(_env, reason) {
    resetCalls++;
    assert.equal(reason, 'Studio repaired and login checked');
  },
});
assert.equal(resetExit, 0);
assert.equal(resetCalls, 1);
await assert.rejects(runTestProfilePayload({
  ...invocation, mode: 'run', repo: 'C:\\fixture', command: ['tests/run-all.mjs'],
}, {
  identity,
  async runSafely() { throw new Error('previous run blocked'); },
  async execute() { assert.fail('blocked run must not execute any child'); },
}), /previous run blocked/);

// Run only the bootstrap against a temporary fixture checkout: no credentials,
// account mutations, Studio, enrollment markers, or host settings are touched.
if (process.platform === 'win32') {
  const containmentResult = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', fileURLToPath(new URL('./studio-test-profile-job.ps1', import.meta.url)),
    '-LauncherPath', fileURLToPath(new URL('../scripts/studio-test-profile.ps1', import.meta.url)),
    '-NodeExecutable', process.execPath,
  ], { encoding: 'utf8', env: windowsPowerShellEnvironment(process.env), timeout: 90_000 });
  assert.ifError(containmentResult.error);
  assert.equal(containmentResult.status, 0, containmentResult.stdout + containmentResult.stderr);
  assert.match(containmentResult.stdout, /owned-installer-replacement-completed-unrelated-preserved-leftover-closed/);
  assert.match(containmentResult.stdout, /owned-installer-hard-deadline-enforced/);
  assert.match(containmentResult.stdout, /owned-installer-explicit-cancellation-remains-immediate/);
  assert.match(containmentResult.stderr, /allowing up to 10 minutes/);
  assert.match(containmentResult.stderr, /completion grace expired/);
  const credentialModuleStatus = await runTestProfileCommand('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    '$ErrorActionPreference = "Stop"; Import-Module Microsoft.PowerShell.Security; $null = Get-Command Get-Credential -ErrorAction Stop; Write-Output "Credential module preflight passed"',
  ]);
  assert.equal(credentialModuleStatus, 0, 'the launcher must load Windows credential commands even when invoked through PowerShell 7 and Node');
  const current = JSON.parse(execFileSync('powershell.exe', [
    '-NoProfile', '-Command',
    '[pscustomobject]@{ sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value; interactive = ([Environment]::UserInteractive -and [Diagnostics.Process]::GetCurrentProcess().SessionId -gt 0); profileDirectory = $env:USERPROFILE; localAppData = [Environment]::GetFolderPath("LocalApplicationData"); roamingAppData = [Environment]::GetFolderPath("ApplicationData") } | ConvertTo-Json -Compress',
  ], { encoding: 'utf8' }));
  const bootstrapArguments = [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', fileURLToPath(new URL('../scripts/studio-test-profile.ps1', import.meta.url)),
  ];
  for (const invalidInput of ['not-base64!', Buffer.from('{invalid json', 'utf8').toString('base64')]) {
    const invalidResult = spawnSync('powershell.exe', [
      ...bootstrapArguments, '-Child', '-PayloadFromStdin',
    ], { encoding: 'utf8', input: invalidInput, env: windowsPowerShellEnvironment(process.env) });
    assert.ifError(invalidResult.error);
    assert.equal(invalidResult.status, 1, 'malformed stdin payload must fail before launching Node');
    assert.match(invalidResult.stderr, /Studio launcher child failure/, 'malformed input must reach the production child receiver');
    assert.doesNotMatch(invalidResult.stdout, /bootstrap-clean/);
  }
  // Invalid input also makes this safe if source-side validation regresses:
  // decoding must stop before any account lookup or credential flow.
  const sourceStdinResult = spawnSync('powershell.exe', [
    ...bootstrapArguments, '-PayloadFromStdin',
  ], { encoding: 'utf8', input: 'not-base64!', env: windowsPowerShellEnvironment(process.env) });
  assert.ifError(sourceStdinResult.error);
  assert.equal(sourceStdinResult.status, 1, 'the source launcher must reject stdin transport');
  assert.match(sourceStdinResult.stderr, /PayloadFromStdin.*child/i, 'stdin transport must be rejected before decoding or credential flow');
  if (current.interactive) {
    const fixture = mkdtempSync(path.join(os.tmpdir(), 'rsmcp-profile-bootstrap-'));
    let fixtureError;
    try {
      mkdirSync(path.join(fixture, 'scripts'));
      writeFileSync(path.join(fixture, 'scripts', 'studio-test-profile.ps1'), '');
      writeFileSync(path.join(fixture, 'scripts', 'studio-test-profile.mjs'), [
        'import assert from "node:assert/strict";',
        'import { readFileSync } from "node:fs";',
        'import { isDeepStrictEqual } from "node:util";',
        `import { probeWindowsStudioIdentity } from ${JSON.stringify(new URL('../scripts/studio-lifecycle.mjs', import.meta.url).href)};`,
        `import { createTestProfileEnvironment } from ${JSON.stringify(new URL('../scripts/studio-test-profile.mjs', import.meta.url).href)};`,
        'if (Object.keys(process.env).some((key) => /^NODE_/i.test(key))) throw new Error("Inherited Node startup environment reached bootstrap");',
        'assert.equal(process.env.RSMCP_SOURCE_ONLY, undefined, "source-only environment must not cross the account boundary");',
        'const actualIdentity = probeWindowsStudioIdentity();',
        `assert.equal(actualIdentity.profileDirectory, ${JSON.stringify(current.profileDirectory)});`,
        `assert.equal(actualIdentity.localAppData, ${JSON.stringify(current.localAppData)});`,
        `assert.equal(actualIdentity.roamingAppData, ${JSON.stringify(current.roamingAppData)});`,
        'const payload = JSON.parse(Buffer.from(process.argv[3], "base64").toString("utf8"));',
        'assert.equal(process.argv[2], "_child");',
        'assert.equal(process.cwd().toLowerCase(), payload.repo.toLowerCase(), "native bootstrap must use the checkout as cwd");',
        'const env = createTestProfileEnvironment(actualIdentity, { ...payload, nodeExecutable: process.execPath }, process.env);',
        'assert.equal(env.USERPROFILE, actualIdentity.profileDirectory);',
        'assert.equal(env.LOCALAPPDATA, actualIdentity.localAppData);',
        'if (payload.command) {',
        `  const expected = JSON.parse(readFileSync(${JSON.stringify(path.join(fixture, 'expected-stdin-payload.json'))}, "utf8"));`,
        '  assert.equal(isDeepStrictEqual(payload, expected), true, "stdin transport must preserve the entire payload exactly");',
        '  console.log("bootstrap-stdin-roundtrip");',
        '}',
        'console.log("bootstrap-clean");',
      ].join('\n'));
      const preload = path.join(fixture, 'personal-preload.cjs');
      writeFileSync(preload, 'throw new Error("Personal preload executed before profile normalization");\n');
      const launchGate = path.join(fixture, 'contained');
      writeFileSync(launchGate, 'fixture gate');
      const bootstrapPayload = encodeTestProfilePayload({
        mode: 'run',
        repo: fixture,
        nodeExecutable: process.execPath,
        targetSid: current.sid,
        sourceSid: current.sid === invocation.sourceSid ? identity.sid : invocation.sourceSid,
        launchGate,
      });
      const result = execFileSync('powershell.exe', [
        '-NoProfile', '-ExecutionPolicy', 'Bypass',
        '-File', fileURLToPath(new URL('../scripts/studio-test-profile.ps1', import.meta.url)),
        '-Child', '-Payload', bootstrapPayload,
      ], {
        encoding: 'utf8',
        env: {
          ...process.env,
          NODE_OPTIONS: `--require "${preload}"`,
          NODE_PATH: fixture,
          USERPROFILE: path.join(fixture, 'foreign-profile'),
          LOCALAPPDATA: path.join(fixture, 'foreign-profile', 'AppData', 'Local'),
          APPDATA: path.join(fixture, 'foreign-profile', 'AppData', 'Roaming'),
          TEMP: path.join(fixture, 'foreign-profile', 'inaccessible-temp'),
          TMP: path.join(fixture, 'foreign-profile', 'inaccessible-temp'),
          RSMCP_SOURCE_ONLY: 'must-not-be-inherited',
        },
      });
      assert.match(result, /bootstrap-clean/);

      const stdinPayload = {
        ...JSON.parse(Buffer.from(bootstrapPayload, 'base64').toString('utf8')),
        command: [
          ...command,
          'argument with spaces '.repeat(80),
          'embedded "quotes" and a trailing slash\\',
          'C:\\two trailing backslashes\\\\',
          '$(throw "must stay literal"); & whoami | Out-File ignored',
          '%USERPROFILE% && echo must-stay-literal',
          'café 東京 Ελληνικά',
        ],
      };
      const encodedStdinPayload = encodeTestProfilePayload(stdinPayload);
      assert.ok(Buffer.byteLength(JSON.stringify(stdinPayload), 'utf8') > 1024, 'fixture must exceed the credentialed command-line limit before base64 encoding');
      writeFileSync(path.join(fixture, 'expected-stdin-payload.json'), JSON.stringify(stdinPayload));
      const stdinResult = spawnSync('powershell.exe', [
        ...bootstrapArguments, '-Child', '-PayloadFromStdin',
      ], {
        encoding: 'utf8',
        input: encodedStdinPayload,
        env: windowsPowerShellEnvironment(process.env),
      });
      assert.ifError(stdinResult.error);
      assert.equal(stdinResult.status, 0, 'large stdin payload must complete the production child bootstrap');
      assert.match(stdinResult.stdout, /bootstrap-stdin-roundtrip/, 'the fake Node entrypoint must verify the exact decoded payload');
      assert.match(stdinResult.stdout, /bootstrap-clean/);

      const conflictingPayloadResult = spawnSync('powershell.exe', [
        ...bootstrapArguments, '-Child', '-PayloadFromStdin', '-Payload', bootstrapPayload,
      ], { encoding: 'utf8', input: encodedStdinPayload, env: windowsPowerShellEnvironment(process.env) });
      assert.ifError(conflictingPayloadResult.error);
      assert.equal(conflictingPayloadResult.status, 1, 'inline and stdin payload transports must be mutually exclusive');
      assert.doesNotMatch(conflictingPayloadResult.stdout, /bootstrap-clean|bootstrap-stdin-roundtrip/);

      // Private ancestors break both PowerShell cwd resolution and Node's
      // entrypoint canonicalization. The wrapper proves rejection, restores
      // the temporary ACL, then runs the same checkout from the shared root.
      const protectedRepo = path.join(fixture, 'protected-parent', 'private-temp', 'checkout with spaces');
      mkdirSync(path.join(protectedRepo, 'scripts'), { recursive: true });
      writeFileSync(path.join(protectedRepo, 'scripts', 'studio-test-profile.ps1'), '');
      writeFileSync(
        path.join(protectedRepo, 'scripts', 'studio-test-profile.mjs'),
        readFileSync(path.join(fixture, 'scripts', 'studio-test-profile.mjs')),
      );
      const protectedPayload = encodeTestProfilePayload({
        mode: 'run',
        repo: protectedRepo,
        nodeExecutable: process.execPath,
        targetSid: current.sid,
        sourceSid: current.sid === invocation.sourceSid ? identity.sid : invocation.sourceSid,
        launchGate,
      });
      const protectedResult = spawnSync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', fileURLToPath(new URL('./studio-test-profile-cwd.ps1', import.meta.url)),
        '-LauncherPath', fileURLToPath(new URL('../scripts/studio-test-profile.ps1', import.meta.url)),
        '-SnapshotRootHelperPath', fileURLToPath(new URL('../scripts/studio-test-snapshot-root.ps1', import.meta.url)),
        '-Payload', protectedPayload,
      ], { encoding: 'utf8', env: windowsPowerShellEnvironment(process.env) });
      assert.ifError(protectedResult.error);
      assert.equal(protectedResult.status, 0, protectedResult.stdout + protectedResult.stderr);
      assert.match(protectedResult.stdout, /protected-parent-set-location-denied/);
      assert.match(protectedResult.stdout, /protected-parent-bootstrap-rejected/);
      assert.match(protectedResult.stdout, /shared-root-bootstrap-completed/);
      assert.match(protectedResult.stdout, /bootstrap-clean/, 'shared-root bootstrap must reach and complete the fake Node entrypoint with the checkout cwd');

    } catch (error) {
      fixtureError = error;
      throw error;
    } finally {
      try {
        rmSync(fixture, { recursive: true, force: true });
        assert.equal(existsSync(fixture), false, 'bootstrap fixture files must be removed after child exit');
      } catch (cleanupError) {
        if (fixtureError) throw new AggregateError([fixtureError, cleanupError], 'Bootstrap fixture failed and cleanup also failed');
        throw cleanupError;
      }
    }
  } else {
    console.log('Windows bootstrap fixture skipped: interactive desktop unavailable');
  }
} else {
  console.log('Windows bootstrap fixture skipped: native Windows Node required');
}

console.log('Studio test-profile launcher fixture tests passed');
