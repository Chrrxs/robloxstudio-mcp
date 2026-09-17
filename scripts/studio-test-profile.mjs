#!/usr/bin/env node

import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isWsl, probeWindowsStudioIdentity, windowsPowerShellEnvironment } from './studio-lifecycle.mjs';
import { validateStudioRepairChannel, validateStudioFinalizeLog } from './studio-install-repair.mjs';
import { prepareStudioTestSnapshot } from './studio-test-snapshot.mjs';
import { resetStudioTestSafety, withStudioTestRun } from './studio-test-safety.mjs';

const USAGE = 'Usage: node scripts/studio-test-profile.mjs setup [--user MACHINE\\StudioTests] [--repo C:\\work\\repo] [--node C:\\path\\node.exe]\n       node scripts/studio-test-profile.mjs run [--user MACHINE\\StudioTests] [--repo C:\\prepared\\repo] -- tests/run-all.mjs [suite arguments]\n       node scripts/studio-test-profile.mjs diagnose [--user MACHINE\\StudioTests]\n       node scripts/studio-test-profile.mjs repair-install [--user MACHINE\\StudioTests] [--channel name | --finalize-log RobloxStudioInstaller_HEX.log]\n       node scripts/studio-test-profile.mjs reset-safety --reason "installation/authentication checked" [--user MACHINE\\StudioTests]\n       node scripts/studio-test-profile.mjs forget [--user MACHINE\\StudioTests]\nDefault account: local StudioTests. Setup authorizes once; run never prompts. Without --repo, the current worktree is exported and built automatically. Diagnosis is read-only. Explicit repair runs the signed official installer once, or finalizes a completed installation without launching, and preserves the safety block. Failed/interrupted live runs block further runs until explicit safety reset; reset preserves launch quota and never launches Studio.';
const USER_SID = /^S-1-5-21-(?:\d+-){3}\d+$/u;

export function parseTestProfileArguments(argv) {
  const [requestedMode, ...args] = argv;
  if (!['setup', 'enroll', 'run', 'reset-safety', 'diagnose', 'repair-install', 'forget'].includes(requestedMode)) throw new Error(USAGE);
  const mode = requestedMode === 'setup' ? 'enroll' : ['reset-safety', 'diagnose', 'repair-install'].includes(requestedMode) ? 'run' : requestedMode;
  const result = { mode, command: [] };
  if (requestedMode === 'setup') result.confirmDedicatedProfile = true;
  if (requestedMode === 'diagnose') result.diagnoseStudio = true;
  if (requestedMode === 'repair-install') result.repairStudio = true;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--') {
      result.command = args.slice(index + 1);
      break;
    }
    if (arg === '--confirm-dedicated-profile') {
      result.confirmDedicatedProfile = true;
      continue;
    }
    const options = { '--user': 'user', '--repo': 'repo', '--node': 'nodeExecutable' };
    if (requestedMode === 'reset-safety') options['--reason'] = 'resetSafetyReason';
    if (requestedMode === 'repair-install') options['--channel'] = 'repairChannel';
    if (requestedMode === 'repair-install') options['--finalize-log'] = 'repairFinalizeLog';
    const key = Object.hasOwn(options, arg) ? options[arg] : undefined;
    if (!key || !args[index + 1] || args[index + 1].startsWith('--') || result[key]) {
      throw new Error(`Invalid or duplicate launcher option ${arg}.\n${USAGE}`);
    }
    result[key] = args[++index];
    if (key === 'repairChannel') validateStudioRepairChannel(result.repairChannel);
    if (key === 'repairFinalizeLog') validateStudioFinalizeLog(result.repairFinalizeLog);
  }
  if (result.repairChannel !== undefined && result.repairFinalizeLog !== undefined) {
    throw new Error('Repair finalization cannot request an installer channel.');
  }
  if (mode === 'enroll' && !result.confirmDedicatedProfile) {
    throw new Error(`enroll requires --confirm-dedicated-profile; use setup for automatic provisioning.\n${USAGE}`);
  }
  if ((['diagnose', 'repair-install'].includes(requestedMode) && (result.command.length || result.confirmDedicatedProfile)) ||
      (requestedMode === 'reset-safety' && (!result.resetSafetyReason?.trim() || result.command.length || result.confirmDedicatedProfile)) ||
      (mode === 'enroll' && result.command.length) ||
      (mode === 'run' && !['reset-safety', 'diagnose', 'repair-install'].includes(requestedMode) && (!result.command.length || result.confirmDedicatedProfile)) ||
      (mode === 'forget' && (result.command.length || result.confirmDedicatedProfile || result.repo || result.nodeExecutable))) {
    throw new Error(USAGE);
  }
  return result;
}

