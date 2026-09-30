#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { closeSync, createWriteStream, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { assertStudioTestProfile, selectInstalledStudioExecutable, workerJobOptions } from './studio-lifecycle.mjs';
import { prefetchStudioPackages, resolveStudioTargetVersion } from './studio-package-cache.mjs';
import { waitForStudioSignIn } from './studio-sign-in.mjs';
import { assertStudioTestRunActive, withStudioTestLaunch, withStudioTestMaintenance } from './studio-test-safety.mjs';
import { createStudioWorkerJob, launchInStudioWorkerJob } from './studio-worker-job.mjs';

export const STUDIO_INSTALLER_URL = 'https://setup.rbxcdn.com/RobloxStudioInstaller.exe';
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
const POLL_MS = 1000;
const SUCCESS = /Installer thread completed successfully|Reporting Installer Success/;
const FAILURE = /Reporting Installer Failure|Installer thread completed with Failure "|Uncaught exception occurred/;

export function validateStudioRepairChannel(channel) {
  if (channel !== undefined && (typeof channel !== 'string' || channel.length > 64 ||
      !/^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/u.test(channel))) {
    throw new Error('Invalid repair channel: use 1–64 alphanumeric characters separated by hyphens.');
  }
  return channel;
}

export function validateStudioFinalizeLog(name) {
  if (name !== undefined && (typeof name !== 'string' || !/^RobloxStudioInstaller_[A-Fa-f0-9]{1,32}\.log$/u.test(name))) {
    throw new Error('Invalid repair finalization log: expected a RobloxStudioInstaller_HEX.log basename.');
  }
  return name;
}

export function parseStudioRepairArguments(argv) {
  if (argv.length === 0) return {};
  if (argv.length === 1 && argv[0] === '--if-outdated') return { ifOutdated: true };
  if (argv.length !== 2 || !['--channel', '--finalize-log'].includes(argv[0]) || argv[1] === undefined) {
    throw new Error('Installation repair accepts only --channel name OR --finalize-log basename; no commands or installer arguments.');
  }
  return argv[0] === '--channel'
    ? { channel: validateStudioRepairChannel(argv[1]) }
    : { finalizeLog: validateStudioFinalizeLog(argv[1]) };
}

function normalized(value) {
  return typeof value === 'string' && /^[A-Za-z]:[\\/]/u.test(value)
    ? path.win32.normalize(value).replace(/[\\/]$/u, '').toLowerCase() : undefined;
}

