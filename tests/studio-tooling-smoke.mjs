#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { McpClient, DIST, REPO_ROOT, assert, assertContains } from './lib/mcp-client.mjs';
import {
  listStudioProcesses,
  resolvePluginsDir,
} from '../scripts/studio-lifecycle.mjs';

const SERVER_ENV = {
  ROBLOX_STUDIO_PROXY_PROMOTION_INTERVAL_MS: '600000',
};

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

async function waitForEditInstance(client, expectedVersion, instanceId, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      const connected = await client.callTool('get_connected_instances', {});
      const instances = connected.instances ?? [];
      const edit = instances.find((inst) => inst.id === instanceId && inst.roles?.includes('edit'));
      if (edit) {
        const statusResponse = await fetch('http://127.0.0.1:58741/status');
        const status = await statusResponse.json();
        const peer = status.instances?.find((inst) => inst.role === 'edit' && inst.instanceId === instanceId);
        if (!peer) {
          last = { connected, status };
          await delay(1000);
          continue;
        }
        assert(peer.pluginVariant === 'main', 'regular tooling loaded the main plugin');
        assert(peer.pluginVersion === expectedVersion, `Studio plugin version is v${expectedVersion}`);
        assert(peer.serverVersion === expectedVersion, `MCP server version is v${expectedVersion}`);
        assert(peer.versionMismatch === false, 'regular tooling has no version mismatch');
        return { ...edit, instanceId: edit.id };
      }
      last = connected;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    await delay(1000);
  }
  throw new Error(`No edit instance ${instanceId} connected within ${timeoutMs}ms. Last: ${JSON.stringify(last)}`);
}

async function launchManagedPlace(client) {
  const launched = await client.callTool('manage_instance', {
    action: 'launch',
    source: 'baseplate',
    timeout_ms: 120000,
  });
  assert(!!launched.instance_id, `manage_instance launched Studio (${JSON.stringify(launched)})`);
  return launched.instance_id;
}

