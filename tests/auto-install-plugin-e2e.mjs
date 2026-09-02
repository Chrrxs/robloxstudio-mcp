#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import {
  BASE_PORT,
  McpClient,
  REPO_ROOT,
  instancePeers,
  selectEditInstance,
} from './lib/mcp-client.mjs';
import { acquireSuitePort, windowsPortIsAvailable } from './lib/test-port.mjs';
import {
  closeStudioProcess,
  configureStudioDirectoryIsolation,
  createIsolatedStudioDirectory,
} from '../scripts/studio-lifecycle.mjs';

const VARIANTS = {
  main: {
    packageName: '@chrrxs/robloxstudio-mcp',
    workspace: 'packages/robloxstudio-mcp',
    asset: 'MCPPlugin.rbxmx',
    otherAsset: 'MCPInspectorPlugin.rbxmx',
    variant: 'main',
  },
  inspector: {
    packageName: '@chrrxs/robloxstudio-mcp-inspector',
    workspace: 'packages/robloxstudio-mcp-inspector',
    asset: 'MCPInspectorPlugin.rbxmx',
    otherAsset: 'MCPPlugin.rbxmx',
    variant: 'inspector',
  },
};

const SERVER_ENV = {
  ROBLOX_STUDIO_PROXY_PROMOTION_INTERVAL_MS: '600000',
};
const ARTIFACT_SOURCE = process.env.RSMCP_E2E_ARTIFACT_SOURCE ?? 'local';

let localBuildDone = false;
let studioIsolation;
const ownedStudioLaunches = new Map();
const deferredCleanupErrors = [];

function assert(cond, message) {
  if (!cond) throw new Error(message);
  console.log(`  ✓ ${message}`);
}

function resolveWindowsNodeCli(command, platform, childEnv) {
  if (platform !== 'win32') return undefined;
  const executable = path.win32.basename(command).toLowerCase().replace(/\.cmd$/, '');
  if (executable !== 'npm' && executable !== 'npx') return undefined;

  const cliName = `${executable}-cli.js`;
  const executableDir = path.dirname(process.execPath);
  const candidates = [
    childEnv.npm_execpath && path.join(path.dirname(childEnv.npm_execpath), cliName),
    path.join(executableDir, 'node_modules', 'npm', 'bin', cliName),
    path.resolve(executableDir, '..', 'lib', 'node_modules', 'npm', 'bin', cliName),
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate));
}

function terminateProcessTree(proc, platform, signal) {
  if (!Number.isInteger(proc.pid)) {
    try {
      proc.kill(signal);
    } catch {
      // A pre-exit spawn error may leave no process to signal.
    }
    return Promise.resolve();
  }

  if (platform === 'win32') {
    return new Promise((resolve) => {
      const killer = spawn(
        'taskkill.exe',
        ['/pid', String(proc.pid), '/T', '/F'],
        { stdio: 'ignore', windowsHide: true },
      );
      killer.once('error', () => {
        try {
          proc.kill(signal);
        } catch {
          // The process may have exited before taskkill started.
        }
        resolve();
      });
      killer.once('close', () => resolve());
    });
  }

  try {
    process.kill(-proc.pid, signal);
  } catch {
    try {
      proc.kill(signal);
    } catch {
      // The process may have exited between the deadline and the signal.
    }
  }
  return Promise.resolve();
}

const activeProcessTrees = new Map();
let forwardingParentSignal = false;
const parentSignalHandlers = new Map(
  (process.platform === 'win32' ? ['SIGINT', 'SIGTERM'] : ['SIGINT', 'SIGTERM', 'SIGHUP']).map((signal) => [
    signal,
    () => {
      if (forwardingParentSignal) return;
      forwardingParentSignal = true;
      Promise.all(
        [...activeProcessTrees.entries()]
          .map(([proc, platform]) => terminateProcessTree(proc, platform, signal)),
      ).finally(() => {
        for (const [name, handler] of parentSignalHandlers) {
          process.removeListener(name, handler);
        }
        process.kill(process.pid, signal);
      });
    },
  ]),
);