function nativeJson(script, env) {
  const executable = path.win32.join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const encoded = Buffer.from(`$ErrorActionPreference = 'Stop'; ${script}`, 'utf16le').toString('base64');
  const output = execFileSync(executable, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    env, encoding: 'utf8', windowsHide: true, timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(output.trim());
}

function accountProcesses(env, sid) {
  const result = nativeJson([
    '$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
    '$owned = @()',
    'foreach ($process in @(Get-CimInstance Win32_Process -Filter "Name LIKE \'RobloxStudio%\' OR Name LIKE \'Roblox%Installer%\'")) { $owner = Invoke-CimMethod -InputObject $process -MethodName GetOwnerSid; if ($owner.ReturnValue -ne 0 -or -not $owner.Sid) { throw "Cannot establish process ownership" }; if ($owner.Sid -eq $sid) { $owned += [int]$process.ProcessId } }',
    '[pscustomobject]@{ sid = $sid; pids = @($owned) } | ConvertTo-Json -Compress',
  ].join('; '), env);
  if (result.sid !== sid || !Array.isArray(result.pids) || result.pids.some(pid => !Number.isSafeInteger(pid) || pid <= 0)) {
    throw new Error('Unable to verify dedicated-account process ownership.');
  }
  return result.pids;
}

function signature(installer, env) {
  return nativeJson([
    '$signature = Get-AuthenticodeSignature -LiteralPath $env:RSMCP_REPAIR_INSTALLER',
    '$name = if ($null -ne $signature.SignerCertificate) { $signature.SignerCertificate.GetNameInfo([Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false) } else { "" }',
    '[pscustomobject]@{ status = [string]$signature.Status; signer = $name } | ConvertTo-Json -Compress',
  ].join('; '), { ...env, RSMCP_REPAIR_INSTALLER: installer });
}

function prepareDownload(temp) {
  mkdirSync(temp, { recursive: true });
  if (lstatSync(temp).isSymbolicLink() || normalized(realpathSync(temp)) !== normalized(temp)) {
    throw new Error('Repair TEMP must be an ordinary dedicated-account directory.');
  }
  return path.join(mkdtempSync(path.join(temp, 'rsmcp-studio-repair-')), 'RobloxStudioInstaller.exe');
}

async function downloadInstaller(installer) {
  // Never follow a redirect to an unapproved host or reuse an old executable.
  const response = await fetch(STUDIO_INSTALLER_URL, { redirect: 'error', signal: AbortSignal.timeout(120_000) });
  if (!response.ok || !response.body) throw new Error('Official installer download failed.');
  await pipeline(Readable.fromWeb(response.body), createWriteStream(installer, { flags: 'wx', mode: 0o600 }));
}

function logSnapshot(logsRoot) {
  const files = new Map();
  let entries;
  try { entries = readdirSync(logsRoot, { withFileTypes: true }); }
  catch (error) { if (error?.code === 'ENOENT') return files; throw error; }
  for (const entry of entries) {
    if (!entry.isFile() || !/^RobloxStudioInstaller.*\.log$/i.test(entry.name)) continue;
    const file = path.join(logsRoot, entry.name);
    const stat = lstatSync(file);
    files.set(file, { size: stat.size, modified: stat.mtimeMs, created: stat.birthtimeMs, inode: stat.ino });
  }
  return files;
}

export function readFreshInstallerEvidence(logsRoot, baseline, startedAt, now = Date.now()) {
  let success = false;
  let failure = false;
  const paths = [];
  const completed = [];
  for (const [file, current] of logSnapshot(logsRoot)) {
    const previous = baseline.get(file);
    if (previous && current.size === previous.size && current.modified === previous.modified) continue;
    if (!previous && current.modified < startedAt && current.created < startedAt) continue;
    // Existing logs can contain an old success. Only appended bytes count;
    // replaced/truncated logs start at zero. Never print any raw log content.
    const sameFile = previous && previous.inode === current.inode && previous.created === current.created;
    const offset = sameFile && current.size >= previous.size ? previous.size : 0;
    const length = Math.min(current.size - offset, 512 * 1024);
    const buffer = Buffer.alloc(length);
    const fd = openSync(file, 'r');
    let text;
    try { text = buffer.subarray(0, readSync(fd, buffer, 0, length, current.size - length)).toString('utf8'); }
    finally { closeSync(fd); }
    if (current.size <= 512 * 1024) {
      try {
        const logName = path.basename(file);
        validateStudioFinalizeLog(logName);
        const receipt = parseCompletedInstallerLog(readFileSync(file, 'utf8'), now);
        // Installer timestamps are the process start truncated to the whole
        // second plus an offset, so a receipt for this dispatch can appear to
        // start up to one second before the supervisor's own clock reading.
        if (receipt.startedAt >= Math.floor(startedAt / 1000) * 1000) completed.push({ logName, ...receipt });
      } catch {
        // Bootstrapper success, old receipts and partial logs are not completion.
      }
    }
    paths.push(file);
    success ||= SUCCESS.test(text);
    failure ||= FAILURE.test(text);
  }
  return { success, failure, paths, completed };
}

function samePath(left, right) {
  return process.platform === 'win32'
    ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
    : path.resolve(left) === path.resolve(right);
}

function ordinaryRepairPath(file, directory, env) {
  const info = lstatSync(file);
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile()) ||
      !samePath(realpathSync(file), file)) {
    throw new Error('Repair finalization requires ordinary files and directories without redirects.');
  }
  if (process.platform === 'win32' && nativeJson(
    '[bool]((Get-Item -LiteralPath $env:RSMCP_REPAIR_PATH -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) | ConvertTo-Json',
    { ...env, RSMCP_REPAIR_PATH: file },
  )) throw new Error('Repair finalization refuses reparse points.');
  return info;
}

