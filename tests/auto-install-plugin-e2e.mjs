#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { McpClient, REPO_ROOT } from './lib/mcp-client.mjs';
import {
  listStudioProcesses,
  resolvePluginsDir,
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

let localBuildDone = false;

const PLACE_FIXTURE_XML = `<?xml version="1.0" encoding="utf-8"?>
<roblox version="4">
  <External>null</External>
  <External>nil</External>
  <Item class="Workspace" referent="RBX0">
    <Properties>
      <string name="Name">Workspace</string>
    </Properties>
  </Item>
  <Item class="ServerStorage" referent="RBX1">
    <Properties>
      <string name="Name">ServerStorage</string>
    </Properties>
  </Item>
  <Item class="Lighting" referent="RBX2">
    <Properties>
      <string name="Name">Lighting</string>
    </Properties>
  </Item>
</roblox>
`;

function assert(cond, message) {
  if (!cond) throw new Error(message);
  console.log(`  ✓ ${message}`);
}

function runProcess(command, args, { cwd = REPO_ROOT, env = {}, timeoutMs = 30000 } = {}) {
  return new Promise((resolve) => {
    const proc = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      proc.kill('SIGTERM');
      setTimeout(() => {
        if (!proc.killed) proc.kill('SIGKILL');
      }, 1000);
    }, timeoutMs);
    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => { stdout += chunk; });
    proc.stderr.on('data', (chunk) => { stderr += chunk; });
    proc.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, killed });
    });
  });
}

async function runChecked(command, args, options) {
  const result = await runProcess(command, args, options);
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

function compareFiles(a, b) {
  const left = readFileSync(a);
  const right = readFileSync(b);
  return left.length === right.length && left.equals(right);
}

function backupPluginFiles(pluginsDir) {
  mkdirSync(pluginsDir, { recursive: true });
  const backups = new Map();
  for (const asset of ['MCPPlugin.rbxmx', 'MCPInspectorPlugin.rbxmx']) {
    const file = path.join(pluginsDir, asset);
    backups.set(asset, existsSync(file) ? readFileSync(file) : null);
  }
  return backups;
}

function restorePluginFiles(pluginsDir, backups) {
  for (const [asset, contents] of backups.entries()) {
    const file = path.join(pluginsDir, asset);
    if (contents === null) {
      rmSync(file, { force: true });
    } else {
      writeFileSync(file, contents);
    }
  }
}

function removeVariantFiles(pluginsDir) {
  rmSync(path.join(pluginsDir, 'MCPPlugin.rbxmx'), { force: true });
  rmSync(path.join(pluginsDir, 'MCPInspectorPlugin.rbxmx'), { force: true });
}

function createPlaceFixture(pluginsDir) {
  const fixtureDir = path.join(path.dirname(pluginsDir), 'robloxstudio-mcp-e2e');
  mkdirSync(fixtureDir, { recursive: true });
  const placePath = path.join(fixtureDir, 'AutoInstallE2E.rbxlx');
  writeFileSync(placePath, PLACE_FIXTURE_XML, 'utf8');
  return { fixtureDir, placePath };
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
  const result = await runProcess(command, args, {
    env: {
      ...SERVER_ENV,
      MCP_PLUGINS_DIR: smokePluginsDir,
      ROBLOX_STUDIO_PORT: artifact.variant === 'main' ? '58941' : '58942',
    },
    timeoutMs: 15000,
  });
  const installed = path.join(smokePluginsDir, artifact.asset);
  assert(existsSync(installed), `${artifact.source} ${artifact.variant} auto-installs ${artifact.asset}`);
  assert(compareFiles(artifact.assetPath, installed), `${artifact.source} ${artifact.variant} installed file matches bundled asset`);
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
  if (forceLocal) {
    return selectLocalArtifact(def, tmpRoot, 'paired with local main artifact');
  }
  try {
    const latest = await packLatest(def, tmpRoot);
    assertArtifactSupportsVersionMetadata(latest);
    if (def.variant === 'main') assertArtifactIncludesTool(latest, 'manage_instance');
    await smokeAutoInstall(latest, tmpRoot);
    console.log(`artifactSource(${def.variant}): latest v${latest.version}`);
    return latest;
  } catch (err) {
    console.warn(`artifactSource(${def.variant}): latest unavailable, falling back to local-pack (${err.message})`);
    return selectLocalArtifact(def, tmpRoot);
  }
}

async function waitForEditInstance(client, expected, instanceId, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      const connected = await client.callTool('get_connected_instances', {});
      const instances = connected.instances ?? [];
      const edit = instances.find((inst) => inst.role === 'edit' && inst.instanceId === instanceId);
      if (edit) {
        assert(edit.pluginVariant === expected.variant, `Studio loaded ${expected.variant} plugin variant`);
        assert(edit.pluginVersion === expected.version, `Studio plugin version is v${expected.version}`);
        assert(edit.serverVersion === expected.serverVersion, `MCP server version is v${expected.serverVersion}`);
        assert(edit.versionMismatch === expected.versionMismatch, `versionMismatch is ${expected.versionMismatch}`);
        return edit;
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
    env: SERVER_ENV,
    startupTimeoutMs: 60000,
  });
  await client.start();
  await client.initialize();
  return client;
}