function trackProcessTree(proc, platform) {
  if (activeProcessTrees.size === 0) {
    for (const [signal, handler] of parentSignalHandlers) {
      process.once(signal, handler);
    }
  }
  activeProcessTrees.set(proc, platform);
  return () => {
    activeProcessTrees.delete(proc);
    if (activeProcessTrees.size === 0 && !forwardingParentSignal) {
      for (const [signal, handler] of parentSignalHandlers) {
        process.removeListener(signal, handler);
      }
    }
  };
}

function canonicalPath(value) {
  try {
    const resolved = realpathSync.native?.(value) ?? realpathSync(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  } catch {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  }
}

export function runProcess(
  command,
  args,
  {
    cwd = REPO_ROOT,
    env = {},
    timeoutMs = 30000,
    spawnImpl = spawn,
    platform = process.platform,
    terminateProcessTreeImpl = terminateProcessTree,
  } = {},
) {
  return new Promise((resolve) => {
    const childEnv = { ...process.env, ...env };
    const windowsCli = resolveWindowsNodeCli(command, platform, childEnv);
    const executable = windowsCli ? process.execPath : command;
    const executableArgs = windowsCli ? [windowsCli, ...args] : args;
    const spawnOptions = {
      cwd,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: platform !== 'win32',
    };
    const proc = spawnImpl(executable, executableArgs, spawnOptions);
    const untrackProcessTree = trackProcessTree(proc, platform);
    let stdout = '';
    let stderr = '';
    let killed = false;
    let settled = false;
    let closeResult;
    let terminationPromise;
    let timer;
    let forceKillTimer;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(forceKillTimer);
      resolve({ stdout, stderr, killed, ...result });
      untrackProcessTree();
    };
    const finishAfterTermination = async () => {
      if (!closeResult || settled) return;
      await terminationPromise;
      finish(closeResult);
    };

    proc.stdout?.setEncoding('utf8');
    proc.stderr?.setEncoding('utf8');
    proc.stdout?.on('data', (chunk) => { stdout += chunk; });
    proc.stderr?.on('data', (chunk) => { stderr += chunk; });
    proc.once('error', (spawnError) => {
      finish({ code: null, spawnError });
    });
    proc.once('close', (code, signal) => {
      closeResult = { code, signal };
      void finishAfterTermination();
    });

    timer = setTimeout(() => {
      if (settled) return;
      killed = true;
      terminationPromise = Promise.resolve()
        .then(() => terminateProcessTreeImpl(proc, platform, 'SIGTERM'));
      void finishAfterTermination();
      if (platform === 'win32') return;
      forceKillTimer = setTimeout(() => {
        if (settled) return;
        terminationPromise = Promise.resolve(terminationPromise)
          .then(() => terminateProcessTreeImpl(proc, platform, 'SIGKILL'));
        void finishAfterTermination();
      }, 1000);
    }, timeoutMs);
  });
}

function throwIfSpawnFailed(command, args, result) {
  if (!result.spawnError) return;
  throw new Error(
    `${command} ${args.join(' ')} could not be started: ${result.spawnError.message}`,
    { cause: result.spawnError },
  );
}

export async function runChecked(command, args, options) {
  const result = await runProcess(command, args, options);
  throwIfSpawnFailed(command, args, result);
  if (result.code !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed (${result.code})\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

function isPortOpen(port) {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.setTimeout(1000);
    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.on('error', () => resolve(false));
  });
}

async function waitPortClosed(port, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isPortOpen(port))) return;
    await delay(250);
  }
  throw new Error(`Port ${port} remained open after server shutdown`);
}

function installedPluginMatchesArtifact(
  artifactPath,
  installedPath,
  port = process.env.ROBLOX_STUDIO_PORT,
) {
  const artifact = readFileSync(artifactPath);
  const installed = readFileSync(installedPath);
  const configuredPort = Number(port ?? 58741);
  if (configuredPort === 58741) {
    return artifact.length === installed.length && artifact.equals(installed);
  }

  const version = artifact.toString('utf8').match(/local CURRENT_VERSION = "([^"]+)"/)?.[1];
  const installedText = installed.toString('utf8');
  return version !== undefined
    && installedText.includes(`local CURRENT_VERSION = "${version}"`)
    && installedText.includes(`http://localhost:${configuredPort}`)
    && installedText.includes(`MCP_LAST_SUCCESSFUL_SERVER_URL_GLOBAL_V1_PORT_${configuredPort}`)
    && !installedText.includes('http://localhost:58741');
}