function unchangedRepairFile(before, after) {
  return before.dev === after.dev && before.ino === after.ino && before.size === after.size &&
    before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs && before.birthtimeMs === after.birthtimeMs;
}

// Structural facts only (counts and timestamps), never log content, so the
// read-only diagnostics can explain why a receipt is or is not a completion.
export function installerReceiptFacts(text) {
  const records = text.split(/\r?\n/u).flatMap(line => {
    const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z),.*\[FLog::DesktopInstaller\] (.*)$/u.exec(line);
    return match ? [{ time: Date.parse(match[1]), message: match[2] }] : [];
  });
  const versions = records.flatMap(record => {
    const match = /^Current version: \d+(?:\.\d+){3} and version GUID: (version-[a-f0-9]{16})$/u.exec(record.message);
    return match ? [match[1]] : [];
  });
  return {
    records,
    versions,
    currentVersionLines: records.filter(record => record.message.startsWith('Current version:')).length,
    successes: records.filter(record => record.message === 'Reporting Installer Success').map(record => record.time),
    completions: records.filter(record => record.message === 'Installer thread completed successfully').map(record => record.time),
    terminalFailure: FAILURE.test(text),
  };
}

export function parseCompletedInstallerLog(text, now) {
  const { records, versions, currentVersionLines, successes, completions, terminalFailure } = installerReceiptFacts(text);
  const startedAt = records[0]?.time;
  const completedAt = completions[0];
  if (versions.length !== 1 || currentVersionLines !== 1 || successes.length !== 1 || completions.length !== 1 ||
      !Number.isFinite(startedAt) || !Number.isFinite(completedAt) ||
      startedAt > successes[0] || successes[0] > completedAt ||
      completedAt > now || now - startedAt >= 60 * 60 * 1000 || terminalFailure) {
    throw new Error('Repair finalization requires one recent completed successful installer log with one target version and no terminal failure.');
  }
  return { version: versions[0], startedAt, completedAt };
}