async function startManagerForArtifact(label, managerArtifact) {
  return startClient(label, managerArtifact, { autoInstall: false });
}

async function launchManagedPlace(managerClient, placePath) {
  const launched = await managerClient.callTool('manage_instance', {
    action: 'launch',
    source: 'local_file',
    local_place_file: placePath,
    timeout_ms: 120000,
  });
  assert(!!launched.instance_id, `manage_instance launched Studio (${JSON.stringify(launched)})`);
  return launched.instance_id;
}

async function closeManagedInstance(managerClient, instanceId) {
  if (!managerClient || !instanceId) return;
  const closed = await managerClient.callTool('manage_instance', {
    action: 'close',
    instance_id: instanceId,
  });
  assert(!closed.error, `manage_instance closed Studio instance ${instanceId}`);
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (listStudioProcesses().length === 0) return;
    await delay(500);
  }
  throw new Error(`Studio processes remain after manage_instance close: ${JSON.stringify(listStudioProcesses())}`);
}

async function assertToolSurface(client, artifact, instanceId) {
  const tools = await client.rpc('tools/list', {});
  const names = new Set((tools.tools ?? []).map((tool) => tool.name));
  if (artifact.variant === 'inspector') {
    assert(!names.has('execute_luau'), 'inspector does not expose execute_luau');
    assert(!names.has('set_property'), 'inspector does not expose write tools');
    await client.callTool('get_place_info', { instance_id: instanceId });
    assert(true, 'inspector read tool succeeds');
    return;
  }

  await client.callTool('get_place_info', { instance_id: instanceId });
  await client.callTool('get_file_tree', { path: 'game.Workspace', instance_id: instanceId });
  const exec = await client.callTool('execute_luau', {
    target: 'edit',
    instance_id: instanceId,
    code: 'return game:GetService("HttpService").HttpEnabled',
  });
  assert(exec.success === true, 'main execute_luau read succeeds');
}

function writeMismatchedPlugin(artifact, pluginsDir) {
  const source = readFileSync(artifact.assetPath, 'utf8');
  const needle = `local CURRENT_VERSION = "${artifact.version}"`;
  const replacement = `local CURRENT_VERSION = "${artifact.version}-mismatch"`;
  const occurrences = source.split(needle).length - 1;
  assert(occurrences === 1, 'mismatch fixture changes exactly one CURRENT_VERSION token');
  writeFileSync(path.join(pluginsDir, artifact.asset), source.replace(needle, replacement), 'utf8');
}

async function waitForStudioLog(client, instanceId, needle, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    const logs = await client.callTool('get_runtime_logs', { target: 'edit', tail: 100, instance_id: instanceId });
    last = logs;
    if (JSON.stringify(logs).includes(needle)) return;
    await delay(1000);
  }
  throw new Error(`Studio output did not contain ${needle}. Last logs: ${JSON.stringify(last)}`);
}

async function runMatchingCase(artifact, managerArtifact, pluginsDir, placePath) {
  console.log(`\n=== ${artifact.variant} auto-install loads matching plugin ===`);
  removeVariantFiles(pluginsDir);

  let managerClient;
  let client;
  let instanceId;
  try {
    managerClient = artifact.variant === 'main'
      ? undefined
      : await startManagerForArtifact(`${artifact.variant}-match-manager`, managerArtifact);
    client = await startClient(`${artifact.variant}-match`, artifact, { autoInstall: true });
    const launcher = managerClient ?? client;

    const installed = path.join(pluginsDir, artifact.asset);
    assert(existsSync(installed), `${artifact.asset} installed in real Studio plugins folder`);
    assert(!existsSync(path.join(pluginsDir, artifact.otherAsset)), `${artifact.otherAsset} is absent`);
    assert(compareFiles(artifact.assetPath, installed), 'installed plugin matches artifact bundle');

    instanceId = await launchManagedPlace(launcher, placePath);
    const edit = await waitForEditInstance(client, {
      variant: artifact.variant,
      version: artifact.version,
      serverVersion: artifact.version,
      versionMismatch: false,
    }, instanceId);
    await assertToolSurface(client, artifact, edit.instanceId);
  } finally {
    const launcher = managerClient ?? client;
    if (launcher) {
      await closeManagedInstance(launcher, instanceId).catch((err) => {
        console.warn(`  (manage_instance close cleanup failed): ${err.message}`);
      });
    }
    if (client) await client.stop();
    if (managerClient) await managerClient.stop();
    await waitPortClosed(58741).catch(() => {});
  }
}