export function encodeTestProfilePayload(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
}

export function createTestProfileEnvironment(identity, { sourceSid, targetSid, nodeExecutable }, inherited = {}) {
  if (!USER_SID.test(sourceSid ?? '') || !USER_SID.test(targetSid ?? '') ||
      sourceSid === targetSid || identity.sid !== targetSid) {
    throw new Error('Refusing to reuse the personal/source Windows identity or an unexpected target SID. Select a separate dedicated Windows account.');
  }
  if (!identity.profileLoaded || !identity.interactiveSession) {
    throw new Error('The test user needs a loaded profile and an interactive Windows desktop. Sign in as that user once; service/session-0 execution cannot run Studio.');
  }
  const profile = identity.profileDirectory;
  if (typeof profile !== 'string' || !/^[A-Za-z]:[\\/]/u.test(profile)) {
    throw new Error('Windows did not report a local profile directory for the target SID.');
  }
  const prefix = `${path.win32.normalize(profile).replace(/[\\/]$/u, '').toLowerCase()}\\`;
  for (const value of [identity.localAppData, identity.roamingAppData]) {
    if (typeof value !== 'string' || !path.win32.normalize(value).toLowerCase().startsWith(prefix)) {
      throw new Error(`Windows reported missing or redirected AppData ${JSON.stringify(value)}; expected a directory inside the actual profile ${JSON.stringify(profile)}. Refusing to use another profile's settings.`);
    }
  }
  const env = {};
  for (const [key, value] of Object.entries(inherited)) {
    if (/^(?:MCP_|RSMCP_|ROBLOXSTUDIO_MCP_|ROBLOX_STUDIO_|NODE_|NPM_CONFIG_|npm_config_)/iu.test(key) ||
        /^(?:USERPROFILE|LOCALAPPDATA|APPDATA|TEMP|TMP|HOME|HOMEDRIVE|HOMEPATH|USERNAME|USERDOMAIN|PATH|PWD|OLDPWD|INIT_CWD|WSLENV|WSL_DISTRO_NAME|WSL_INTEROP|PSModulePath|WinPSModulePath)$/iu.test(key)) continue;
    env[key] = value;
  }
  const account = identity.accountName.split('\\');
  Object.assign(env, {
    USERPROFILE: profile,
    LOCALAPPDATA: identity.localAppData,
    APPDATA: identity.roamingAppData,
    HOME: profile,
    HOMEDRIVE: path.win32.parse(profile).root.replace(/[\\/]$/u, ''),
    HOMEPATH: profile.slice(2),
    USERNAME: account.at(-1),
    USERDOMAIN: account.length > 1 ? account[0] : '',
    TEMP: path.win32.join(identity.localAppData, 'Temp'),
    TMP: path.win32.join(identity.localAppData, 'Temp'),
  });
  const values = new Map(Object.entries(env).map(([key, value]) => [key.toUpperCase(), value]));
  env.PATH = [path.win32.dirname(nodeExecutable), identity.machinePath, identity.userPath]
    .filter(Boolean).join(';').replace(/%([^%]+)%/gu, (match, key) => values.get(key.toUpperCase()) ?? match);
  return env;
}

export function runTestProfileCommand(command, args, options) {
  return new Promise((resolve, reject) => {
    const childOptions = { stdio: 'inherit', ...options };
    if (path.win32.basename(command).toLowerCase() === 'powershell.exe') {
      childOptions.env = windowsPowerShellEnvironment(childOptions.env ?? process.env);
    }
    const child = spawn(command, args, childOptions);
    let cancellationCode;
    const forwardInterrupt = () => { cancellationCode = 130; child.kill('SIGINT'); };
    const forwardTermination = () => { cancellationCode = 143; child.kill('SIGTERM'); };
    const cleanup = () => {
      process.removeListener('SIGINT', forwardInterrupt);
      process.removeListener('SIGTERM', forwardTermination);
    };
    process.on('SIGINT', forwardInterrupt);
    process.on('SIGTERM', forwardTermination);
    child.once('error', (error) => { cleanup(); reject(error); });
    child.once('exit', (code, signal) => {
      cleanup();
      resolve(cancellationCode ?? (signal ? 1 : (code ?? 1)));
    });
  });
}