export async function finalizeStudioRepair({
  localAppData, safetyRoot, logName, assertIdle, now = Date.now,
  env = process.env, installed = selectInstalledStudioExecutable,
}) {
  validateStudioFinalizeLog(logName);
  if (logName === undefined) throw new Error('Repair finalization requires an explicit installer log.');
  const moved = [];
  let quarantine;
  try {
    await assertIdle();
    const roblox = path.join(localAppData, 'Roblox');
    const logsRoot = path.join(roblox, 'logs');
    const versionsRoot = path.join(roblox, 'Versions');
    for (const directory of [localAppData, roblox, logsRoot, versionsRoot, safetyRoot]) ordinaryRepairPath(directory, true, env);
    const logFile = path.join(logsRoot, logName);
    const logInfo = ordinaryRepairPath(logFile, false, env);
    const checkedAt = now();
    if (logInfo.size === 0 || logInfo.size > 512 * 1024 || logInfo.mtimeMs > checkedAt ||
        checkedAt - logInfo.mtimeMs >= 60 * 60 * 1000) {
      throw new Error('Repair finalization requires a bounded installer log modified within the last hour.');
    }
    const completion = parseCompletedInstallerLog(readFileSync(logFile, 'utf8'), checkedAt);
    const directory = path.join(versionsRoot, completion.version);
    ordinaryRepairPath(directory, true, env);
    const executable = path.join(directory, 'RobloxStudioBeta.exe');
    const settings = path.join(directory, 'AppSettings.xml');
    const required = [executable, settings].map(file => {
      const info = ordinaryRepairPath(file, false, env);
      if (info.size === 0) throw new Error('Repair finalization requires nonempty executable and AppSettings.xml.');
      return { file, info };
    });
    const markers = readdirSync(directory).filter(name => /\.crdownload$/i.test(name)).map(name => {
      const file = path.join(directory, name);
      const info = ordinaryRepairPath(file, false, env);
      if (info.size !== 0 || info.mtimeMs >= completion.startedAt) {
        throw new Error('Repair finalization refuses nonempty or non-stale download markers.');
      }
      return { file, info };
    });
    if (!markers.length || markers.length > 16) throw new Error('Repair finalization requires 1–16 stale download markers.');
    await assertIdle();
    // Recheck all evidence immediately before the first mutation.
    for (const directoryPath of [localAppData, roblox, logsRoot, versionsRoot, directory, safetyRoot]) ordinaryRepairPath(directoryPath, true, env);
    for (const item of [{ file: logFile, info: logInfo }, ...required, ...markers]) {
      if (!unchangedRepairFile(item.info, ordinaryRepairPath(item.file, false, env))) {
        throw new Error('Repair finalization evidence changed before quarantine.');
      }
    }
    quarantine = mkdtempSync(path.join(safetyRoot, 'installer-finalize-'));
    for (const marker of markers) {
      if (!unchangedRepairFile(marker.info, ordinaryRepairPath(marker.file, false, env))) {
        throw new Error('Repair finalization marker changed before quarantine.');
      }
      const destination = path.join(quarantine, path.basename(marker.file));
      renameSync(marker.file, destination);
      moved.push({ source: marker.file, destination });
    }
    await assertIdle();
    for (const item of [{ file: logFile, info: logInfo }, ...required]) {
      if (!unchangedRepairFile(item.info, ordinaryRepairPath(item.file, false, env))) {
        throw new Error('Repair finalization evidence changed after quarantine.');
      }
    }
    if (!samePath(installed(versionsRoot), executable)) {
      throw new Error('Repair finalization target is not the complete newest installation.');
    }
    return { executable, quarantine, quarantined: moved.length, logs: [logFile] };
  } catch (error) {
    let rollbackFailed = false;
    for (const move of moved.toReversed()) {
      try {
        try {
          lstatSync(move.source);
          rollbackFailed = true;
          continue; // Never overwrite a replacement marker.
        } catch (missing) { if (missing?.code !== 'ENOENT') throw missing; }
        renameSync(move.destination, move.source);
      } catch { rollbackFailed = true; }
    }
    if (rollbackFailed) throw new Error(`Repair finalization failed; rollback incomplete. Preserved marker quarantine: ${quarantine}. No safety state was reset.`);
    throw new Error(error?.message?.startsWith('Repair finalization ')
      ? error.message : 'Repair finalization failed; details withheld to avoid exposing account data. Any moved markers were restored.');
  }
}

async function startInstaller(installer, env, args, spawnProcess) {
  // Only the observed channel switch is supported; the default may display UI.
  // Detach from Node's private kill-on-exit job, not the containing WTI job:
  // the outer supervisor owns the installer tree through its cleanup grace.
  const child = spawnProcess(installer, args, { env, cwd: path.dirname(installer), shell: false, detached: true, stdio: 'ignore', windowsHide: false });
  let failed = false;
  child.on('error', () => { failed = true; });
  await once(child, 'spawn');
  return { failed: () => failed, unref: () => child.unref() };
}

