import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { collectStudioInstallDiagnostics, collectStudioBitsDiagnostics } from '../scripts/studio-install-diagnostics.mjs';
import { parseTestProfileArguments, runTestProfilePayload } from '../scripts/studio-test-profile.mjs';
import { selectInstalledStudioExecutable } from '../scripts/studio-lifecycle.mjs';

assert.deepEqual(collectStudioBitsDiagnostics({ platform: 'linux' }), { available: false, reason: 'Windows required' });
const bits = collectStudioBitsDiagnostics({
  platform: 'win32',
  execute(command, args) {
    assert.equal(command, 'powershell.exe');
    const script = args.at(-1);
    assert.doesNotMatch(script, /-AllUsers|(?:Resume|Suspend|Complete|Remove|Add|Set)-BitsTransfer/);
    assert.match(script, /Get-BitsTransfer/);
    assert.match(script, /GetCurrent/);
    assert.match(script, /OwnerAccount/);
    assert.match(script, /Select-Object -First 25/);
    return '{"available":true,"totalJobs":1,"jobs":[{"state":"Suspended","bytesTransferred":"0","bytesTotal":"1024"}]}';
  },
});
assert.equal(bits.jobs[0].state, 'Suspended');
assert.deepEqual(collectStudioBitsDiagnostics({
  platform: 'win32',
  execute() { throw new Error('SECRET_BITS_URL'); },
}), { available: false, reason: 'Current-account BITS query failed' });
if (process.platform === 'win32') {
  // Execute the actual PowerShell projection against fixture objects, never
  // real transfers. Extra private fields must not escape the allowlist.
  const projected = collectStudioBitsDiagnostics({
    execute(command, args, options) {
      const fixture = `
        function Get-BitsTransfer {
          1..30 | ForEach-Object {
            [pscustomobject]@{
              OwnerAccount = [Security.Principal.WindowsIdentity]::GetCurrent().Name
              JobId = [guid]::Empty; JobState = 'TransientError'; Priority = 'Background'
              BytesTransferred = 0; BytesTotal = 1024; FilesTransferred = 0; FilesTotal = 1
              InternalErrorCode = -2147024891; ModificationTime = [datetime]::UtcNow
              ErrorDescription = 'PRIVATE_ERROR_DESCRIPTION'; RemoteName = 'https://private.test/SECRET'
            }
          }
        }
      `;
      return execFileSync(command, [...args.slice(0, -1), fixture + args.at(-1)], options);
    },
  });
  assert.equal(projected.available, true);
  assert.equal(projected.totalJobs, 30);
  assert.equal(projected.jobs.length, 25);
  assert.ok(projected.jobs.every(job => job.errorCode === -2147024891));
  assert.doesNotMatch(JSON.stringify(projected), /PRIVATE_ERROR_DESCRIPTION|SECRET|private\.test/);
}
const root = mkdtempSync(path.join(tmpdir(), 'studio-install-diagnostics-'));
try {
  const version = path.join(root, 'Roblox', 'Versions', 'version-aabb');
  mkdirSync(version, { recursive: true });
  writeFileSync(path.join(version, 'RobloxStudioBeta.exe'), 'fixture');
  const logs = path.join(root, 'Roblox', 'logs');
  mkdirSync(logs);
  writeFileSync(path.join(logs, 'Studio.log'), [
    'Error: missing AppSettings.xml',
    'Error: authorization bearer TOP_SECRET',
    'Error: cookie SESSION_SECRET',
    'Error: request failed https://example.test/private?value=URL_PRIVATE_VALUE',
  ].join('\n'));
  const report = collectStudioInstallDiagnostics(root);
  assert.equal(report.readOnly, true);
  assert.equal(report.versions.length, 1);
  assert.deepEqual(report.versions[0].entries, ['RobloxStudioBeta.exe']);
  assert.equal(report.logs[0].sensitiveLinesOmitted, 2);
  assert.match(JSON.stringify(report), /missing AppSettings.xml/);
  assert.doesNotMatch(JSON.stringify(report), /TOP_SECRET|SESSION_SECRET|URL_PRIVATE_VALUE/);
  assert.match(readFileSync(path.join(logs, 'Studio.log'), 'utf8'), /TOP_SECRET/, 'diagnosis never modifies source logs');
  writeFileSync(path.join(logs, 'RobloxStudioInstaller_AB123.log'), [
    ...Array.from({ length: 40 }, (_, index) => `[FLog::DesktopInstaller] Download progress ${index}`),
    '[FLog::DesktopInstaller] Waiting for stage switch',
    '[FLog::DesktopInstaller] Download https://example.test/private?value=INSTALLER_PRIVATE_VALUE',
    '[FLog::DesktopInstaller] Authorization bearer INSTALLER_SECRET',
  ].join('\n'));
  const installerLog = collectStudioInstallDiagnostics(root).logs.find(log => log.name === 'RobloxStudioInstaller_AB123.log');
  assert.equal(installerLog.indicators.length, 35, 'installer activity is bounded');
  assert.ok(installerLog.indicators.includes('[FLog::DesktopInstaller] Waiting for stage switch'), 'diagnosis exposes stalled installer stages, not just errors');
  assert.equal(installerLog.sensitiveLinesOmitted, 1);
  assert.doesNotMatch(JSON.stringify(installerLog), /INSTALLER_SECRET|INSTALLER_PRIVATE_VALUE/);
  const versionsRoot = path.dirname(version);
  const older = path.join(versionsRoot, 'version-0011');
  mkdirSync(older);
  writeFileSync(path.join(older, 'RobloxStudioBeta.exe'), 'older complete executable');
  writeFileSync(path.join(older, 'AppSettings.xml'), '<Settings/>');
  utimesSync(path.join(older, 'RobloxStudioBeta.exe'), 1000, 1000);
  utimesSync(path.join(version, 'RobloxStudioBeta.exe'), 2000, 2000);
  assert.throws(() => selectInstalledStudioExecutable(versionsRoot), /incomplete.*refusing to fall back/);
  writeFileSync(path.join(version, 'AppSettings.xml'), '');
  assert.throws(() => selectInstalledStudioExecutable(versionsRoot), /incomplete/);
  writeFileSync(path.join(version, 'AppSettings.xml'), '<Settings/>');
  writeFileSync(path.join(version, '.crdownload'), '');
  assert.throws(() => selectInstalledStudioExecutable(versionsRoot), /incomplete/);
  rmSync(path.join(version, '.crdownload'));
  assert.equal(selectInstalledStudioExecutable(versionsRoot), path.join(version, 'RobloxStudioBeta.exe'));
} finally { rmSync(root, { recursive: true, force: true }); }

