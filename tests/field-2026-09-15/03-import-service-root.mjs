#!/usr/bin/env node
// Field report #3: import_rbxm whose root is a service (StarterCharacterScripts) must unwrap the service's children into parent_path and report unwrappedServiceRoot; ordinary (StarterGui-rooted) imports stay intact.
// Run: node tests/run-with-test-port.mjs tests/run-all.mjs --managed --test field-2026-09-15/03-import-service-root.mjs
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { McpClient, runTest, assert } from '../lib/mcp-client.mjs';

const SCS = 'game.StarterPlayer.StarterCharacterScripts';
const NAMES = ['__RSMCP_ImportA', '__RSMCP_ImportB'];
const GUI_ROOT = '__RSMCP_ImportRegression';

function log(label, value) {
  console.log(`[${new Date().toISOString()}] ${label}: ${JSON.stringify(value)}`);
}

await runTest('field #3 import_rbxm with a service-rooted rbxm', async ({ track }) => {
  const client = track(new McpClient('field-03-import-service-root', { startupTimeoutMs: 20000 }));
  await client.start();
  await client.initialize();
  const instanceId = process.env.MCP_INSTANCE_ID;
  assert(typeof instanceId === 'string' && instanceId.length > 0, 'managed instance id is set');
  const execute = (code) => client.callTool('execute_luau', { instance_id: instanceId, target: 'edit', code });
  const dir = mkdtempSync(join(tmpdir(), 'rsmcp-field03-'));
  const serviceFile = join(dir, 'scs.rbxm');
  const guiFile = join(dir, 'gui.rbxm');

  try {
    const setup = await execute(`
local scs = game:GetService("StarterPlayer"):WaitForChild("StarterCharacterScripts")
for _, name in ipairs({"${NAMES[0]}", "${NAMES[1]}"}) do
  local old = scs:FindFirstChild(name)
  if old then old:Destroy() end
  local s = Instance.new("LocalScript")
  s.Name = name
  s.Source = "print('" .. name .. "')"
  s.Parent = scs
end
return #scs:GetChildren()`);
    log('setup', setup);
    assert(setup.success === true, 'execute_luau created 2 LocalScripts under StarterCharacterScripts');
    const childrenBefore = Number(setup.returnValue);

    const exported = await client.callTool('export_rbxm', {
      instance_id: instanceId, instance_paths: [SCS], output_path: serviceFile,
    });
    log('export_rbxm(StarterCharacterScripts)', exported);
    assert(!exported.error && statSync(serviceFile).size > 0, 'service-rooted rbxm exported');

    const cleared = await execute(`
local scs = game:GetService("StarterPlayer").StarterCharacterScripts
for _, c in ipairs(scs:GetChildren()) do c:Destroy() end
return #scs:GetChildren()`);
    assert(String(cleared.returnValue) === '0', 'StarterCharacterScripts emptied before import');

    const importResult = await client.callToolResult('import_rbxm', {
      instance_id: instanceId, source: { path: serviceFile }, parent_path: SCS,
    });
    log('import_rbxm(parent_path=StarterCharacterScripts)', importResult);
    const body = importResult.body;
    if (body?.error) {
      throw new Error(`import_rbxm rejected the service-rooted rbxm: ${body.error}`);
    }
    assert(body.unwrappedServiceRoot === 'StarterCharacterScripts', 'result reports unwrappedServiceRoot: "StarterCharacterScripts"');
    assert(body.instanceCount === childrenBefore, `instanceCount equals ${childrenBefore}`);
    assert(Array.isArray(body.rootClasses) && body.rootClasses.every((c) => c === 'LocalScript'), 'rootClasses are LocalScript');

    const verify = await execute(`
local scs = game:GetService("StarterPlayer").StarterCharacterScripts
local names, classes = {}, {}
for _, c in ipairs(scs:GetChildren()) do
  table.insert(names, c.Name)
  table.insert(classes, c.ClassName)
end
table.sort(names)
return { count = #scs:GetChildren(), names = names, classes = classes, service = scs:FindFirstChildOfClass("StarterCharacterScripts") ~= nil }`);
    log('verify', verify);
    const rv = JSON.parse(verify.returnValue);
    assert(rv.count === childrenBefore, `StarterCharacterScripts has ${childrenBefore} children after import`);
    assert(rv.classes.every((c) => c === 'LocalScript'), 'every child is a LocalScript');
    assert(JSON.stringify(rv.names) === JSON.stringify([...NAMES].sort()), 'child names match the exported scripts');
    assert(rv.service === false, 'no nested StarterCharacterScripts instance was left behind');

    const guiSetup = await execute(`
local sg = game:GetService("StarterGui")
local old = sg:FindFirstChild("${GUI_ROOT}")
if old then old:Destroy() end
local gui = Instance.new("ScreenGui")
gui.Name = "${GUI_ROOT}"
gui.Parent = sg
local f = Instance.new("Frame", gui)
f.Name = "Frame"
local t = Instance.new("TextLabel", f)
t.Name = "Label"
return #gui:GetDescendants()`);
    assert(guiSetup.success === true, 'regression: ScreenGui with 2 descendants created in StarterGui');
    const guiExport = await client.callTool('export_rbxm', {
      instance_id: instanceId, instance_paths: [`game.StarterGui.${GUI_ROOT}`], output_path: guiFile,
    });
    log('export_rbxm(StarterGui child)', guiExport);
    await execute(`game:GetService("StarterGui").${GUI_ROOT}:Destroy() return true`);
    const guiImport = await client.callTool('import_rbxm', {
      instance_id: instanceId, source: { path: guiFile }, parent_path: 'game.StarterGui',
    });
    log('import_rbxm(parent_path=StarterGui)', guiImport);
    assert(!guiImport.error && guiImport.instance_count === 1, 'regression: non-service import still parents 1 root');
    assert(guiImport.unwrappedServiceRoot === undefined, 'regression: no unwrappedServiceRoot for a ScreenGui root');
    const guiVerify = await execute(`
local gui = game:GetService("StarterGui"):FindFirstChild("${GUI_ROOT}")
return gui and gui.ClassName == "ScreenGui" and #gui:GetDescendants() == 2`);
    assert(String(guiVerify.returnValue) === 'true', 'regression: ScreenGui round-trips into StarterGui with its 2 descendants');
  } finally {
    await execute(`
local scs = game:GetService("StarterPlayer").StarterCharacterScripts
for _, name in ipairs({"${NAMES[0]}", "${NAMES[1]}"}) do
  local c = scs:FindFirstChild(name) if c then c:Destroy() end
end
local n = scs:FindFirstChildOfClass("StarterCharacterScripts") if n then n:Destroy() end
local gui = game:GetService("StarterGui"):FindFirstChild("${GUI_ROOT}") if gui then gui:Destroy() end
return true`).catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
});