function windowsPath(value) {
  if (/^[A-Za-z]:[\\/]/u.test(value) || value.startsWith('\\\\')) return value;
  if (isWsl()) return execFileSync('wslpath', ['-w', path.resolve(value)], { encoding: 'utf8' }).trim();
  return path.resolve(value);
}

export async function runTestProfilePayload(payload, {
  identity,
  execute = runTestProfileCommand,
  runSafely = withStudioTestRun,
  resetSafety = resetStudioTestSafety,
}) {
  if (payload.repairChannel !== undefined) {
    validateStudioRepairChannel(payload.repairChannel);
    if (payload.repairStudio !== true) throw new Error('Repair channel requires explicit installation repair mode.');
  }
  if (payload.repairFinalizeLog !== undefined) {
    validateStudioFinalizeLog(payload.repairFinalizeLog);
    if (payload.repairStudio !== true) throw new Error('Repair finalization requires explicit installation repair mode.');
    if (payload.repairChannel !== undefined) throw new Error('Repair finalization cannot request an installer channel.');
  }
  const env = createTestProfileEnvironment(identity, { ...payload, nodeExecutable: process.execPath }, process.env);
  // Account-global, never a snapshot/worker/port directory or inherited setting.
  env.RSMCP_STUDIO_TEST_SAFETY_DIR = path.win32.join(identity.localAppData, 'robloxstudio-mcp', 'test-safety');
  if (payload.prepareWorkspace === true) env.RSMCP_STUDIO_TEST_PREPARED = '1';
  console.log(`Studio test identity: ${identity.accountName} (${identity.sid})`);
  console.log(`Studio harness checkout: ${payload.repo}`);
  const options = { cwd: payload.repo, env };
  const lifecycle = path.join(payload.repo, 'scripts', 'studio-lifecycle.mjs');
  if (payload.diagnoseStudio !== undefined) {
    if (payload.diagnoseStudio !== true || payload.mode !== 'run' ||
        payload.command?.length !== 0 || payload.resetSafetyReason !== undefined || payload.repairStudio !== undefined) {
      throw new Error('Read-only diagnosis cannot execute a suite command or reset safety.');
    }
    // Fixed read-only command: diagnostics must work while a failed run remains
    // blocked, without allowing arbitrary commands around the safety guard.
    return execute(process.execPath, [path.join(payload.repo, 'scripts', 'studio-install-diagnostics.mjs')], options);
  }
  if (payload.repairStudio !== undefined) {
    if (payload.repairStudio !== true || payload.mode !== 'run' ||
        !Array.isArray(payload.command) || payload.command.length !== 0 ||
        payload.resetSafetyReason !== undefined || payload.confirmDedicatedProfile !== undefined) {
      throw new Error('Installation repair cannot execute a suite command or reset safety.');
    }
    const args = [path.join(payload.repo, 'scripts', 'studio-install-repair.mjs')];
    if (payload.repairChannel !== undefined) args.push('--channel', payload.repairChannel);
    if (payload.repairFinalizeLog !== undefined) args.push('--finalize-log', payload.repairFinalizeLog);
    return execute(process.execPath, args, options);
  }
  if (payload.resetSafetyReason !== undefined) {
    if (payload.mode !== 'run' || payload.command?.length !== 0 ||
        typeof payload.resetSafetyReason !== 'string' || !payload.resetSafetyReason.trim()) {
      throw new Error('Safety reset requires a reason and cannot run a suite command.');
    }
    const checked = await execute(process.execPath, [lifecycle, 'assert-test-profile'], options);
    if (checked !== 0) return checked;
    await resetSafety(env, payload.resetSafetyReason);
    console.log('Studio test safety reset acknowledged. Launch quota is unchanged; no Studio was launched.');
    return 0;
  }
  return runSafely(env, async () => {
    if (payload.mode === 'enroll') {
      if (payload.confirmDedicatedProfile !== true) throw new Error('Enrollment requires explicit --confirm-dedicated-profile.');
      const enrolled = await execute(process.execPath, [lifecycle, 'enroll-test-profile', '--source-sid', payload.sourceSid, '--confirm-dedicated-profile'], options);
      if (enrolled !== 0) return enrolled;
      console.log('Verifying the initialized test profile with a real managed Studio connection and edit-mode test.');
      const verified = await execute(process.execPath, ['tests/run-all.mjs', '--managed', '--test', 'path-resolution.mjs'], options);
      if (verified !== 0) return verified;
      return execute(process.execPath, [lifecycle, 'assert-test-profile'], options);
    }
    if (payload.mode !== 'run' || !Array.isArray(payload.command) || !payload.command.length ||
        payload.command.some((arg) => typeof arg !== 'string')) throw new Error('Invalid suite command payload.');
    const checked = await execute(process.execPath, [lifecycle, 'assert-test-profile'], options);
    if (checked !== 0) return checked;
    const completed = await execute(process.execPath, payload.command, options);
    if (completed !== 0) return completed;
    return execute(process.execPath, [lifecycle, 'assert-test-profile'], options);
  });
}