function removeVariantFiles(pluginsDir) {
  rmSync(path.join(pluginsDir, 'MCPPlugin.rbxmx'), { force: true });
  rmSync(path.join(pluginsDir, 'MCPInspectorPlugin.rbxmx'), { force: true });
}

function packTarballPath(stdout, destination) {
  const packed = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.endsWith('.tgz'))
    .pop();
  if (!packed) throw new Error(`npm pack output did not include a tgz name:\n${stdout}`);
  return path.isAbsolute(packed) ? packed : path.join(destination, packed);
}

async function extractTarball(tarball, destination) {
  mkdirSync(destination, { recursive: true });
  await runChecked('tar', ['-xzf', tarball, '-C', destination], { timeoutMs: 30000 });
  return path.join(destination, 'package');
}

async function packLatest(def, tmpRoot) {
  const packDir = path.join(tmpRoot, `${def.variant}-latest-pack`);
  mkdirSync(packDir, { recursive: true });
  const result = await runChecked('npm', ['pack', `${def.packageName}@latest`, '--pack-destination', packDir], {
    timeoutMs: 120000,
  });
  const tarball = packTarballPath(result.stdout, packDir);
  const packageDir = await extractTarball(tarball, path.join(tmpRoot, `${def.variant}-latest-extract`));
  return artifactFromPackage(def, 'latest', packageDir);
}

async function ensureLocalBuild(tmpRoot) {
  if (localBuildDone) return;
  const buildInstallDir = path.join(tmpRoot, 'local-build-plugin-install');
  await runChecked('npm', ['run', 'build'], { timeoutMs: 120000 });
  await runChecked('npm', ['run', 'compile:plugin'], { timeoutMs: 120000 });
  await runChecked('node', ['scripts/build-plugin.mjs', '--variant', 'inspector'], {
    env: { MCP_PLUGINS_DIR: buildInstallDir },
    timeoutMs: 120000,
  });
  await runChecked('node', ['scripts/build-plugin.mjs'], {
    env: { MCP_PLUGINS_DIR: buildInstallDir },
    timeoutMs: 120000,
  });
  localBuildDone = true;
}

async function packLocal(def, tmpRoot) {
  await ensureLocalBuild(tmpRoot);
  const packDir = path.join(tmpRoot, `${def.variant}-local-pack`);
  mkdirSync(packDir, { recursive: true });
  const result = await runChecked('npm', ['pack', '-w', def.workspace, '--pack-destination', packDir], {
    timeoutMs: 120000,
  });
  const tarball = packTarballPath(result.stdout, packDir);
  const packageDir = await extractTarball(tarball, path.join(tmpRoot, `${def.variant}-local-extract`));
  linkLocalDependencies(packageDir);
  return artifactFromPackage(def, 'local-pack', packageDir);
}

function linkLocalDependencies(packageDir) {
  const target = path.join(packageDir, 'node_modules');
  if (existsSync(target)) return;
  symlinkSync(
    path.join(REPO_ROOT, 'node_modules'),
    target,
    process.platform === 'win32' ? 'junction' : 'dir',
  );
}

function artifactFromPackage(def, source, packageDir) {
  const packageJson = JSON.parse(readFileSync(path.join(packageDir, 'package.json'), 'utf8'));
  const assetPath = path.join(packageDir, 'studio-plugin', def.asset);
  const indexPath = path.join(packageDir, 'dist', 'index.js');
  assert(existsSync(assetPath), `${source} artifact contains ${def.asset}`);
  assert(existsSync(indexPath), `${source} artifact contains dist/index.js`);
  return {
    ...def,
    source,
    packageDir,
    version: packageJson.version,
    assetPath,
    indexPath,
  };
}