async function runMismatchCase(artifact, managerArtifact, pluginsDir, placePath) {
  console.log(`\n=== ${artifact.variant} mismatch is visible and repairable ===`);
  removeVariantFiles(pluginsDir);
  writeMismatchedPlugin(artifact, pluginsDir);

  let mismatchManager;
  let mismatchClient;
  let mismatchEdit;
  let mismatchInstanceId;
  try {
    mismatchManager = artifact.variant === 'main'
      ? undefined
      : await startManagerForArtifact(`${artifact.variant}-mismatch-manager`, managerArtifact);
    mismatchClient = await startClient(`${artifact.variant}-mismatch`, artifact, { autoInstall: false });
    const mismatchLauncher = mismatchManager ?? mismatchClient;

    mismatchInstanceId = await launchManagedPlace(mismatchLauncher, placePath);
    mismatchEdit = await waitForEditInstance(mismatchClient, {
      variant: artifact.variant,
      version: `${artifact.version}-mismatch`,
      serverVersion: artifact.version,
      versionMismatch: true,
    }, mismatchInstanceId);
    await assertToolSurface(mismatchClient, artifact, mismatchEdit.instanceId);
    const mismatchLogs = `${mismatchClient.recentStderr(50)}\n${mismatchManager?.recentStderr(50) ?? ''}`;
    assert(mismatchLogs.includes('[version-mismatch]'), 'server stderr contains version mismatch warning');
    await waitForStudioLog(mismatchClient, mismatchEdit.instanceId, 'Version mismatch');
    assert(true, 'Studio output contains version mismatch warning');
  } finally {
    const mismatchLauncher = mismatchManager ?? mismatchClient;
    if (mismatchLauncher) {
      await closeManagedInstance(mismatchLauncher, mismatchEdit?.instanceId ?? mismatchInstanceId).catch((err) => {
        console.warn(`  (manage_instance close cleanup failed): ${err.message}`);
      });
    }
    if (mismatchClient) await mismatchClient.stop();
    if (mismatchManager) await mismatchManager.stop();
    await waitPortClosed(58741).catch(() => {});
  }

  let repairManager;
  let repairClient;
  let repairInstanceId;
  try {
    repairManager = artifact.variant === 'main'
      ? undefined
      : await startManagerForArtifact(`${artifact.variant}-repair-manager`, managerArtifact);
    repairClient = await startClient(`${artifact.variant}-repair`, artifact, { autoInstall: true });
    const repairLauncher = repairManager ?? repairClient;

    assert(compareFiles(artifact.assetPath, path.join(pluginsDir, artifact.asset)), 'auto-install repaired mismatched plugin file');
    repairInstanceId = await launchManagedPlace(repairLauncher, placePath);
    await waitForEditInstance(repairClient, {
      variant: artifact.variant,
      version: artifact.version,
      serverVersion: artifact.version,
      versionMismatch: false,
    }, repairInstanceId);
  } finally {
    const repairLauncher = repairManager ?? repairClient;
    if (repairLauncher) {
      await closeManagedInstance(repairLauncher, repairInstanceId).catch((err) => {
        console.warn(`  (manage_instance close cleanup failed): ${err.message}`);
      });
    }
    if (repairClient) await repairClient.stop();
    if (repairManager) await repairManager.stop();
    await waitPortClosed(58741).catch(() => {});
  }
}

async function main() {
  if (process.env.RSMCP_E2E_CLOSE_ALL_STUDIO !== '1') {
    throw new Error('This E2E launches and closes managed Roblox Studio instances. Set RSMCP_E2E_CLOSE_ALL_STUDIO=1 to run it.');
  }
  if (await isPortOpen(58741)) {
    throw new Error('Port 58741 is already occupied. Stop existing MCP servers before running this E2E.');
  }
  const existingStudio = listStudioProcesses();
  if (existingStudio.length > 0) {
    throw new Error(`Close existing Studio windows before running this E2E: ${JSON.stringify(existingStudio)}`);
  }

  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'robloxstudio-mcp-e2e-'));
  const pluginsDir = resolvePluginsDir();
  const backups = backupPluginFiles(pluginsDir);
  const { fixtureDir, placePath } = createPlaceFixture(pluginsDir);

  try {
    const mainArtifact = await selectArtifact(VARIANTS.main, tmpRoot);
    const artifacts = [
      mainArtifact,
      await selectArtifact(VARIANTS.inspector, tmpRoot, { forceLocal: mainArtifact.source === 'local-pack' }),
    ];

    for (const artifact of artifacts) {
      await runMatchingCase(artifact, mainArtifact, pluginsDir, placePath);
      await runMismatchCase(artifact, mainArtifact, pluginsDir, placePath);
    }
  } finally {
    restorePluginFiles(pluginsDir, backups);
    rmSync(fixtureDir, { recursive: true, force: true });
    const remaining = listStudioProcesses();
    if (remaining.length > 0) {
      throw new Error(`Studio processes remain after cleanup: ${JSON.stringify(remaining)}`);
    }
  }
}

main().catch((err) => {
  console.error(`\n❌ auto-install plugin E2E failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