async function runProfileChild(payload) {
  if (process.platform !== 'win32') throw new Error('The profile child must run with native Windows Node, never Linux Node or WSL environment redirection.');
  const identity = probeWindowsStudioIdentity();
  mkdirSync(path.win32.join(identity.localAppData, 'Temp'), { recursive: true });
  return runTestProfilePayload(payload, { identity });
}

async function main() {
  if (process.argv[2] === '_child') {
    return runProfileChild(JSON.parse(Buffer.from(process.argv[3], 'base64').toString('utf8')));
  }
  const payload = parseTestProfileArguments(process.argv.slice(2));
  if (process.platform !== 'win32' && !isWsl()) throw new Error('This launcher needs Windows or WSL with Windows PowerShell interop.');
  const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url));
  let snapshot;
  let result;
  try {
    if (payload.mode !== 'forget') {
      if (payload.repo) {
        payload.repo = windowsPath(payload.repo);
        if (!/^[A-Za-z]:[\\/]/u.test(payload.repo)) {
          throw new Error('--repo must name a Windows-local prepared checkout. Omit --repo to export this worktree automatically.');
        }
        payload.prepareWorkspace = payload.mode === 'enroll';
      } else {
        const windowsSnapshotRoot = execFileSync('powershell.exe', [
          '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
          windowsPath(path.join(scriptsDirectory, 'studio-test-snapshot-root.ps1')), '-Initialize',
        ], {
          encoding: 'utf8', env: windowsPowerShellEnvironment(process.env),
          cwd: isWsl() ? '/mnt/c/Windows' : process.cwd(),
        }).trim();
        if (!/^[A-Za-z]:[\\/]/u.test(windowsSnapshotRoot)) throw new Error('Cannot locate the managed Windows snapshot root.');
        const hostSnapshotRoot = isWsl()
          ? execFileSync('wslpath', ['-u', windowsSnapshotRoot], { encoding: 'utf8' }).trim()
          : windowsSnapshotRoot;
        snapshot = await prepareStudioTestSnapshot({
          sourceDirectory: path.dirname(scriptsDirectory),
          destinationParent: hostSnapshotRoot,
        });
        payload.repo = windowsPath(snapshot.workingDirectory);
        payload.managedSnapshot = true;
        payload.prepareWorkspace = true;
        console.log(`Prepared isolated worktree snapshot: ${payload.repo}`);
      }
      if (payload.nodeExecutable) payload.nodeExecutable = windowsPath(payload.nodeExecutable);
    }
    result = await runTestProfileCommand('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', windowsPath(path.join(scriptsDirectory, 'studio-test-profile.ps1')),
      '-Payload', encodeTestProfilePayload(payload),
    ], { cwd: isWsl() ? '/mnt/c/Windows' : process.cwd() });
    return result;
  } finally {
    if (snapshot) {
      if (result === 0) await snapshot.cleanup();
      else console.error(`Retained failed test snapshot for diagnostics: ${snapshot.workingDirectory}`);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
