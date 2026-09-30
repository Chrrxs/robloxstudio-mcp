#!/usr/bin/env node
// Offline only: no native commands, downloads, installer dispatch or timers.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, appendFileSync, statSync, existsSync, symlinkSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { repairStudioInstallation, readFreshInstallerEvidence, parseStudioRepairArguments, finalizeStudioRepair, parseCompletedInstallerLog, updateStudioInstallation } from '../scripts/studio-install-repair.mjs';
import { studioSignInSessions, waitForStudioSignIn } from '../scripts/studio-sign-in.mjs';
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
  const calls = { downloads: 0, starts: 0, unrefs: 0, polls: 0, checks: 0, logs: [], installerArgs: [], prefetches: [], order: [] };
  let time = 1_000_000;
  const adapters = {
    platform: 'win32', assertProfile: () => identity,
    maintenance: async (_env, operation) => operation(), processes: async () => [],
    prepare: () => 'C:\\Users\\StudioTests\\AppData\\Local\\Temp\\fresh\\RobloxStudioInstaller.exe',
    download: async () => { calls.downloads += 1; calls.order.push('installer-download'); },
    resolveTarget: async () => ({ version: 'version-0123456789abcdef' }),
    waitSignIn: async ({ logsRoot, since }) => {
      assert.equal(logsRoot, path.win32.join(identity.localAppData, 'Roblox', 'logs'));
      calls.order.push(['sign-in', since]);
      return 'success';
    },
    prefetch: async ({ localAppData, version }) => {
      calls.prefetches.push({ localAppData, version });
      calls.order.push('prefetch');
      return { packages: 34, downloaded: 18 };
    },
    verifySignature: () => ({ status: 'Valid', signer: 'Roblox Corporation' }),
    snapshot: () => new Map(),
    evidence: () => { calls.polls += 1; return { success: true, failure: false, paths: ['fresh.log'] }; },
    start: async (_installer, _env, args) => {
      calls.starts += 1;
      calls.installerArgs.push(args);
      calls.order.push('dispatch');
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
  // BITS never runs for the secondary-logon account: packages must be cached first.
  assert.deepEqual(test.calls.prefetches, [{ localAppData: identity.localAppData, version: 'version-0123456789abcdef' }]);
  // The installer's Studio may only be ended after its sign-in settled.
  assert.deepEqual(test.calls.order, ['prefetch', 'installer-download', 'dispatch', ['sign-in', 1_000_000]]);
}
{
  const test = fixture();
  const options = parseStudioRepairArguments(['--channel', 'zbuck2release-739-control']);
  await test.run(env, options);
  assert.deepEqual(test.calls.installerArgs, [['-channel', 'zbuck2release-739-control']]);
  assert.equal(test.calls.downloads, 1);
  assert.equal(test.calls.starts, 1);
  assert.deepEqual(test.calls.prefetches, [], 'unauthenticated lookup cannot resolve another channel');
}
{
  // A failed prefetch stops before downloading or dispatching an installer that would hang on BITS.
  const test = fixture({ prefetch: async () => { throw new Error('Studio package RobloxStudio.zip failed size or MD5 verification.'); } });
  await assert.rejects(test.run(), /during package prefetch: Studio package RobloxStudio\.zip failed size or MD5/);
  assert.equal(test.calls.downloads, 0);
  assert.equal(test.calls.starts, 0);
  assert.deepEqual(test.calls.order, [], 'nothing was dispatched, so there is no sign-in to wait for');
}
assert.deepEqual(parseStudioRepairArguments(['--if-outdated']), { ifOutdated: true });
assert.throws(() => parseStudioRepairArguments(['--if-outdated', 'x']), /accepts only/);
{
  // Pre-run update supervisor: current installs are untouched; outdated ones are
  // updated once inside the active run, with the installer admitted as one
  // launch in a worker job that is always drained afterwards.
  const root = mkdtempSync(path.join(tmpdir(), 'rsmcp-update-'));
  try {
    const localAppData = path.join(root, 'Local');
    let installedVersion = 'version-1111111111111111';
    const events = [];
    const base = (overrides = {}) => ({
      platform: 'win32', assertProfile: () => ({ ...identity, localAppData }),
      assertRunActive: (runEnv) => { assert.equal(runEnv, env); events.push('run-active'); },
      admitLaunch: async (runEnv, cost, operation) => {
        assert.equal(runEnv, env);
        events.push(['admit', cost]);
        const result = await operation();
        assert.deepEqual(result, { pid: 42 }, 'launch admission sees a successful process launch');
        return result;
      },
      resolveTarget: async () => ({ version: 'version-2222222222222222' }),
      installed: () => `C:\\Versions\\${installedVersion}\\RobloxStudioBeta.exe`,
      jobOptions: childEnv => ({ env: { ...childEnv, BASE: '1' }, cwd: 'C:\\', toWindowsPath: value => value }),
      createJob: async () => ({ environment: { RSMCP_STUDIO_TEST_WORKER_JOB: 'job' }, drain: async () => { events.push('drain'); } }),
      launch: async (installer, args, cwd, options) => {
        events.push(['launch', installer, args, cwd, options.env.RSMCP_STUDIO_TEST_WORKER_JOB, options.env.BASE]);
        return 42;
      },
      repair: async (_env, adapters) => {
        assert.deepEqual(await adapters.resolveTarget(), { version: 'version-2222222222222222' });
        await adapters.maintenance(env, async () => {
          const child = await adapters.start('C:\\Temp\\x\\RobloxStudioInstaller.exe', { A: '1' }, []);
          assert.equal(child.failed(), false);
        });
        installedVersion = 'version-2222222222222222';
        events.push('repaired');
        return {};
      },
      log: text => events.push(text),
      now: () => 0,
      ...overrides,
    });
    installedVersion = 'version-2222222222222222';
    assert.deepEqual(await updateStudioInstallation(env, base({ createJob: async () => assert.fail('current install must not update') })),
      { updated: false, version: 'version-2222222222222222' });
    await assert.rejects(updateStudioInstallation(env, base({ assertRunActive: () => { throw new Error('Studio test safety blocked: run_inactive.'); } })),
      /run_inactive/, 'the update only runs inside a live profile run');
    events.length = 0;
    installedVersion = 'version-1111111111111111';
    assert.deepEqual(await updateStudioInstallation(env, base()), { updated: true, version: 'version-2222222222222222' });
    assert.deepEqual(events.filter(event => typeof event !== 'string' || !event.startsWith('STUDIO')), [
      'run-active', 'run-active', ['admit', 1],
      ['launch', 'C:\\Temp\\x\\RobloxStudioInstaller.exe', [], 'C:\\Temp\\x', 'job', '1'], 'repaired', 'drain',
    ]);
    // An unreachable version service never blocks a run.
    events.length = 0;
    assert.deepEqual(await updateStudioInstallation(env, base({ resolveTarget: async () => { throw new Error('offline'); } })),
      { updated: false, reason: 'target-unavailable' });
    // A failed update drains the worker, keeps the installed version, and does not fail the run.
    events.length = 0;
    installedVersion = 'version-1111111111111111';
    assert.deepEqual(await updateStudioInstallation(env, base({
      resolveTarget: async () => ({ version: 'version-3333333333333333' }),
      repair: async () => { throw new Error('Studio repair failed during download.'); },
    })), { updated: false, version: 'version-1111111111111111', reason: 'failed' });
    assert.equal(events.at(-2), 'drain');
    assert.match(events.at(-1), /STUDIO UPDATE NOT COMPLETED: Studio repair failed during download/);
    // Unknown process ownership after the update is never ignored.
    await assert.rejects(updateStudioInstallation(env, base({
      resolveTarget: async () => ({ version: 'version-3333333333333333' }),
      createJob: async () => ({ environment: {}, drain: async () => { throw new Error('Studio worker job did not drain'); } }),
    })), /did not drain/);
    // A failed attempt is not recorded, so the next run retries the same target.
    events.length = 0;
    installedVersion = 'version-1111111111111111';
    assert.deepEqual(await updateStudioInstallation(env, base({
      resolveTarget: async () => ({ version: 'version-3333333333333333' }),
      repair: async () => { installedVersion = 'version-3333333333333333'; return {}; },
    })), { updated: true, version: 'version-3333333333333333' });
    // A completed update blocked only by an earlier attempt's stale markers is
    // finalized automatically for that exact log, after the worker is drained.
    for (const outcome of ['finalized', 'refused']) {
      events.length = 0;
      installedVersion = 'version-1111111111111111';
      const finalized = [];
      const result = await updateStudioInstallation(env, base({
        resolveTarget: async () => ({ version: 'version-6666666666666666' }),
        repair: async () => {
          throw Object.assign(new Error('Studio repair failed during installation completion: Completed installer RobloxStudioInstaller_DFECD.log'),
            { completedLog: 'RobloxStudioInstaller_DFECD.log' });
        },
        processes: async () => { events.push('idle-check'); return []; },
        finalize: async (options) => {
          assert.equal(events.at(-1), 'drain', 'finalization waits for the drained worker');
          await options.assertIdle();
          finalized.push({ logName: options.logName, localAppData: options.localAppData, safetyRoot: options.safetyRoot });
          if (outcome === 'refused') throw new Error('Repair finalization refuses nonempty or non-stale download markers.');
          installedVersion = 'version-6666666666666666';
          return { quarantined: 1, quarantine: 'C:\\quarantine' };
        },
      }));
      assert.deepEqual(finalized, [{
        logName: 'RobloxStudioInstaller_DFECD.log', localAppData,
        safetyRoot: path.win32.join(localAppData, 'robloxstudio-mcp', 'test-safety'),
      }]);
      assert.ok(events.includes('idle-check'));
      assert.deepEqual(result, outcome === 'finalized'
        ? { updated: true, version: 'version-6666666666666666' }
        : { updated: false, version: 'version-1111111111111111', reason: 'failed' });
    }
    // An installer that picks another channel's version is not repeated every run.
    events.length = 0;
    installedVersion = 'version-1111111111111111';
    const other = base({
      resolveTarget: async () => ({ version: 'version-4444444444444444' }),
      repair: async () => { installedVersion = 'version-5555555555555555'; return {}; },
    });
    assert.deepEqual(await updateStudioInstallation(env, other), { updated: true, version: 'version-5555555555555555' });
    assert.deepEqual(await updateStudioInstallation(env, { ...other, createJob: async () => assert.fail('must not repeat') }),
      { updated: false, version: 'version-5555555555555555', reason: 'previous-attempt' });
  } finally { rmSync(root, { recursive: true, force: true }); }
}
{
  // Sign-in settling reads only event names and times from new Studio session logs.
  const root = mkdtempSync(path.join(tmpdir(), 'rsmcp-sign-in-'));
  try {
    const base = Date.now();
    const since = base - 1000;
    const iso = offset => new Date(base + offset).toISOString();
    const log = (name, lines) => writeFileSync(path.join(root, name), lines.map(([offset, text]) => `${iso(offset)},0.8,766c,6,Info ${text}`).join('\r\n'));
    const start = '[FLog::StudioKeyEvents] login (automatic) [start]';
    const success = '[FLog::StudioKeyEvents] login [end][success]';
    const clock = { time: base };
    const timing = { now: () => clock.time, sleep: async ms => { clock.time += ms; } };
    const run = async (options = {}) => { clock.time = base + (options.at ?? 10_000); return waitForStudioSignIn({ logsRoot: root, since, ...timing, ...options }); };
    assert.equal(await waitForStudioSignIn({ logsRoot: path.join(root, 'missing'), since, ...timing }), 'none');
    assert.equal(await run(), 'none', 'no installer Studio appeared');
    assert.ok(clock.time >= base + 10_000 + 30_000, 'waits for the installer Studio to appear');
    assert.equal(await run({ appearMs: 0 }), 'none', 'worker cleanup does not wait for Studios that never started');
    const session = '0.741.19.7411056_20260930T150353Z_Studio_6FDD2_last.log';
    log(session, [[0, '[FLog::PluginLoadingEnhanced] noise'], [800, start]]);
    writeFileSync(path.join(root, 'RobloxStudioInstaller_8FF59.log'), start);
    assert.deepEqual(studioSignInSessions(root, since).map(({ name, started, outcome, endedAt }) => ({ name, started, outcome, endedAt })),
      [{ name: session, started: true, outcome: null, endedAt: null }]);
    assert.equal(await run(), 'timeout', 'a sign-in in progress is never cut short');
    assert.ok(clock.time >= base + 10_000 + 120_000);
    log(session, [[800, start], [1000, success]]);
    assert.equal(await run({ at: 2_000 }), 'success');
    assert.equal(clock.time, base + 6_000, 'only the rest of the persistence period after the end is waited');
    assert.equal(await run({ at: 60_000 }), 'success');
    assert.equal(clock.time, base + 60_000, 'a long-settled sign-in costs no wait');
    // Play-test children never sign in: settled once no longer young.
    log('0.741.19.7411056_20260930T150400Z_Studio_AAAA1_last.log', [[2000, '[FLog::Network] server started']]);
    assert.equal(await run({ at: 60_000 }), 'success');
    log('0.741.19.7411056_20260930T150404Z_Studio_9336C_last.log', [[3000, start], [3100, '[FLog::StudioKeyEvents] login [end][failure]']]);
    assert.equal(await run({ at: 60_000 }), 'failure');
    assert.deepEqual(studioSignInSessions(root, Date.now() + 60_000), [], 'older sessions are ignored');
  } finally { rmSync(root, { recursive: true, force: true }); }
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
  // A durable terminal receipt is not merely bootstrapper success: waiting
  // cannot clear a stale marker, and only explicit finalization may move it.
  const logName = 'RobloxStudioInstaller_ABC12.log';
  const test = fixture({
    evidence: () => ({
      success: true, failure: false, paths: [path.win32.join(identity.localAppData, 'Roblox', 'logs', logName)],
      completed: [{ logName, version: 'version-574ecee7ee2b4e60', startedAt: 1_000_000, completedAt: 1_000_000 }],
    }),
    installed: () => { test.calls.checks += 1; throw new Error('unfinished .crdownload fixture-secret'); },
  });
  await assert.rejects(test.run(), error => {
    assert.match(error.message, /--finalize-log RobloxStudioInstaller_ABC12\.log/);
    assert.equal(error.completedLog, logName, 'automated updates can finalize exactly this validated log');
    assert.doesNotMatch(error.message, /Timed out|fixture-secret/);
    return true;
  });
  assert.ok(test.time() - 1_000_000 < 1000, 'durable completion with an incomplete installation must not consume the 600000ms timeout');
  assert.equal(test.calls.checks, 1, 'do not repeatedly select a permanently incomplete installation');
  assert.equal(test.calls.starts, 1);
  assert.equal(test.calls.unrefs, 1);
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

  {
    const logName = 'RobloxStudioInstaller_ABC12.log';
    const records = completedLog.split('\n');
    const expected = { logName, ...parseCompletedInstallerLog(completedLog, finalizeNow) };
    for (const scenario of [
      { name: 'terminal-receipt', files: [[logName, completedLog]], completed: [expected] },
      { name: 'bootstrapper-only', files: [[logName, records.slice(0, 3).join('\n')]], completed: [] },
      {
        name: 'split-receipt',
        files: [[logName, records.slice(0, 2).join('\n')], ['RobloxStudioInstaller_DEF34.log', records.slice(2).join('\n')]],
        completed: [],
      },
      { name: 'old-run-fresh-file', files: [[logName, completedLog]], startedAt: finalizeStart + 30_000, completed: [] },
      // Installer timestamps are whole-second process start + offset (.188 here);
      // a dispatch later in that same second is still this run's receipt.
      { name: 'same-second-dispatch', files: [[logName, completedLog]], startedAt: finalizeStart + 500, completed: [expected] },
      { name: 'next-second-dispatch', files: [[logName, completedLog]], startedAt: finalizeStart + 1000, completed: [] },
      { name: 'expired-receipt', files: [[logName, completedLog]], now: finalizeNow + 3_600_000, completed: [] },
      { name: 'unsafe-basename', files: [['RobloxStudioInstaller_secret-ticket.log', completedLog]], completed: [] },
      { name: 'terminal-failure', files: [[logName, `${completedLog}\nReporting Installer Failure`]], completed: [] },
    ]) {
      const root = path.join(directory, scenario.name);
      mkdirSync(root);
      for (const [name, text] of scenario.files) writeFileSync(path.join(root, name), text);
      const fresh = readFreshInstallerEvidence(root, new Map(), scenario.startedAt ?? finalizeStart, scenario.now ?? finalizeNow);
      assert.deepEqual(fresh.completed, scenario.completed, `${scenario.name}: completion must belong to one safe, fresh, terminally successful log`);
      assert.equal(JSON.stringify(fresh.completed).includes('secret-ticket'), false);
    }

    const root = path.join(directory, 'old-run-appended-log');
    mkdirSync(root);
    const file = path.join(root, logName);
    writeFileSync(file, completedLog);
    const previous = statSync(file);
    const baseline = new Map([[file, {
      size: previous.size, modified: previous.mtimeMs, created: previous.birthtimeMs, inode: previous.ino,
    }]]);
    assert.deepEqual(readFreshInstallerEvidence(root, baseline, finalizeStart + 30_000, finalizeNow).completed, [],
      'unchanged baseline receipt is not evidence for this repair');
    appendFileSync(file, '\nUnrelated progress, ticket=fixture-secret\n');
    const fresh = readFreshInstallerEvidence(root, baseline, finalizeStart + 30_000, finalizeNow);
    assert.equal(fresh.success, false);
    assert.deepEqual(fresh.completed, [], 'new appended bytes cannot revive an old completed receipt');
    assert.equal(JSON.stringify(fresh).includes('fixture-secret'), false);
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
    if (mutation === 'symlink') {
      rmSync(target.marker);
      // Junctions exercise reparse-point rejection without requiring Windows
      // Developer Mode or the privilege needed to create file symlinks.
      symlinkSync(process.platform === 'win32' ? path.dirname(target.settings) : target.settings,
        target.marker, process.platform === 'win32' ? 'junction' : 'file');
    }
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
