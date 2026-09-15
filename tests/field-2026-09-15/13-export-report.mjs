#!/usr/bin/env node
// Field report #13 + #14: export_rbxm reports bytes/instanceCount/rootClass/rootName for a known tree (1 Folder + 5 Parts = 6 instances) and import_rbxm reports instanceCount/rootNames/rootClasses for the same tree.
// Run: node tests/run-with-test-port.mjs tests/run-all.mjs --managed --test field-2026-09-15/13-export-report.mjs
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { McpClient, runTest, assert } from '../lib/mcp-client.mjs';

const ROOT = '__RSMCP_ExportReport';
const PART_COUNT = 5;

function log(label, value) {
  console.log(`[${new Date().toISOString()}] ${label}: ${JSON.stringify(value)}`);
}

await runTest('field #13/#14 export_rbxm and import_rbxm size/count reports', async ({ track }) => {
  const client = track(new McpClient('field-13-export-report', { startupTimeoutMs: 20000 }));
  await client.start();
  await client.initialize();
  const instanceId = process.env.MCP_INSTANCE_ID;
  assert(typeof instanceId === 'string' && instanceId.length > 0, 'managed instance id is set');
  const execute = (code) => client.callTool('execute_luau', { instance_id: instanceId, target: 'edit', code });
  const dir = mkdtempSync(join(tmpdir(), 'rsmcp-field13-'));
  const file = join(dir, 'tree.rbxm');
  const multiFile = join(dir, 'multi.rbxm');

  try {
    const setup = await execute(`
for _, svc in ipairs({workspace, game:GetService("ReplicatedStorage")}) do
  local old = svc:FindFirstChild("${ROOT}")
  if old then old:Destroy() end
end
local folder = Instance.new("Folder")
folder.Name = "${ROOT}"
for i = 1, ${PART_COUNT} do
  local p = Instance.new("Part")
  p.Name = "P" .. i
  p.Anchored = true
  p.Parent = folder
end
folder.Parent = workspace
return #folder:GetDescendants() + 1`);
    log('setup', setup);
    assert(String(setup.returnValue) === String(PART_COUNT + 1), `tree has ${PART_COUNT + 1} instances including the root`);

    const exported = await client.callTool('export_rbxm', {
      instance_id: instanceId, instance_paths: [`game.Workspace.${ROOT}`], output_path: file,
    });
    log('export_rbxm', exported);
    const fileBytes = statSync(file).size;
    assert(exported.bytes === fileBytes, `bytes (${exported.bytes}) equals the file size on disk (${fileBytes})`);
    assert(exported.instanceCount === PART_COUNT + 1, `instanceCount is ${PART_COUNT + 1} (root + descendants)`);
    assert(exported.rootClass === 'Folder', 'rootClass is Folder');
    assert(exported.rootName === ROOT, `rootName is ${ROOT}`);
    assert(exported.bytes_written === fileBytes && exported.instance_count === 1, 'existing bytes_written/instance_count fields are unchanged');

    const multi = await client.callTool('export_rbxm', {
      instance_id: instanceId,
      instance_paths: [`game.Workspace.${ROOT}`, `game.Workspace.${ROOT}.P1`],
      output_path: multiFile,
    });
    log('export_rbxm(2 roots)', multi);
    assert(multi.instanceCount === PART_COUNT + 2 && multi.instance_count === 2, 'two roots: instanceCount counts every root subtree');
    assert(JSON.stringify(multi.rootClasses) === JSON.stringify(['Folder', 'Part']), 'rootClasses lists every root class in order');
    assert(JSON.stringify(multi.rootNames) === JSON.stringify([ROOT, 'P1']), 'rootNames lists every root name in order');

    const imported = await client.callTool('import_rbxm', {
      instance_id: instanceId, source: { path: file }, parent_path: 'game.ReplicatedStorage',
    });
    log('import_rbxm', imported);
    assert(imported.instanceCount === PART_COUNT + 1, `import instanceCount is ${PART_COUNT + 1}`);
    assert(JSON.stringify(imported.rootNames) === JSON.stringify([ROOT]), 'import rootNames lists the Folder');
    assert(JSON.stringify(imported.rootClasses) === JSON.stringify(['Folder']), 'import rootClasses lists Folder');
    assert(imported.instance_count === 1 && JSON.stringify(imported.instance_names) === JSON.stringify([ROOT]), 'existing import fields are unchanged');

    const verify = await execute(`
local f = game:GetService("ReplicatedStorage"):FindFirstChild("${ROOT}")
return f and (#f:GetDescendants() + 1) or -1`);
    assert(String(verify.returnValue) === String(PART_COUNT + 1), 'imported tree has the reported instance count in the DataModel');
  } finally {
    await execute(`
for _, svc in ipairs({workspace, game:GetService("ReplicatedStorage")}) do
  local old = svc:FindFirstChild("${ROOT}")
  if old then old:Destroy() end
end
return true`).catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
});