function assertArtifactSupportsVersionMetadata(artifact) {
  const asset = readFileSync(artifact.assetPath, 'utf8');
  assert(asset.includes('PLUGIN_VARIANT'), `${artifact.source} ${artifact.variant} artifact includes plugin variant metadata`);
  assert(asset.includes('pluginVersion'), `${artifact.source} ${artifact.variant} artifact sends plugin version metadata`);
}

function assertArtifactIncludesTool(artifact, toolName) {
  const server = readFileSync(artifact.indexPath, 'utf8');
  assert(server.includes(toolName), `${artifact.source} ${artifact.variant} artifact includes ${toolName}`);
}

function commandFor(artifact, { autoInstall }) {
  const extra = [];
  if (autoInstall) {
    extra.push('--auto-install-plugin');
  }
  if (artifact.source === 'latest') {
    return {
      command: 'npx',
      args: ['-y', `${artifact.packageName}@latest`, ...extra],
    };
  }
  return {
    command: 'node',
    args: [artifact.indexPath, ...extra],
  };
}

async function smokeAutoInstall(artifact, tmpRoot) {
  const smokePluginsDir = path.join(tmpRoot, `${artifact.variant}-smoke-plugins`);
  const { command, args } = commandFor(artifact, { autoInstall: true });
  const portLease = await acquireSuitePort({ env: {} });
  let result;
  try {
    await portLease.handoff();
    result = await runProcess(command, args, {
      env: {
        ...SERVER_ENV,
        MCP_PLUGINS_DIR: smokePluginsDir,
        ROBLOX_STUDIO_PORT: String(portLease.port),
        ROBLOX_STUDIO_REQUIRE_PRIMARY: '1',
      },
      timeoutMs: 15000,
    });
  } finally {
    await portLease.release();
  }
  throwIfSpawnFailed(command, args, result);
  const installed = path.join(smokePluginsDir, artifact.asset);
  assert(existsSync(installed), `${artifact.source} ${artifact.variant} auto-installs ${artifact.asset}`);
  assert(
    installedPluginMatchesArtifact(artifact.assetPath, installed, String(portLease.port)),
    `${artifact.source} ${artifact.variant} installed file matches its port-configured bundled asset`,
  );
  assert(!result.stdout.includes('[install-plugin]') && !result.stdout.includes('Installed '), 'installer does not write status text to stdout');
}

async function selectLocalArtifact(def, tmpRoot, reason) {
  if (reason) console.warn(`artifactSource(${def.variant}): using local-pack (${reason})`);
  const local = await packLocal(def, tmpRoot);
  assertArtifactSupportsVersionMetadata(local);
  if (def.variant === 'main') assertArtifactIncludesTool(local, 'manage_instance');
  await smokeAutoInstall(local, tmpRoot);
  console.log(`artifactSource(${def.variant}): local-pack v${local.version}`);
  return local;
}

async function selectArtifact(def, tmpRoot, { forceLocal = false } = {}) {
  if (forceLocal || ARTIFACT_SOURCE === 'local') {
    const reason = forceLocal ? 'paired with local main artifact' : 'local is the default';
    return selectLocalArtifact(def, tmpRoot, reason);
  }

  const latest = await packLatest(def, tmpRoot);
  assertArtifactSupportsVersionMetadata(latest);
  if (def.variant === 'main') assertArtifactIncludesTool(latest, 'manage_instance');
  await smokeAutoInstall(latest, tmpRoot);
  console.log(`artifactSource(${def.variant}): latest v${latest.version}`);
  return latest;
}

async function waitForEditInstance(client, expected, instanceId, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      const connected = await client.callTool('get_connected_instances', {});
      const place = selectEditInstance(connected, instanceId);
      if (place) {
        const statusResponse = await fetch(`http://127.0.0.1:${BASE_PORT}/status`);
        const status = await statusResponse.json();
        const edit = instancePeers(selectEditInstance(status, instanceId))
          .find((peer) => peer.role === 'edit');
        if (!edit) {
          last = { connected, status };
          await delay(1000);
          continue;
        }
        assert(edit.pluginVariant === expected.variant, `Studio loaded ${expected.variant} plugin variant`);
        assert(edit.pluginVersion === expected.version, `Studio plugin version is v${expected.version}`);
        assert(edit.serverVersion === expected.serverVersion, `MCP server version is v${expected.serverVersion}`);
        return { ...place, instanceId: place.id };
      }
      last = connected;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    await delay(1000);
  }
  throw new Error(`No edit instance ${instanceId} connected within ${timeoutMs}ms. Last: ${JSON.stringify(last)}`);
}

