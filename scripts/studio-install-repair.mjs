#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { closeSync, createWriteStream, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { assertStudioTestProfile, selectInstalledStudioExecutable } from './studio-lifecycle.mjs';
import { withStudioTestMaintenance } from './studio-test-safety.mjs';

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

export function readFreshInstallerEvidence(logsRoot, baseline, startedAt) {
  let success = false;
  let failure = false;
  const paths = [];
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
    paths.push(file);
    success ||= SUCCESS.test(text);
    failure ||= FAILURE.test(text);
  }
  return { success, failure, paths };
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

export function parseCompletedInstallerLog(text, now) {
  const records = text.split(/\r?\n/u).flatMap(line => {
    const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z),.*\[FLog::DesktopInstaller\] (.*)$/u.exec(line);
    return match ? [{ time: Date.parse(match[1]), message: match[2] }] : [];
  });
  const versions = records.flatMap(record => {
    const match = /^Current version: \d+(?:\.\d+){3} and version GUID: (version-[a-f0-9]{16})$/u.exec(record.message);
    return match ? [match[1]] : [];
  });
  const currentVersionLines = records.filter(record => record.message.startsWith('Current version:'));
  const successes = records.filter(record => record.message === 'Reporting Installer Success');
  const completions = records.filter(record => record.message === 'Installer thread completed successfully');
  const startedAt = records[0]?.time;
  const completedAt = completions[0]?.time;
  if (versions.length !== 1 || currentVersionLines.length !== 1 || successes.length !== 1 || completions.length !== 1 ||
      !Number.isFinite(startedAt) || !Number.isFinite(completedAt) ||
      startedAt > successes[0].time || successes[0].time > completedAt ||
      completedAt > now || now - startedAt >= 60 * 60 * 1000 || FAILURE.test(text)) {
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
      child = await start(installer, env, installerArgs, spawnProcess);
      stage = 'installation completion';
      let success = false;
      while (now() < deadline) {
        if (child.failed()) throw new Error('Installer process could not continue.');
        const fresh = evidence(logsRoot, baseline, startedAt);
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
        // Bootstrapper exit is not completion: its updater may still be running.
        await sleep(Math.min(POLL_MS, Math.max(0, deadline - now())));
      }
      throw new Error('Timed out after 10 minutes without fresh installer success AND a complete newest installation. No retry was attempted.');
    } catch (error) {
      const known = /^(?:Dedicated account|Installer signature must|Fresh installer log|Timed out after|Installer process could|Repair finalization)/.test(error?.message ?? '');
      throw new Error(`Studio repair failed during ${stage}: ${known ? error.message : 'native operation failed (details withheld to avoid exposing account data).' } Retained installer: ${installer ?? '(not downloaded)'}. Installer log directory: ${logsRoot}. Safety state was not reset.`);
    } finally {
      // Allow the containing WTI job to close residual UI only after our final
      // verdict. On timeout/failure this also permits outer job cleanup to run.
      child?.unref();
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await repairStudioInstallation(process.env, {}, parseStudioRepairArguments(process.argv.slice(2)));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