export async function repairStudioInstallation(env = process.env, adapters = {}, { channel, finalizeLog } = {}) {
  validateStudioRepairChannel(channel);
  validateStudioFinalizeLog(finalizeLog);
  if (channel !== undefined && finalizeLog !== undefined) throw new Error('Repair finalization cannot request an installer channel.');
  const installerArgs = channel === undefined ? [] : ['-channel', channel];
  const {
    platform = process.platform, assertProfile = assertStudioTestProfile,
    maintenance = withStudioTestMaintenance, processes = accountProcesses,
    prepare = prepareDownload, download = downloadInstaller, verifySignature = signature,
    snapshot = logSnapshot, evidence = readFreshInstallerEvidence,
    start = startInstaller, spawnProcess = spawn, installed = selectInstalledStudioExecutable,
    resolveTarget = resolveStudioTargetVersion, prefetch = prefetchStudioPackages,
    waitSignIn = waitForStudioSignIn,
    now = Date.now, sleep = delay, log = console.log,
  } = adapters;
  if (platform !== 'win32') throw new Error('Studio installation repair requires native Windows under the dedicated profile supervisor.');
  const identity = assertProfile();
  const safetyRoot = path.win32.join(identity.localAppData, 'robloxstudio-mcp', 'test-safety');
  const temp = path.win32.join(identity.localAppData, 'Temp');
  if (normalized(env.RSMCP_STUDIO_TEST_SAFETY_DIR) !== normalized(safetyRoot)
    || normalized(env.LOCALAPPDATA) !== normalized(identity.localAppData)
    || normalized(env.USERPROFILE) !== normalized(identity.profileDirectory)
    || normalized(env.TEMP) !== normalized(temp)) {
    throw new Error('Repair requires the verified dedicated-account environment and profile-global safety root.');
  }
  return maintenance(env, async () => {
    let installer;
    let child;
    let dispatchedAt;
    const logsRoot = path.win32.join(identity.localAppData, 'Roblox', 'logs');
    const versionsRoot = path.win32.join(identity.localAppData, 'Roblox', 'Versions');
    const paths = new Set();
    let stage = 'account process check';
    try {
      if ((await processes(env, identity.sid)).length) throw new Error('Dedicated account has live Studio or installer processes; close them manually before repair.');
      if (finalizeLog !== undefined) {
        stage = 'stale marker finalization';
        const result = await finalizeStudioRepair({
          localAppData: identity.localAppData, safetyRoot, logName: finalizeLog, now, env, installed,
          assertIdle: async () => {
            if ((await processes(env, identity.sid)).length) throw new Error('Repair finalization requires an idle dedicated account.');
          },
        });
        log(`STUDIO REPAIR FINALIZED: completed installation verified; ${result.quarantined} stale marker(s) preserved in ${result.quarantine}. No installer or Studio was launched. Safety state is unchanged.`);
        return result;
      }
      if (channel === undefined) {
        // The installer's own package downloads use BITS, which never runs for
        // this secondary-logon account. Fill its cache so it needs none.
        stage = 'package prefetch';
        const target = await resolveTarget();
        const cache = await prefetch({ localAppData: identity.localAppData, version: target.version, log });
        log(`Studio ${target.version} packages are cached (${cache.downloaded} of ${cache.packages} downloaded); the installer needs no background downloads.`);
      } else {
        log(`Channel ${channel} packages cannot be prefetched without authentication; if its installer needs background (BITS) downloads it cannot finish under this account.`);
      }
      stage = 'download';
      installer = prepare(temp);
      await download(installer);
      stage = 'Authenticode verification';
      const certificate = await verifySignature(installer, env);
      if (certificate?.status !== 'Valid' || certificate.signer !== 'Roblox Corporation') {
        throw new Error('Installer signature must be Valid and signed by Roblox Corporation.');
      }
      stage = 'pre-dispatch account process check';
      if ((await processes(env, identity.sid)).length) throw new Error('Dedicated account became busy; installer was not started.');
      const baseline = snapshot(logsRoot);
      const startedAt = now();
      const deadline = startedAt + INSTALL_TIMEOUT_MS;
      stage = 'installer dispatch';
      log(`STUDIO REPAIR READY: verified Roblox Corporation installer; dispatching ONCE ${channel === undefined ? 'with no switches' : 'with the explicitly requested channel'}. UI may appear; waiting up to 10 minutes for durable installation completion. Do not stop the supervisor early.`);
      dispatchedAt = now();
      child = await start(installer, env, installerArgs, spawnProcess);
      stage = 'installation completion';
      let success = false;
      while (now() < deadline) {
        if (child.failed()) throw new Error('Installer process could not continue.');
        const fresh = evidence(logsRoot, baseline, startedAt, now());
        for (const file of fresh.paths) paths.add(file);
        if (fresh.failure) throw new Error('Fresh installer log reports explicit failure.');
        success ||= fresh.success;
        if (success) {
          let executable;
          try { executable = installed(versionsRoot); }
          catch { /* An updater may still be committing the newest version. */ }
          if (executable) {
            log('STUDIO REPAIR COMPLETE: fresh installer success and complete newest installation verified; Studio was not launched by this supervisor. Safety state is unchanged.');
            return { executable, installer, logs: [...paths] };
          }
        }
        const completed = fresh.completed?.[0];
        if (completed) {
          throw Object.assign(new Error(
            `Completed installer ${completed.logName}, but installation validation is still blocked. ` +
            'After owned Studio and installer processes close, inspect the diagnostics and use ' +
            `npm run studio:test-repair -- --finalize-log ${completed.logName} ` +
            'to verify and quarantine stale download markers without another download. No retry was attempted.',
          ), { completedLog: completed.logName });
        }
        // Bootstrapper exit is not completion: its updater may still be running.
        await sleep(Math.min(POLL_MS, Math.max(0, deadline - now())));
      }
      throw new Error('Timed out after 10 minutes without fresh installer success AND a complete newest installation. No retry was attempted.');
    } catch (error) {
      const known = /^(?:Dedicated account|Installer signature must|Fresh installer log|Completed installer|Timed out after|Installer process could|Repair finalization|Studio package|Studio version lookup)/.test(error?.message ?? '');
      throw Object.assign(
        new Error(`Studio repair failed during ${stage}: ${known ? error.message : 'native operation failed (details withheld to avoid exposing account data).' } Retained installer: ${installer ?? '(not downloaded)'}. Installer log directory: ${logsRoot}. Safety state was not reset.`),
        // A validated basename only; automated updates may finalize this exact log.
        typeof error?.completedLog === 'string' ? { completedLog: validateStudioFinalizeLog(error.completedLog) } : {},
      );
    } finally {
      // The installer opens Studio when it finishes, and containment ends that
      // Studio after this verdict. Ending it during its automatic Roblox sign-in
      // deletes the account's stored sign-in, so let sign-in settle first.
      if (dispatchedAt !== undefined) {
        const signIn = await waitSignIn({ logsRoot, since: dispatchedAt, now, sleep });
        if (signIn === 'failure') log('Studio opened by the installer could not sign in automatically. A person must sign in to Roblox Studio once under the dedicated account before live tests can run.');
        else if (signIn === 'timeout') log('Studio opened by the installer did not finish signing in within 2 minutes.');
      }
      // Allow the containing WTI job to close residual UI only after our final
      // verdict. On timeout/failure this also permits outer job cleanup to run.
      child?.unref();
    }
  });
}