async function startClient(label, artifact, { autoInstall }) {
  const { command, args } = commandFor(artifact, { autoInstall });
  const client = new McpClient(label, {
    command,
    args,
    env: {
      ...SERVER_ENV,
      ...(studioIsolation
        ? {
            MCP_PLUGINS_DIR: studioIsolation.pluginsDirectory,
            RSMCP_STUDIO_WORKING_DIRECTORY: studioIsolation.workingDirectory,
          }
        : {}),
    },
    startupTimeoutMs: 60000,
  });
  await client.start();
  await client.initialize();
  return client;
}

async function startManagerForArtifact(label, managerArtifact) {
  return startClient(label, managerArtifact, { autoInstall: false });
}

async function launchManagedPlace(managerClient, { waitForConnection = true } = {}) {
  await configureStudioDirectoryIsolation({ requireStudioClosed: false });
  const launched = await managerClient.callTool('manage_instance', {
    action: 'launch',
    source: 'baseplate',
    require_process_identity: true,
    timeout_ms: 120000,
    ...(studioIsolation
      ? { studio_working_directory: studioIsolation.workingDirectory }
      : {}),
  }, 150000);
  assert(!!launched.launch_id, `manage_instance returned launch ownership (${JSON.stringify(launched)})`);
  assert(
    Number.isSafeInteger(launched.pid) &&
      launched.pid > 0 &&
      typeof launched.process_started_at_file_time === 'string',
    `manage_instance returned exact Studio process identity (${JSON.stringify(launched)})`,
  );
  ownedStudioLaunches.set(launched.launch_id, launched);

  const authorized = await managerClient.callTool('manage_instance', {
    action: 'authorize',
    launch_id: launched.launch_id,
  });
  assert(
    authorized.process_authorized === true,
    `manage_instance authorized Studio launch ${launched.launch_id}`,
  );
  const completed = await managerClient.callTool('manage_instance', {
    action: 'complete',
    launch_id: launched.launch_id,
  });
  assert(
    completed.process_ownership_released === true,
    `manage_instance released Studio launch ${launched.launch_id}`,
  );
  if (!waitForConnection) return launched.launch_id;


  const deadline = Date.now() + 120000;
  let status;
  while (Date.now() < deadline) {
    status = await managerClient.callTool('manage_instance', {
      action: 'status',
      launch_id: launched.launch_id,
    });
    if (
      status.connected === true &&
      typeof status.instance_id === 'string' &&
      status.instance_id &&
      Array.isArray(status.roles) &&
      status.roles.includes('edit')
    ) {
      ownedStudioLaunches.delete(launched.launch_id);
      ownedStudioLaunches.set(status.instance_id, launched);
      return status.instance_id;
    }
    if (status.state === 'failed' || status.state === 'exited') {
      throw new Error(
        `Managed Studio launch ${launched.launch_id} entered ${status.state}: ` +
        `${status.failure_reason ?? 'Studio did not connect'}`,
      );
    }
    await delay(250);
  }
  throw new Error(
    `Managed Studio launch ${launched.launch_id} did not connect within 120000ms: ${JSON.stringify(status)}`,
  );
}