async function closeManagedInstance(client, instanceId) {
  if (!instanceId) return;
  const closed = await client.callTool('manage_instance', {
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

function assertNoError(value, message) {
  assert(!value?.error, `${message}${value?.error ? ` (${value.error})` : ''}`);
}

async function runEditModeToolSmoke(client, instanceId) {
  console.log('\n=== edit-mode regular tooling smoke ===');

  const listed = await client.rpc('tools/list', {});
  const names = new Set((listed.tools ?? []).map((tool) => tool.name));
  for (const tool of [
    'get_place_info',
    'get_project_structure',
    'set_properties',
    'get_instance_properties',
    'set_script_source',
    'get_script_source',
    'get_attributes',
    'get_selection',
    'execute_luau',
  ]) {
    assert(names.has(tool), `tools/list exposes ${tool}`);
  }
  for (const removed of ['get_services', 'create_object', 'set_property', 'set_attribute', 'add_tag', 'delete_object']) {
    assert(!names.has(removed), `tools/list omits removed ${removed}`);
  }

  const place = await client.callTool('get_place_info', { instance_id: instanceId });
  assertNoError(place, 'get_place_info succeeds');
  assert(place.workspace?.className === 'Workspace', 'get_place_info returns workspace metadata');

  const tree = await client.callTool('get_project_structure', { path: 'game.Workspace', maxDepth: 2, instance_id: instanceId });
  assertNoError(tree, 'get_project_structure succeeds');

  const folderPath = 'game.Workspace.__RSMCP_ToolingSmoke';
  const partPath = `${folderPath}.SmokePart`;
  const scriptPath = `${folderPath}.SmokeScript`;
  const setup = await client.callTool('execute_luau', {
    target: 'edit',
    instance_id: instanceId,
    code: `
local old = workspace:FindFirstChild("__RSMCP_ToolingSmoke")
if old then old:Destroy() end
local folder = Instance.new("Folder")
folder.Name = "__RSMCP_ToolingSmoke"
folder.Parent = workspace
local part = Instance.new("Part")
part.Name = "SmokePart"
part.Anchored = true
part.Size = Vector3.new(4, 1, 2)
part.Position = Vector3.new(0, 5, 0)
part:SetAttribute("SmokeAttr", "ok")
game:GetService("CollectionService"):AddTag(part, "RSMCPToolingSmoke")
part.Parent = folder
local script = Instance.new("Script")
script.Name = "SmokeScript"
script.Enabled = false
script.Parent = folder
return true
`,
  });
  assert(setup.success === true && String(setup.returnValue) === 'true', 'execute_luau creates smoke fixtures');

  try {
    const setProp = await client.callTool('set_properties', {
      instancePath: partPath,
      properties: { Transparency: 0.25 },
      instance_id: instanceId,
    });
    assert(setProp.summary?.failed === 0, 'set_properties updates smoke part');

    const props = await client.callTool('get_instance_properties', {
      instancePath: partPath,
      instance_id: instanceId,
    });
    assertNoError(props, 'get_instance_properties succeeds');
    assert(props.properties?.Name === 'SmokePart', 'get_instance_properties returns updated object');

    const attrs = await client.callTool('get_attributes', {
      instancePath: partPath,
      instance_id: instanceId,
    });
    assert(attrs.attributes?.SmokeAttr?.value === 'ok', 'get_attributes returns smoke attribute');

    const tag = await client.callTool('execute_luau', {
      target: 'edit',
      instance_id: instanceId,
      code: 'return game:GetService("CollectionService"):HasTag(workspace.__RSMCP_ToolingSmoke.SmokePart, "RSMCPToolingSmoke")',
    });
    assert(tag.success === true && String(tag.returnValue) === 'true', 'execute_luau handles project-specific tag work');

    const setSource = await client.callTool('set_script_source', {
      instancePath: scriptPath,
      source: 'local value = 41\nreturn value + 1\n',
      instance_id: instanceId,
    });
    assert(setSource.success === true, 'set_script_source updates smoke script');

    const source = await client.callTool('get_script_source', {
      instancePath: scriptPath,
      line_range: '1-2',
      instance_id: instanceId,
    });
    assertContains(source.source, 'return value + 1', 'get_script_source returns edited source');

    const exec = await client.callTool('execute_luau', {
      target: 'edit',
      instance_id: instanceId,
      code: 'return workspace:FindFirstChild("__RSMCP_ToolingSmoke") ~= nil',
    });
    assert(exec.success === true, 'execute_luau edit target succeeds');
    assert(String(exec.returnValue) === 'true', 'execute_luau can read edited Workspace state');

    const selection = await client.callTool('get_selection', { instance_id: instanceId });
    assertNoError(selection, 'get_selection succeeds');
  } finally {
    const deleted = await client.callTool('execute_luau', {
      target: 'edit',
      instance_id: instanceId,
      code: `local folder = workspace:FindFirstChild("__RSMCP_ToolingSmoke")
if folder then folder:Destroy() end
return true`,
    });
    assert(deleted.success === true, 'execute_luau cleans up smoke folder');
  }
}

function runLiveRegressionSuite(instanceId) {
  console.log('\n=== existing live Studio regression suite ===');
  return new Promise((resolve, reject) => {
    const proc = spawn('node', ['tests/run-all.mjs'], {
      cwd: REPO_ROOT,
      env: { ...process.env, ...SERVER_ENV, MCP_INSTANCE_ID: instanceId },
      stdio: 'inherit',
    });
    proc.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`tests/run-all.mjs exited with ${code ?? 1}`));
    });
  });
}

async function main() {
  if (process.env.RSMCP_E2E_CLOSE_ALL_STUDIO !== '1') {
    throw new Error('This smoke test launches and closes a managed Roblox Studio instance. Set RSMCP_E2E_CLOSE_ALL_STUDIO=1 to run it.');
  }
  if (await isPortOpen(58741)) {
    throw new Error('Port 58741 is already occupied. Stop existing MCP servers before running this smoke test.');
  }
  const existingStudio = listStudioProcesses();
  if (existingStudio.length > 0) {
    throw new Error(`Close existing Studio windows before running this smoke test: ${JSON.stringify(existingStudio)}`);
  }

  const { version } = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  const pluginsDir = resolvePluginsDir();
  const backups = backupPluginFiles(pluginsDir);
  let client;
  let instanceId;

  try {
    client = new McpClient('regular-tooling-primary', {
      command: 'node',
      args: [DIST, '--auto-install-plugin'],
      env: SERVER_ENV,
      startupTimeoutMs: 60000,
    });
    await client.start();
    await client.initialize();

    instanceId = await launchManagedPlace(client);
    const edit = await waitForEditInstance(client, version, instanceId);
    await runEditModeToolSmoke(client, edit.instanceId);
    await runLiveRegressionSuite(edit.instanceId);
  } finally {
    if (client && instanceId) {
      await closeManagedInstance(client, instanceId).catch((err) => {
        console.warn(`  (manage_instance close cleanup failed): ${err.message}`);
      });
    }
    if (client) {
      await client.stop();
      await waitPortClosed(58741).catch(() => {});
    }
    restorePluginFiles(pluginsDir, backups);
    const remaining = listStudioProcesses();
    if (remaining.length > 0) {
      throw new Error(`Studio processes remain after cleanup: ${JSON.stringify(remaining)}`);
    }
  }
}

main().catch((err) => {
  console.error(`\n❌ regular Studio tooling smoke failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
