#!/usr/bin/env node
// Offline only: no native commands, downloads, installer dispatch or timers.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, appendFileSync, statSync, existsSync, symlinkSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { repairStudioInstallation, readFreshInstallerEvidence, parseStudioRepairArguments, finalizeStudioRepair, parseCompletedInstallerLog } from '../scripts/studio-install-repair.mjs';
import { createStudioTestSafety, STUDIO_TEST_LAUNCH_COST_LIMIT } from '../scripts/studio-test-safety.mjs';

const identity = {
  sid: 'S-1-5-21-1-2-3-1001', profileDirectory: 'C:\\Users\\StudioTests',
  localAppData: 'C:\\Users\\StudioTests\\AppData\\Local',
};
const env = {
  USERPROFILE: identity.profileDirectory, LOCALAPPDATA: identity.localAppData,
  TEMP: `${identity.localAppData}\\Temp`,
  RSMCP_STUDIO_TEST_SAFETY_DIR: `${identity.localAppData}\\robloxstudio-mcp\\test-safety`,
};
function fixture(overrides = {}) {
  const calls = { downloads: 0, starts: 0, unrefs: 0, polls: 0, checks: 0, logs: [], installerArgs: [] };
  let time = 1_000_000;
  const adapters = {
    platform: 'win32', assertProfile: () => identity,
    maintenance: async (_env, operation) => operation(), processes: async () => [],
    prepare: () => 'C:\\Users\\StudioTests\\AppData\\Local\\Temp\\fresh\\RobloxStudioInstaller.exe',
    download: async () => { calls.downloads += 1; },
    verifySignature: () => ({ status: 'Valid', signer: 'Roblox Corporation' }),
    snapshot: () => new Map(),
    evidence: () => { calls.polls += 1; return { success: true, failure: false, paths: ['fresh.log'] }; },
    start: async (_installer, _env, args) => {
      calls.starts += 1;
      calls.installerArgs.push(args);
      return { failed: () => false, unref: () => { calls.unrefs += 1; } };
    },
    installed: () => { calls.checks += 1; return 'complete\\RobloxStudioBeta.exe'; },
    now: () => time, sleep: async ms => { time += ms; }, log: text => calls.logs.push(text),
    ...overrides,
  };
  return { calls, adapters, run: (environment = env, options = {}) => repairStudioInstallation(environment, adapters, options), time: () => time };
}