async function closeManagedInstance(managerClient, instanceId) {
  if (!managerClient || !instanceId) return;
  const launch = ownedStudioLaunches.get(instanceId);
  let managedError;
  try {
    const closed = await managerClient.callTool('manage_instance', {
      action: 'close',
      ...(launch?.launch_id ? { launch_id: launch.launch_id } : { instance_id: instanceId }),
    });
    assert(!closed.error, `manage_instance closed Studio instance ${instanceId}`);
    assert(
      closed.close_status === 'closed' || closed.close_status === 'already_closed',
      `manage_instance confirmed Studio instance ${instanceId} stopped`,
    );
  } catch (error) {
    managedError = error instanceof Error ? error : new Error(String(error));
    if (!launch) {
      managedError.ownedStudioMayBeRunning = true;
      throw managedError;
    }
    try {
      await closeStudioProcess({
        processId: launch.pid,
        startedAtFileTime: launch.process_started_at_file_time,
      });
    } catch (identityError) {
      const cleanupError = new AggregateError(
        [managedError, identityError],
        `Could not close owned Studio process ${launch.pid}`,
        { cause: managedError },
      );
      cleanupError.ownedStudioMayBeRunning = true;
      throw cleanupError;
    }
  }
  ownedStudioLaunches.delete(instanceId);

  let restoreError;
  try {
    await configureStudioDirectoryIsolation({ requireStudioClosed: false });
  } catch (error) {
    restoreError = error instanceof Error ? error : new Error(String(error));
  }
  if (managedError && restoreError) {
    throw new AggregateError(
      [managedError, restoreError],
      `Managed close and Studio directory restoration both failed for ${instanceId}`,
      { cause: managedError },
    );
  }
  if (managedError) throw managedError;
  if (restoreError) throw restoreError;
}

async function assertToolSurface(client, artifact, instanceId) {
  const tools = await client.rpc('tools/list', {});
  const names = new Set((tools.tools ?? []).map((tool) => tool.name));
  if (artifact.variant === 'inspector') {
    assert(!names.has('execute_luau'), 'inspector does not expose execute_luau');
    assert(!names.has('set_properties'), 'inspector does not expose write tools');
    await client.callTool('get_place_info', { instance_id: instanceId });
    assert(true, 'inspector read tool succeeds');
    return;
  }

  await client.callTool('get_place_info', { instance_id: instanceId });
  await client.callTool('get_project_structure', { path: 'game.Workspace', maxDepth: 2, instance_id: instanceId });
  const exec = await client.callTool('execute_luau', {
    target: 'edit',
    instance_id: instanceId,
    code: 'return game:GetService("HttpService").HttpEnabled',
  });
  assert(exec.success === true, 'main execute_luau read succeeds');
}

async function writeMismatchedPlugin(artifact, pluginsDir) {
  const { command, args } = commandFor(artifact, { autoInstall: false });
  await runChecked(command, [...args, '--install-plugin'], {
    env: {
      ...SERVER_ENV,
      MCP_PLUGINS_DIR: pluginsDir,
      ROBLOX_STUDIO_PORT: String(BASE_PORT),
    },
    timeoutMs: 30000,
  });

  const installedPath = path.join(pluginsDir, artifact.asset);
  const source = readFileSync(installedPath, 'utf8');
  const needle = `local CURRENT_VERSION = "${artifact.version}"`;
  const replacement = `local CURRENT_VERSION = "${artifact.version}-mismatch"`;
  const occurrences = source.split(needle).length - 1;
  assert(occurrences === 1, 'mismatch fixture changes exactly one CURRENT_VERSION token');
  writeFileSync(installedPath, source.replace(needle, replacement), 'utf8');
}


async function runMatchingCase(artifact, managerArtifact, pluginsDir) {
  console.log(`\n=== ${artifact.variant} auto-install loads matching plugin ===`);
  removeVariantFiles(pluginsDir);

  let managerClient;
  let client;
  let instanceId;
  let fatalCloseError;
  let matchingBodyError;
  try {
    managerClient = artifact.variant === 'main'
      ? undefined
      : await startManagerForArtifact(`${artifact.variant}-match-manager`, managerArtifact);
    client = await startClient(`${artifact.variant}-match`, artifact, { autoInstall: true });
    const launcher = managerClient ?? client;

    const installed = path.join(pluginsDir, artifact.asset);
    assert(existsSync(installed), `${artifact.asset} installed in isolated Studio plugins folder`);
    assert(!existsSync(path.join(pluginsDir, artifact.otherAsset)), `${artifact.otherAsset} is absent`);
    assert(installedPluginMatchesArtifact(artifact.assetPath, installed), 'installed plugin matches the port-configured artifact bundle');

    instanceId = await launchManagedPlace(launcher);
    const edit = await waitForEditInstance(client, {
      variant: artifact.variant,
      version: artifact.version,
      serverVersion: artifact.version,
    }, instanceId);
    await assertToolSurface(client, artifact, edit.instanceId);
  } catch (error) {
    matchingBodyError = error;
    throw error;
  } finally {
    const launcher = managerClient ?? client;
    if (launcher) {
      await closeManagedInstance(launcher, instanceId).catch((error) => {
        if (error?.ownedStudioMayBeRunning) fatalCloseError = error;
        else deferredCleanupErrors.push(error);
      });
    }
    if (client) await client.stop();
    if (managerClient) await managerClient.stop();
    await waitPortClosed(BASE_PORT).catch(() => {});
    if (fatalCloseError) {
      if (matchingBodyError) {
        throw new AggregateError(
          [matchingBodyError, fatalCloseError],
          'Matching auto-install case failed and its Studio process may still be running',
          { cause: matchingBodyError },
        );
      }
      throw fatalCloseError;
    }
  }
}

