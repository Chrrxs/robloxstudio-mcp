#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createTestProfileEnvironment,
  encodeTestProfilePayload,
  parseTestProfileArguments,
  runTestProfileCommand,
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
assert.equal(inherited.MCP_INSTANCE_ID, 'personal-studio', 'normalizing the child does not mutate caller state');
assert.throws(() => createTestProfileEnvironment(identity, { ...invocation, sourceSid: identity.sid }), /personal\/source Windows identity/);
assert.throws(() => createTestProfileEnvironment({ ...identity, sid: invocation.sourceSid }, invocation), /unexpected target SID/);
assert.throws(() => createTestProfileEnvironment({ ...identity, profileLoaded: false }, invocation), /loaded profile/);
assert.throws(() => createTestProfileEnvironment({ ...identity, interactiveSession: false }, invocation), /interactive Windows desktop/);
assert.throws(() => createTestProfileEnvironment({ ...identity, localAppData: 'C:\\Users\\Personal\\AppData\\Local' }, invocation), /redirected AppData/);

// Run only the bootstrap against a temporary fixture checkout: no credentials,
// account mutations, Studio, enrollment markers, or host settings are touched.
if (process.platform === 'win32') {
  const credentialModuleStatus = await runTestProfileCommand('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    '$ErrorActionPreference = "Stop"; Import-Module Microsoft.PowerShell.Security; $null = Get-Command Get-Credential -ErrorAction Stop; Write-Output "Credential module preflight passed"',
  ]);
  assert.equal(credentialModuleStatus, 0, 'the launcher must load Windows credential commands even when invoked through PowerShell 7 and Node');
  const current = JSON.parse(execFileSync('powershell.exe', [
    '-NoProfile', '-Command',
    '[pscustomobject]@{ sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value; interactive = ([Environment]::UserInteractive -and [Diagnostics.Process]::GetCurrentProcess().SessionId -gt 0); profileDirectory = $env:USERPROFILE; localAppData = [Environment]::GetFolderPath("LocalApplicationData"); roamingAppData = [Environment]::GetFolderPath("ApplicationData") } | ConvertTo-Json -Compress',
  ], { encoding: 'utf8' }));
  if (current.interactive) {
    const fixture = mkdtempSync(path.join(os.tmpdir(), 'rsmcp-profile-bootstrap-'));
    let fixtureError;
    try {
      mkdirSync(path.join(fixture, 'scripts'));
      writeFileSync(path.join(fixture, 'scripts', 'studio-test-profile.ps1'), '');
      writeFileSync(path.join(fixture, 'scripts', 'studio-test-profile.mjs'), [
        'import assert from "node:assert/strict";',
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

      // Exercise production setup ordering with fake commands, never real enrollment.
      mkdirSync(path.join(fixture, 'tests'));
      const traceFile = path.join(fixture, 'setup-trace.jsonl');
      const setupPayload = encodeTestProfilePayload({
        mode: 'enroll', repo: fixture, targetSid: current.sid,
        sourceSid: current.sid === invocation.sourceSid ? identity.sid : invocation.sourceSid,
        confirmDedicatedProfile: true,
      });
      const setupSteps = ['enroll-test-profile', 'managed', 'assert-test-profile'];
      for (const failAt of [null, ...setupSteps]) {
        writeFileSync(traceFile, '');
        const recordStep = [
          'import { appendFileSync } from "node:fs";',
          `const record = (step) => { appendFileSync(${JSON.stringify(traceFile)}, JSON.stringify(step) + "\\n"); if (step === ${JSON.stringify(failAt)}) process.exit(23); };`,
        ].join('\n');
        writeFileSync(path.join(fixture, 'scripts', 'studio-lifecycle.mjs'), `${recordStep}\nrecord(process.argv[2]);\n`);
        writeFileSync(path.join(fixture, 'tests', 'run-all.mjs'), [
          'import assert from "node:assert/strict";',
          'assert.deepEqual(process.argv.slice(2), ["--managed", "--test", "path-resolution.mjs"]);',
          recordStep,
          'record("managed");',
        ].join('\n'));
        const setupResult = spawnSync(process.execPath, [
          fileURLToPath(new URL('../scripts/studio-test-profile.mjs', import.meta.url)), '_child', setupPayload,
        ], { encoding: 'utf8' });
        assert.ifError(setupResult.error);
        assert.equal(setupResult.status, failAt === null ? 0 : 23, setupResult.stdout + setupResult.stderr);
        const observedSteps = readFileSync(traceFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
        assert.deepEqual(observedSteps, failAt === null ? setupSteps : setupSteps.slice(0, setupSteps.indexOf(failAt) + 1));

        writeFileSync(traceFile, '');
        const runPayload = encodeTestProfilePayload({
          mode: 'run', repo: fixture, targetSid: current.sid,
          sourceSid: current.sid === invocation.sourceSid ? identity.sid : invocation.sourceSid,
          command: ['tests/run-all.mjs', '--managed', '--test', 'path-resolution.mjs'],
        });
        const runResult = spawnSync(process.execPath, [
          fileURLToPath(new URL('../scripts/studio-test-profile.mjs', import.meta.url)), '_child', runPayload,
        ], { encoding: 'utf8' });
        assert.ifError(runResult.error);
        const runSteps = ['assert-test-profile', 'managed', 'assert-test-profile'];
        const failsRun = failAt === 'managed' || failAt === 'assert-test-profile';
        assert.equal(runResult.status, failsRun ? 23 : 0, runResult.stdout + runResult.stderr);
        const observedRunSteps = readFileSync(traceFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
        assert.deepEqual(observedRunSteps, failsRun ? runSteps.slice(0, runSteps.indexOf(failAt) + 1) : runSteps);
      }
    } catch (error) {
      fixtureError = error;
      throw error;
    } finally {
      try {
        rmSync(fixture, { recursive: true, force: true });
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