{
  const test = fixture();
  assert.equal((await test.run()).executable, 'complete\\RobloxStudioBeta.exe');
  assert.equal(test.calls.downloads, 1);
  assert.equal(test.calls.starts, 1);
  assert.equal(test.calls.unrefs, 1);
  assert.deepEqual(test.calls.installerArgs, [[]], 'default official installer invocation has zero arguments');
}
{
  const test = fixture();
  const options = parseStudioRepairArguments(['--channel', 'zbuck2release-739-control']);
  await test.run(env, options);
  assert.deepEqual(test.calls.installerArgs, [['-channel', 'zbuck2release-739-control']]);
  assert.equal(test.calls.downloads, 1);
  assert.equal(test.calls.starts, 1);
}
{
  // Exercise the production start path at its native spawn boundary, not the
  // fixture's usual start override. Node must leave exit cleanup to the outer
  // supervisor rather than enrolling this GUI child in its private exit job.
  const child = new EventEmitter();
  let unrefs = 0;
  let spawned = false;
  child.unref = () => { unrefs += 1; };
  const test = fixture({
    start: undefined,
    spawnProcess(_executable, args, options) {
      assert.deepEqual(args, ['-channel', 'zbuck2release-739-control']);
      assert.equal(options.detached, true, 'the installer must survive Node parent exit until outer-job cleanup');
      assert.equal(options.shell, false);
      spawned = true;
      queueMicrotask(() => child.emit('spawn'));
      return child;
    },
    evidence() {
      assert.equal(unrefs, 0, 'the supervisor must retain the child through its completion verdict');
      return { success: true, failure: false, paths: ['fresh.log'] };
    },
  });
  await test.run(env, { channel: 'zbuck2release-739-control' });
  assert.equal(spawned, true);
  assert.equal(unrefs, 1, 'release the Node reference only after the completion verdict');
}
for (const channel of ['', '-silent', '../release', 'C:\\release', 'release/test', 'release --silent', 'release"secret', 'release\nsecret', 'a'.repeat(65), null, 42, ['release']]) {
  const test = fixture({ assertProfile: () => assert.fail('Invalid channel must fail before any operation') });
  await assert.rejects(test.run(env, { channel }), /Invalid repair channel/);
  assert.equal(test.calls.downloads, 0);
  assert.equal(test.calls.starts, 0);
}
{
  assert.deepEqual(parseStudioRepairArguments([]), {});
  for (const args of [
    ['--channel'], ['--channel', '../release'], ['--channel', '-silent'],
    ['--channel', 'zbuck2release-739-control', '--', 'suite.mjs'],
    ['--channel', 'release', '--channel', 'other'], ['suite.mjs'],
  ]) {
    assert.throws(() => parseStudioRepairArguments(args), /repair (?:accepts|channel)/);
  }
}
for (const certificate of [{ status: 'NotSigned', signer: 'Roblox Corporation' }, { status: 'Valid', signer: 'Other Corporation' }]) {
  const test = fixture({ verifySignature: () => certificate });
  await assert.rejects(test.run(), /signature must be Valid and signed by Roblox Corporation/);
  assert.equal(test.calls.starts, 0);
}
{
  const test = fixture({ platform: 'linux' });
  await assert.rejects(test.run(), /requires native Windows/);
  assert.equal(test.calls.downloads, 0);
}
{
  const test = fixture();
  await assert.rejects(test.run({ ...env, RSMCP_STUDIO_TEST_SAFETY_DIR: 'C:\\other-profile' }), /verified dedicated-account environment/);
  assert.equal(test.calls.downloads, 0);
}
{
  const test = fixture({ processes: () => [123] });
  await assert.rejects(test.run(), /live Studio or installer processes/);
  assert.equal(test.calls.downloads, 0);
  assert.equal(test.calls.starts, 0);
}
{
  let probes = 0;
  const test = fixture({ processes: () => probes++ === 0 ? [] : [456] });
  await assert.rejects(test.run(), /became busy/);
  assert.equal(test.calls.starts, 0);
}
{
  // The parent has already exited; only the descendant's later log and folder
  // commit may finish this operation. A parent exit status is never a verdict.
  let polls = 0;
  let committed = false;
  const test = fixture({
    start: async () => { test.calls.starts += 1; return { exitCode: 0, failed: () => false, unref() {} }; },
    evidence: () => ({ success: ++polls >= 3, failure: false, paths: ['fresh.log'] }),
    installed: () => { if (!committed) { committed = true; throw new Error('incomplete newest version'); } return 'complete'; },
  });
  assert.equal((await test.run()).executable, 'complete');
  assert.equal(polls, 4);
  assert.equal(test.time(), 1_003_000);
  assert.equal(test.calls.starts, 1);
}
{
  const test = fixture({ evidence: () => ({ success: false, failure: false, paths: [] }) });
  await assert.rejects(test.run(), /Timed out after 10 minutes/);
  assert.equal(test.time(), 1_600_000);
  assert.equal(test.calls.starts, 1);
  assert.equal(test.calls.unrefs, 1);
}
{
  const test = fixture({ installed: () => { throw new Error('unfinished .crdownload'); } });
  await assert.rejects(test.run(), /Timed out after 10 minutes/);
  assert.equal(test.calls.starts, 1);
}
{
  const test = fixture({ evidence: () => ({ success: true, failure: true, paths: ['failure.log'] }) });
  await assert.rejects(test.run(), /Fresh installer log reports explicit failure/);
  assert.equal(test.calls.starts, 1);
  assert.equal(test.calls.checks, 0);
}
{
  const test = fixture({ download: async () => { throw new Error('secret-ticket'); } });
  await assert.rejects(test.run(), error => !error.message.includes('secret-ticket') && error.message.includes('Retained installer:'));
  assert.equal(test.calls.starts, 0);
}