async function runMismatchCase(artifact, managerArtifact, pluginsDir) {
  console.log(`\n=== ${artifact.variant} mismatch is rejected and repairable ===`);
  removeVariantFiles(pluginsDir);
  await writeMismatchedPlugin(artifact, pluginsDir);

  let mismatchManager;
  let mismatchClient;
  let mismatchInstanceId;
  let fatalMismatchCloseError;
  let mismatchBodyError;
  try {
    mismatchManager = artifact.variant === 'main'
      ? undefined
      : await startManagerForArtifact(`${artifact.variant}-mismatch-manager`, managerArtifact);
    mismatchClient = await startClient(`${artifact.variant}-mismatch`, artifact, { autoInstall: false });
    const mismatchLauncher = mismatchManager ?? mismatchClient;

    mismatchInstanceId = await launchManagedPlace(mismatchLauncher, { waitForConnection: false });
    const rejectionDeadline = Date.now() + 30000;
    let rejectionLogs = '';
    while (Date.now() < rejectionDeadline) {
      rejectionLogs = `${mismatchClient.recentStderr(100)}\n${mismatchManager?.recentStderr(100) ?? ''}`;
      if (
        rejectionLogs.includes('[plugin-version-rejected]') &&
        rejectionLogs.includes(`${artifact.version}-mismatch`)
      ) {
        break;
      }
      await delay(500);
    }
    assert(rejectionLogs.includes('[plugin-version-rejected]'), 'server rejects the mismatched bundled plugin');

    const statusResponse = await fetch(`http://127.0.0.1:${BASE_PORT}/status`);
    const status = await statusResponse.json();
    assert(
      Array.isArray(status.instances) && status.instances.length === 0,
      'mismatched plugin is not registered as a usable Studio peer',
    );
  } catch (error) {
    mismatchBodyError = error;
    throw error;
  } finally {
    const mismatchLauncher = mismatchManager ?? mismatchClient;
    if (mismatchLauncher) {
      await closeManagedInstance(mismatchLauncher, mismatchInstanceId).catch((error) => {
        if (error?.ownedStudioMayBeRunning) fatalMismatchCloseError = error;
        else deferredCleanupErrors.push(error);
      });
    }
    if (mismatchClient) await mismatchClient.stop();
    if (mismatchManager) await mismatchManager.stop();
    await waitPortClosed(BASE_PORT).catch(() => {});
    if (fatalMismatchCloseError) {
      if (mismatchBodyError) {
        throw new AggregateError(
          [mismatchBodyError, fatalMismatchCloseError],
          'Mismatch rejection case failed and its Studio process may still be running',
          { cause: mismatchBodyError },
        );
      }
      throw fatalMismatchCloseError;
    }
  }

  let repairManager;
  let repairClient;
  let repairInstanceId;
  let fatalRepairCloseError;
  let repairBodyError;
  try {
    repairManager = artifact.variant === 'main'
      ? undefined
      : await startManagerForArtifact(`${artifact.variant}-repair-manager`, managerArtifact);
    repairClient = await startClient(`${artifact.variant}-repair`, artifact, { autoInstall: true });
    const repairLauncher = repairManager ?? repairClient;

    assert(
      installedPluginMatchesArtifact(artifact.assetPath, path.join(pluginsDir, artifact.asset)),
      'auto-install repaired the port-configured mismatched plugin file',
    );
    repairInstanceId = await launchManagedPlace(repairLauncher);
    await waitForEditInstance(repairClient, {
      variant: artifact.variant,
      version: artifact.version,
      serverVersion: artifact.version,

    }, repairInstanceId);
  } catch (error) {
    repairBodyError = error;
    throw error;
  } finally {
    const repairLauncher = repairManager ?? repairClient;
    if (repairLauncher) {
      await closeManagedInstance(repairLauncher, repairInstanceId).catch((error) => {
        if (error?.ownedStudioMayBeRunning) fatalRepairCloseError = error;
        else deferredCleanupErrors.push(error);
      });
    }
    if (repairClient) await repairClient.stop();
    if (repairManager) await repairManager.stop();
    await waitPortClosed(BASE_PORT).catch(() => {});
    if (fatalRepairCloseError) {
      if (repairBodyError) {
        throw new AggregateError(
          [repairBodyError, fatalRepairCloseError],
          'Repair auto-install case failed and its Studio process may still be running',
          { cause: repairBodyError },
        );
      }
      throw fatalRepairCloseError;
    }
  }
}