function readUpdateRecord(file) {
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'));
    return value && typeof value.target === 'string' ? value : undefined;
  } catch { return undefined; }
}

function writeUpdateRecord(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(value));
  renameSync(temporary, file);
}

// Studio's own updater cannot finish under this account: its BITS downloads
// never start for a secondary-logon owner. Bring the installation to the
// production version before any test launch so Studio has nothing to update.
// Runs as a preflight inside the profile run lease (held by the parent), and
// the installer dispatch — which opens Studio when it finishes — is admitted
// as one launch. The installer runs in a worker job, so that Studio is closed
// with the job rather than joining the test run. An update that cannot
// complete leaves the installed version in place and does not fail the run.
export async function updateStudioInstallation(env = process.env, adapters = {}) {
  const {
    platform = process.platform, assertProfile = assertStudioTestProfile,
    assertRunActive = assertStudioTestRunActive, admitLaunch = withStudioTestLaunch,
    resolveTarget = resolveStudioTargetVersion, installed = selectInstalledStudioExecutable,
    repair = repairStudioInstallation, createJob = createStudioWorkerJob, launch = launchInStudioWorkerJob,
    jobOptions = workerJobOptions, log = console.log, now = Date.now,
    finalize = finalizeStudioRepair, processes = accountProcesses,
  } = adapters;
  if (platform !== 'win32') throw new Error('Studio update requires native Windows under the dedicated profile supervisor.');
  const identity = assertProfile();
  assertRunActive(env);
  const versionsRoot = path.win32.join(identity.localAppData, 'Roblox', 'Versions');
  const recordFile = path.join(identity.localAppData, 'robloxstudio-mcp', 'studio-update-attempt.json');
  const installedVersion = () => {
    try { return path.win32.basename(path.win32.dirname(installed(versionsRoot))); }
    catch { return undefined; }
  };
  let target;
  try { target = await resolveTarget(); }
  catch (error) {
    log(`Studio update check skipped (${error.message}); continuing with the installed version.`);
    return { updated: false, reason: 'target-unavailable' };
  }
  const before = installedVersion();
  if (before === target.version) return { updated: false, version: before };
  const previous = readUpdateRecord(recordFile);
  if (before !== undefined && previous?.target === target.version && previous.installed === before) {
    // The official installer chose another version for this account (for
    // example a different enrolled channel). Do not repeat it every run.
    log(`Studio update to ${target.version} already produced ${before} for this account; not repeating it.`);
    return { updated: false, version: before, reason: 'previous-attempt' };
  }
  log(`STUDIO UPDATE: installed ${before ?? '(no complete installation)'}; production is ${target.version}. Updating once before any test launch.`);
  const worker = await createJob(jobOptions(env));
  let failure;
  try {
    // repairStudioInstallation waits for the installer's Studio to finish
    // signing in before returning, so the drain below cannot interrupt it.
    await repair(env, {
      resolveTarget: async () => target, log,
      // The parent's run lease already excludes other runs and maintenance.
      maintenance: async (_env, operation) => { assertRunActive(env); return operation(); },
      start: async (installer, childEnv, args) => {
        const options = jobOptions(childEnv);
        await admitLaunch(env, 1, async () => ({
          pid: await launch(installer, args, path.win32.dirname(installer), { ...options, env: { ...options.env, ...worker.environment } }),
        }));
        return { failed: () => false, unref: () => {} };
      },
    });
  } catch (error) {
    failure = error;
  }
  // Unknown ownership of installer/Studio processes is never ignored.
  await worker.drain();
  if (typeof failure?.completedLog === 'string') {
    // This update's installer completed, but an earlier interrupted attempt
    // (such as Studio's own BITS-blocked updater, stopped at worker cleanup)
    // left zero-byte download markers in the version folder. Finalize exactly
    // this verified log: only regular zero-byte markers older than its start
    // are quarantined, and moves roll back unless the target is then selected.
    try {
      const result = await finalize({
        localAppData: identity.localAppData, logName: failure.completedLog, now, env, installed,
        safetyRoot: path.win32.join(identity.localAppData, 'robloxstudio-mcp', 'test-safety'),
        assertIdle: async () => {
          assertRunActive(env);
          if ((await processes(env, identity.sid)).length) throw new Error('Repair finalization requires an idle dedicated account.');
        },
      });
      log(`Quarantined ${result.quarantined} stale download marker(s) from an interrupted earlier update in ${result.quarantine}.`);
      failure = undefined;
    } catch (error) {
      log(`Automatic finalization of ${failure.completedLog} was refused: ${error.message}`);
    }
  }
  if (failure) {
    log(`STUDIO UPDATE NOT COMPLETED: ${failure.message} Continuing with the installed version; Studio's own update attempt will be stopped at worker cleanup.`);
    return { updated: false, version: installedVersion(), reason: 'failed' };
  }
  const after = installedVersion();
  writeUpdateRecord(recordFile, { target: target.version, installed: after ?? null, at: new Date(now()).toISOString() });
  if (after === target.version) log(`STUDIO UPDATE COMPLETE: ${after} installed; the installer's Studio window was closed.`);
  else log(`Studio installer produced ${after ?? '(no complete installation)'} instead of production ${target.version}; this account may use another channel.`);
  return { updated: true, version: after };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseStudioRepairArguments(process.argv.slice(2));
    if (options.ifOutdated) await updateStudioInstallation(process.env);
    else await repairStudioInstallation(process.env, {}, options);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
