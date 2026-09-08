#!/usr/bin/env node
// Issue #75: serialized mutations with tiny responses, followed by independent readbacks.
// Run through run-all.mjs --managed --test luau-payload-transfers.mjs.
import assert from 'node:assert/strict';
import { McpClient, runTest } from './lib/mcp-client.mjs';

await runTest('Luau payload and chunk transfers', async ({ track }) => {
  const client = track(new McpClient('payload-transfers', { startupTimeoutMs: 20000 }));
  await client.start();
  await client.initialize();
  const instanceId = process.env.MCP_INSTANCE_ID;
  assert.ok(instanceId, 'Run with an explicitly targeted managed instance');
  const root = '__RSMCP_PayloadTransfers';
  const failures = [];
  const execute = (code) => client.callTool('execute_luau', {
    instance_id: instanceId, target: 'edit', code,
  });
  async function probe(label, tool, args, verification) {
    const routed = { instance_id: instanceId, ...args };
    const start = performance.now();
    let result;
    let error;
    try {
      result = await client.callTool(tool, routed);
      if (result.success === false || result.summary?.failed > 0) error = JSON.stringify(result);
    } catch (caught) {
      error = caught.message;
    }
    const elapsedMs = Math.round(performance.now() - start);
    const readback = await execute(verification);
    const verified = readback.success === true && String(readback.returnValue) === 'true';
    const record = {
      label, tool, timestamp: new Date().toISOString(),
      argumentBytes: Buffer.byteLength(JSON.stringify(routed)),
      responseBytes: result === undefined ? 0 : Buffer.byteLength(JSON.stringify(result)),
      elapsedMs, error, verified,
    };
    console.log(JSON.stringify(record));
    if (error || !verified) failures.push(record);
    assert.ok(failures.length < 3, `Repeated failures: ${JSON.stringify(failures)}`);
  }
  try {
    const setup = await execute(`
local old = workspace:FindFirstChild('${root}')
if old then old:Destroy() end
local folder = Instance.new('Folder', workspace)
folder.Name = '${root}'
local value = Instance.new('StringValue', folder)
value.Name = 'Text'
return true`);
    assert.equal(setup.success, true);
    const rounds = Number(process.env.RSMCP_PAYLOAD_ROUNDS ?? 3);
    assert.ok(Number.isInteger(rounds) && rounds > 0, 'RSMCP_PAYLOAD_ROUNDS must be a positive integer');
    for (let round = 0; round < rounds; round++) {
      for (const size of [1000, 3000, 9000, 10000, 20000, 45000, 64000, 128000]) {
        const name = `Part_${round}_${size}`;
        const text = 'a'.repeat(size);
        await probe(name, 'execute_luau', {
          target: 'edit',
          code: `local text = '${text}'\nlocal p = Instance.new('Part')\np.Name = '${name}'\np.Anchored = true\np:SetAttribute('Bytes', #text)\np.Parent = workspace.${root}\nreturn true`,
        }, `local p = workspace.${root}:FindFirstChild('${name}') return p ~= nil and p:GetAttribute('Bytes') == ${size}`);
      }
    }
    for (const mode of ['same-folder', 'separate-folders', 'string-value']) {
      for (let index = 0; index < 20; index++) {
        const text = String.fromCharCode(65 + index).repeat(3000);
        const key = `Chunk${index}`;
        if (mode === 'string-value') {
          await probe(`${mode}-${index}`, 'set_properties', {
            instancePath: `game.Workspace.${root}.Text`, properties: { Value: text },
          }, `return workspace.${root}.Text.Value == string.rep('${text[0]}', 3000)`);
        } else {
          const destination = mode === 'same-folder' ? `workspace.${root}` : `workspace.${root}.${key}`;
          const setupFolder = mode === 'same-folder' ? '' : `local f = Instance.new('Folder', workspace.${root}) f.Name = '${key}'\n`;
          await probe(`${mode}-${index}`, 'execute_luau', {
            target: 'edit', code: `${setupFolder}${destination}:SetAttribute('${key}', '${text}') return true`,
          }, `return ${destination}:GetAttribute('${key}') == string.rep('${text[0]}', 3000)`);
        }
      }
    }
    assert.deepEqual(failures, [], 'Every mutation must respond successfully and verify independently');
  } finally {
    await execute(`local f = workspace:FindFirstChild('${root}') if f then f:Destroy() end return true`).catch(() => {});
  }
});