const finalizeStart = Date.parse('2026-09-17T02:07:43.000Z');
const finalizeNow = finalizeStart + 60_000;
const finalizeLogName = 'RobloxStudioInstaller_A600A.log';
const completedLog = [
  '2026-09-17T02:07:43.188Z,0.188162,2e0c,6,Info [FLog::DesktopInstaller] Check Windows version',
  '2026-09-17T02:07:43.290Z,0.290871,2e0c,6,Info [FLog::DesktopInstaller] Current version: 0.739.0.7390691 and version GUID: version-574ecee7ee2b4e60',
  '2026-09-17T02:08:02.267Z,19.267782,2e0c,6,Info [FLog::DesktopInstaller] Reporting Installer Success',
  '2026-09-17T02:08:02.268Z,19.268087,2e0c,6,Info [FLog::DesktopInstaller] Installer thread completed successfully',
].join('\n');
function finalizationFixture(parent, name) {
  const localAppData = path.join(parent, name);
  const safetyRoot = path.join(localAppData, 'safety');
  const logs = path.join(localAppData, 'Roblox', 'logs');
  const versions = path.join(localAppData, 'Roblox', 'Versions');
  const target = path.join(versions, 'version-574ecee7ee2b4e60');
  for (const folder of [safetyRoot, logs, target]) mkdirSync(folder, { recursive: true });
  const logFile = path.join(logs, finalizeLogName);
  const executable = path.join(target, 'RobloxStudioBeta.exe');
  const settings = path.join(target, 'AppSettings.xml');
  const marker = path.join(target, '.crdownload');
  writeFileSync(logFile, completedLog);
  writeFileSync(executable, 'fixture executable');
  writeFileSync(settings, '<Settings/>');
  writeFileSync(marker, '');
  for (const file of [logFile, executable, settings]) utimesSync(file, finalizeStart / 1000 + 20, finalizeStart / 1000 + 20);
  utimesSync(marker, finalizeStart / 1000 - 3600, finalizeStart / 1000 - 3600);
  return {
    localAppData, safetyRoot, logFile, versions, target, executable, settings, marker,
    run: overrides => finalizeStudioRepair({
      localAppData, safetyRoot, logName: finalizeLogName, now: () => finalizeNow, assertIdle: async () => {}, ...overrides,
    }),
  };
}

assert.deepEqual(parseStudioRepairArguments(['--finalize-log', finalizeLogName]), { finalizeLog: finalizeLogName });
for (const name of ['../RobloxStudioInstaller_A600A.log', 'RobloxStudioInstaller_secret.log', '-channel', 'C:\\secret.log', '', null]) {
  assert.throws(() => parseStudioRepairArguments(['--finalize-log', name]), error => /Invalid repair finalization/.test(error.message) && !error.message.includes('secret'));
}
assert.throws(() => parseStudioRepairArguments(['--finalize-log', finalizeLogName, '--channel', 'release']), /accepts only/);
for (const text of [
  completedLog.replace('Installer thread completed successfully', 'Still running'),
  completedLog.replace('Reporting Installer Success', 'Still running'),
  `${completedLog}\nReporting Installer Failure secret-ticket`,
  `${completedLog}\n${completedLog.split('\n')[1]}`,
  completedLog.replace('version-574ecee7ee2b4e60', '../../secret-ticket'),
]) assert.throws(() => parseCompletedInstallerLog(text, finalizeNow), error => /requires one recent/.test(error.message) && !error.message.includes('secret-ticket'));
assert.throws(() => parseCompletedInstallerLog(completedLog, finalizeStart + 3_600_188), /requires one recent/);
{
  const test = fixture();
  await assert.rejects(test.run(env, { finalizeLog: finalizeLogName, channel: 'release' }), /cannot request/);
  assert.equal(test.calls.downloads, 0);
  assert.equal(test.calls.starts, 0);
}