const identity = {
  sid: 'S-1-5-21-100-200-300-1003', accountName: 'MACHINE\\StudioTests',
  profileDirectory: 'C:\\Users\\StudioTests', localAppData: 'C:\\Users\\StudioTests\\AppData\\Local',
  roamingAppData: 'C:\\Users\\StudioTests\\AppData\\Roaming', profileLoaded: true, interactiveSession: true,
};
const payload = { ...parseTestProfileArguments(['diagnose']), repo: 'C:\\fixture', sourceSid: 'S-1-5-21-100-200-300-1002', targetSid: identity.sid };
let calls = 0;
const adapters = {
  identity,
  async runSafely() { assert.fail('read-only diagnosis must not start a live run'); },
  async resetSafety() { assert.fail('diagnosis must preserve the failure latch'); },
  async execute(_node, args) {
    calls++;
    assert.deepEqual(args, [path.join(payload.repo, 'scripts', 'studio-install-diagnostics.mjs')]);
    return 0;
  },
};
assert.equal(await runTestProfilePayload(payload, adapters), 0);
assert.equal(calls, 1);
assert.throws(() => parseTestProfileArguments(['diagnose', '--', 'launch.mjs']), /Usage/);
assert.throws(() => parseTestProfileArguments(['diagnose', '--reason', 'reset']), /Invalid/);
await assert.rejects(runTestProfilePayload({ ...payload, command: ['launch.mjs'] }, adapters), /cannot execute/);
await assert.rejects(runTestProfilePayload({ ...payload, resetSafetyReason: 'reset' }, adapters), /cannot execute/);
assert.equal(calls, 1);
const repairPayload = { ...payload, ...parseTestProfileArguments(['repair-install']) };
delete repairPayload.diagnoseStudio;
const repairAdapters = {
  ...adapters,
  async execute(_node, args) {
    calls++;
    assert.deepEqual(args, [path.join(payload.repo, 'scripts', 'studio-install-repair.mjs')]);
    return 0;
  },
};
assert.equal(await runTestProfilePayload(repairPayload, repairAdapters), 0);
assert.throws(() => parseTestProfileArguments(['repair-install', '--', 'launch.mjs']), /Usage/);
await assert.rejects(runTestProfilePayload({ ...repairPayload, command: ['launch.mjs'] }, repairAdapters), /cannot execute/);
await assert.rejects(runTestProfilePayload({ ...repairPayload, resetSafetyReason: 'reset' }, repairAdapters), /cannot execute/);
await assert.rejects(runTestProfilePayload({ ...repairPayload, diagnoseStudio: true }, repairAdapters), /cannot execute/);
assert.equal(calls, 2, 'maintenance modes dispatch only their fixed command');
const channel = 'zbuck2release-739-control';
const channelPayload = { ...repairPayload, ...parseTestProfileArguments(['repair-install', '--channel', channel]) };
assert.equal(await runTestProfilePayload(channelPayload, {
  ...repairAdapters,
  async execute(_node, args) {
    calls++;
    assert.deepEqual(args, [path.join(payload.repo, 'scripts', 'studio-install-repair.mjs'), '--channel', channel]);
    return 0;
  },
}), 0);
for (const value of ['', '-silent', '../release', 'C:\\release', 'release --silent', 'release\nsecret', 'a'.repeat(65)]) {
  assert.throws(() => parseTestProfileArguments(['repair-install', '--channel', value]), /Invalid/);
  await assert.rejects(runTestProfilePayload({ ...repairPayload, repairChannel: value }, {
    ...repairAdapters, identity: undefined,
  }), /Invalid repair channel/, 'invalid channels fail before identity access or dispatch');
}
for (const argv of [
  ['repair-install', '--channel', channel, '--', 'launch.mjs'],
  ['repair-install', '--channel', channel, '--reason', 'reset'],
  ['repair-install', '--channel', channel, '--channel', channel],
  ['diagnose', '--channel', channel],
  ['run', '--channel', channel, '--', 'launch.mjs'],
]) assert.throws(() => parseTestProfileArguments(argv), /Usage|Invalid/);
for (const changes of [
  { command: ['launch.mjs'] }, { command: { length: 0 } }, { resetSafetyReason: 'reset' },
  { diagnoseStudio: true }, { confirmDedicatedProfile: true }, { mode: 'enroll' },
  { repairStudio: false }, { repairStudio: undefined },
]) {
  await assert.rejects(runTestProfilePayload({ ...channelPayload, ...changes }, repairAdapters), /cannot execute|requires explicit/);
}
assert.equal(calls, 3, 'invalid and mixed channel repair payloads never dispatch an operation');
const finalizeLog = 'RobloxStudioInstaller_A600A.log';
const finalizePayload = { ...repairPayload, ...parseTestProfileArguments(['repair-install', '--finalize-log', finalizeLog]) };
assert.equal(await runTestProfilePayload(finalizePayload, {
  ...repairAdapters,
  async execute(_node, args) {
    calls++;
    assert.deepEqual(args, [path.join(payload.repo, 'scripts', 'studio-install-repair.mjs'), '--finalize-log', finalizeLog]);
    return 0;
  },
}), 0);
for (const name of ['../RobloxStudioInstaller_A600A.log', 'RobloxStudioInstaller_secret.log', 'C:\\secret.log', '-silent', '']) {
  assert.throws(() => parseTestProfileArguments(['repair-install', '--finalize-log', name]), error => /Invalid/.test(error.message) && !error.message.includes('secret.log'));
  await assert.rejects(runTestProfilePayload({ ...repairPayload, repairFinalizeLog: name }, {
    ...repairAdapters, identity: undefined,
  }), /Invalid repair finalization/);
}
for (const args of [
  ['repair-install', '--finalize-log', finalizeLog, '--channel', channel],
  ['repair-install', '--finalize-log', finalizeLog, '--', 'launch.mjs'],
  ['diagnose', '--finalize-log', finalizeLog],
]) assert.throws(() => parseTestProfileArguments(args), /cannot request|Usage|Invalid/);
for (const changes of [
  { repairChannel: channel }, { repairStudio: undefined }, { diagnoseStudio: true },
  { command: ['launch.mjs'] }, { resetSafetyReason: 'reset' }, { mode: 'enroll' },
]) await assert.rejects(runTestProfilePayload({ ...finalizePayload, ...changes }, repairAdapters), /cannot request|cannot execute|requires explicit/);
assert.equal(calls, 4, 'finalization only dispatches its fixed entrypoint after validating its complete payload');
console.log('Read-only Studio installation diagnostics passed.');