async function main() {
  if (ARTIFACT_SOURCE !== 'local' && ARTIFACT_SOURCE !== 'latest') {
    throw new Error('RSMCP_E2E_ARTIFACT_SOURCE must be "local" or "latest".');
  }
  if (await isPortOpen(BASE_PORT)) {
    throw new Error(`Port ${BASE_PORT} is already occupied. Stop existing MCP servers before running this E2E.`);
  }
  // Studio is a Windows process under WSL, so its loopback namespace must be
  // free as well as the WSL namespace checked above.
  if (!windowsPortIsAvailable(BASE_PORT)) {
    throw new Error(
      `A Windows process is listening on port ${BASE_PORT}. ` +
      'Studio would connect to it instead of the test server.',
    );
  }

  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'robloxstudio-mcp-e2e-'));
  await configureStudioDirectoryIsolation({ requireStudioClosed: false });
  studioIsolation = createIsolatedStudioDirectory({ prefix: 'auto-install-e2e' });
  const pluginsDir = studioIsolation.pluginsDirectory;

  let bodyError;
  try {
    const mainArtifact = await selectArtifact(VARIANTS.main, tmpRoot);
    const artifacts = [
      mainArtifact,
      await selectArtifact(VARIANTS.inspector, tmpRoot, { forceLocal: mainArtifact.source === 'local-pack' }),
    ];

    for (const artifact of artifacts) {
      await runMatchingCase(artifact, mainArtifact, pluginsDir);
      await runMismatchCase(artifact, mainArtifact, pluginsDir);
    }
  } catch (error) {
    bodyError = error;
    throw error;
  } finally {
    const cleanupErrors = [...deferredCleanupErrors];
    for (const launch of ownedStudioLaunches.values()) {
      try {
        await closeStudioProcess({
          processId: launch.pid,
          startedAtFileTime: launch.process_started_at_file_time,
        });
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    ownedStudioLaunches.clear();
    try {
      await configureStudioDirectoryIsolation({ requireStudioClosed: false });
    } catch (error) {
      cleanupErrors.push(error);
    }
    await delay(1000);
    try {
      studioIsolation.cleanup();
    } catch (error) {
      cleanupErrors.push(error);
    }
    studioIsolation = undefined;
    rmSync(tmpRoot, { recursive: true, force: true });
    if (cleanupErrors.length > 0) {
      if (bodyError) {
        throw new AggregateError(
          [bodyError, ...cleanupErrors],
          `Auto-install E2E failed and Studio cleanup also failed: ${cleanupErrors.map(String).join('; ')}`,
          { cause: bodyError },
        );
      }
      throw new AggregateError(cleanupErrors, 'Auto-install E2E Studio cleanup failed');
    }
  }
}

if (process.argv[1] && canonicalPath(process.argv[1]) === canonicalPath(fileURLToPath(import.meta.url))) {
  try {
    await main();
  } catch (err) {
    console.error(`\n❌ auto-install plugin E2E failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    process.exitCode = 1;
  }
}