const directory = mkdtempSync(path.join(tmpdir(), 'studio-install-repair-'));
try {
  const logs = path.join(directory, 'logs');
  mkdirSync(logs);
  const old = path.join(logs, 'RobloxStudioInstaller-old.log');
  writeFileSync(old, 'Installer thread completed successfully\n');
  const stat = statSync(old);
  const baseline = new Map([[old, { size: stat.size, modified: stat.mtimeMs, created: stat.birthtimeMs, inode: stat.ino }]]);
  assert.equal(readFreshInstallerEvidence(logs, baseline, stat.mtimeMs).success, false);
  appendFileSync(old, 'Unrelated progress, ticket=fixture-secret\n');
  assert.equal(readFreshInstallerEvidence(logs, baseline, stat.mtimeMs).success, false, 'old success in a changed file cannot pass');
  appendFileSync(old, 'Reporting Installer Success\n');
  const evidence = readFreshInstallerEvidence(logs, baseline, stat.mtimeMs);
  assert.equal(evidence.success, true);
  assert.equal(JSON.stringify(evidence).includes('fixture-secret'), false);
  appendFileSync(old, 'Reporting Installer Failure\n');
  assert.equal(readFreshInstallerEvidence(logs, baseline, stat.mtimeMs).failure, true);
  for (const marker of ['Installer thread completed with Failure "fixture-error"', 'Uncaught exception occurred']) {
    writeFileSync(old, `${marker}\n`);
    assert.equal(readFreshInstallerEvidence(logs, new Map(), 0).failure, true);
  }

  // Exercise real maintenance admission with a blocked/pending/quota fixture.
  const root = path.join(directory, 'safety');
  const safety = createStudioTestSafety({ root, now: () => 1_000_000, sleep: async () => assert.fail('No safety waits expected') });
  await assert.rejects(safety.withStudioTestLaunch(STUDIO_TEST_LAUNCH_COST_LIMIT, () => { throw new Error('interrupted'); }));
  const statePath = path.join(root, 'state.json');
  const before = readFileSync(statePath, 'utf8');
  const test = fixture({ maintenance: (_env, operation) => safety.withStudioTestMaintenance(operation) });
  await test.run();
  assert.equal(readFileSync(statePath, 'utf8'), before);
  const failed = fixture({
    maintenance: (_env, operation) => safety.withStudioTestMaintenance(operation),
    evidence: () => ({ success: false, failure: true, paths: [] }),
  });
  await assert.rejects(failed.run(), /explicit failure/);
  assert.equal(readFileSync(statePath, 'utf8'), before);
  {
    const finalized = finalizationFixture(directory, 'finalize-success');
    const safety = createStudioTestSafety({ root: finalized.safetyRoot, now: () => finalizeNow, sleep: async () => assert.fail('No safety waits expected') });
    await assert.rejects(safety.withStudioTestLaunch(STUDIO_TEST_LAUNCH_COST_LIMIT, () => { throw new Error('blocked'); }));
    const statePath = path.join(finalized.safetyRoot, 'state.json');
    const before = readFileSync(statePath, 'utf8');
    const result = await safety.withStudioTestMaintenance(() => finalized.run());
    assert.equal(result.executable, finalized.executable);
    assert.equal(existsSync(finalized.marker), false);
    assert.equal(statSync(path.join(result.quarantine, '.crdownload')).size, 0);
    assert.equal(readFileSync(statePath, 'utf8'), before, 'finalization preserves block and launch quota');
  }
  for (const mutation of ['nonempty', 'new', 'symlink', 'settings', 'stale-log', 'busy', 'changed']) {
    const target = finalizationFixture(directory, `reject-${mutation}`);
    if (mutation === 'nonempty') writeFileSync(target.marker, 'unfinished');
    if (mutation === 'new') utimesSync(target.marker, finalizeNow / 1000, finalizeNow / 1000);
    if (mutation === 'symlink') { rmSync(target.marker); symlinkSync(target.settings, target.marker); }
    if (mutation === 'settings') writeFileSync(target.settings, '');
    if (mutation === 'stale-log') utimesSync(target.logFile, (finalizeNow - 3_600_000) / 1000, (finalizeNow - 3_600_000) / 1000);
    let checks = 0;
    await assert.rejects(target.run({ assertIdle: async () => {
      checks++;
      if (mutation === 'busy') throw new Error('secret-ticket');
      if (mutation === 'changed' && checks === 2) writeFileSync(target.marker, 'changed');
    } }), error => /Repair finalization/.test(error.message) && !error.message.includes('secret-ticket'));
    assert.equal(existsSync(target.marker), true);
    assert.equal(readdirSync(target.safetyRoot).length, 0, 'rejected evidence cannot create quarantine');
  }
  {
    const target = finalizationFixture(directory, 'rollback-selection');
    const newer = path.join(target.versions, 'version-ffffffffffffffff');
    mkdirSync(newer);
    writeFileSync(path.join(newer, 'RobloxStudioBeta.exe'), 'other version');
    writeFileSync(path.join(newer, 'AppSettings.xml'), '<Settings/>');
    utimesSync(path.join(newer, 'RobloxStudioBeta.exe'), finalizeNow / 1000, finalizeNow / 1000);
    await assert.rejects(target.run(), /not the complete newest/);
    assert.equal(statSync(target.marker).size, 0, 'target mismatch restores quarantined marker');
  }
  {
    const target = finalizationFixture(directory, 'rollback-busy');
    let checks = 0;
    await assert.rejects(target.run({ assertIdle: async () => {
      if (++checks === 3) throw new Error('Repair finalization requires an idle dedicated account.');
    } }), /idle dedicated account/);
    assert.equal(statSync(target.marker).size, 0, 'new account activity restores quarantined marker');
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}
console.log('Studio installer repair offline regressions passed');
