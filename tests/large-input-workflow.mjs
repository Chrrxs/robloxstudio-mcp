#!/usr/bin/env node
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { BASE_PORT, McpClient, runTest } from './lib/mcp-client.mjs';
import { callMcpHttpTool } from './lib/mcp-http-client.mjs';
import { createLargeInputTransfer, deterministicPartsRecipe, luauString } from './lib/large-input-workflow.mjs';

await runTest('verified staged large-input workflow', async ({ track }) => {
  const client = track(new McpClient('large-input-workflow', { startupTimeoutMs: 20000 }));
  await client.start();
  await client.initialize();
  const instanceId = process.env.MCP_INSTANCE_ID;
  assert.ok(instanceId, 'Run with an explicitly targeted managed instance');
  const transfers = [];
  const raw = code => client.callTool('execute_luau', {
    instance_id: instanceId, target: 'edit', operation_id: randomUUID(), code,
  });
  const invoke = step => client.callTool('execute_luau', step);
  const reject = step => client.callToolError('execute_luau', step);
  const ok = async step => {
    const result = await invoke(step);
    assert.equal(result.success, true, JSON.stringify(result));
    return String(result.returnValue);
  };
  const httpEnv = {
    ...process.env,
    ROBLOX_STUDIO_AUTH_TOKEN: process.env.ROBLOX_STUDIO_AUTH_TOKEN
      ?? readFileSync(join(homedir(), '.robloxstudio-mcp/auth-token'), 'utf8').trim(),
  };
  // Match the guide's HTTP wrapper: the body is the tool result, not content[].
  const httpOk = async args => {
    const result = await callMcpHttpTool('execute_luau', args, { port: BASE_PORT, env: httpEnv });
    assert.equal(result.success, true, JSON.stringify(result));
    return String(result.returnValue);
  };
  const truth = async code => {
    const result = await raw(code);
    assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(String(result.returnValue), 'true');
  };
  function transfer({ failure, large = false } = {}) {
    const id = randomUUID();
    const recipe = deterministicPartsRecipe(id, 40);
    // Force multi-byte code points across several configured byte boundaries.
    recipe.source = `-- ${'é雪𐍈'.repeat(large ? 6000 : 40)}\n${recipe.source}`;
    const effectsVerification = recipe.verification;
    if (failure) {
      recipe.source = `local marker = game:GetService('ServerStorage')[${luauString(`__RSMCP_Transfer_${id}`)}] marker:SetAttribute('Attempts', (marker:GetAttribute('Attempts') or 0) + 1)\n${recipe.source}`;
      if (failure === 'runtime') recipe.source += "\nerror('intentional failure after effects')";
      if (failure === 'verification') recipe.verification = 'return false';
      if (failure === 'compile') recipe.source += '\nlocal =';
    }
    const value = createLargeInputTransfer({
      instanceId, transferId: id, ...recipe, ...(large ? {} : { chunkBytes: 127 }),
    });
    value.effectsVerification = effectsVerification;
    transfers.push(value);
    return value;
  }
  async function upload(value, skip = -1, send = ok) {
    await send(value.begin());
    for (let i = 0; i < value.chunkCount; i++) {
      if (i === skip) continue;
      await send(value.writeChunk(i));
      assert.equal(await send(value.readChunk(i)), 'true');
    }
  }
  async function rejectWithoutEffects(value) {
    const result = await reject(value.finalize());
    assert.equal(result.success, false, JSON.stringify(result));
    await truth(`return workspace:FindFirstChild(${luauString(value.outputName)}) == nil`);
    assert.equal(await ok(value.inspect()), 'uploading');
  }
  try {
    const success = transfer({ large: true });
    assert.ok(success.manifest.bytes > 45000, 'Success must exercise genuinely large UTF-8 source');
    assert.ok(success.chunkCount >= 3, 'Success must stage multiple default-sized chunks');
    await upload(success, -1, httpOk);
    assert.equal(await httpOk(success.finalize()), 'complete');
    // A new transport operation ID exercises the persistent marker, not server deduplication.
    assert.equal(await httpOk(success.finalize()), 'complete');
    assert.equal(await httpOk(success.inspect()), 'completed');
    await truth(success.verification);
    await truth(`local count = 0 for _, child in workspace:GetChildren() do if child.Name == ${luauString(success.outputName)} then count += 1 end end return count == 1`);
    await truth(`local root = game:GetService('ServerStorage'):FindFirstChild(${luauString(success.rootName)}) return root ~= nil and root.Archivable == false and root:GetAttribute('State') == 'completed' and root:FindFirstChild('Chunks') == nil`);

    const missing = transfer();
    await upload(missing, 1);
    await rejectWithoutEffects(missing);
    assert.equal(await ok(missing.abort()), 'aborted');
    await truth(`return game:GetService('ServerStorage'):FindFirstChild(${luauString(missing.rootName)}) == nil`);

    const corrupt = transfer();
    await upload(corrupt);
    await raw(`game:GetService('ServerStorage')[${luauString(corrupt.rootName)}].Chunks.Chunk1.Value = 'tampered' return true`);
    await rejectWithoutEffects(corrupt);
    await ok(corrupt.abort());

    const reordered = transfer();
    await upload(reordered);
    await raw(`local c = game:GetService('ServerStorage')[${luauString(reordered.rootName)}].Chunks local a, b = c.Chunk1.Value, c.Chunk2.Value c.Chunk1.Value = b c.Chunk2.Value = a return true`);
    await rejectWithoutEffects(reordered);
    await ok(reordered.abort());

    const failed = transfer({ failure: 'runtime' });
    await upload(failed);
    assert.equal((await reject(failed.finalize())).success, false);
    assert.equal(await ok(failed.inspect()), 'failed');
    await truth(failed.verification); // A known error did not roll back created geometry.
    assert.equal((await reject(failed.finalize())).success, false);
    assert.equal((await reject(failed.abort())).success, false);
    await truth(`local root = game:GetService('ServerStorage')[${luauString(failed.rootName)}] return root:GetAttribute('Attempts') == 1 and root:FindFirstChild('Chunks') ~= nil`);

    const failedVerification = transfer({ failure: 'verification' });
    await upload(failedVerification);
    assert.equal((await reject(failedVerification.finalize())).success, false);
    assert.equal(await ok(failedVerification.inspect()), 'failed');
    await truth(failedVerification.effectsVerification);
    assert.equal((await reject(failedVerification.finalize())).success, false);
    assert.equal((await reject(failedVerification.abort())).success, false);
    await truth(`local root = game:GetService('ServerStorage')[${luauString(failedVerification.rootName)}] return root:GetAttribute('Attempts') == 1 and root:FindFirstChild('Chunks') ~= nil`);

    const failedCompile = transfer({ failure: 'compile' });
    await upload(failedCompile);
    await rejectWithoutEffects(failedCompile);
    await truth(`return game:GetService('ServerStorage')[${luauString(failedCompile.rootName)}]:GetAttribute('Attempts') == nil`);
    await ok(failedCompile.abort());

    const foreign = transfer();
    await ok(foreign.begin());
    await raw(`local f = Instance.new('Folder') f.Name = 'Unowned' f.Parent = game:GetService('ServerStorage')[${luauString(foreign.rootName)}].Chunks return true`);
    assert.equal((await reject(foreign.abort())).success, false);
    await truth(`return game:GetService('ServerStorage')[${luauString(foreign.rootName)}].Chunks:FindFirstChild('Unowned') ~= nil`);
    // The test created this sentinel; remove it explicitly, not through transfer cleanup.
    await raw(`game:GetService('ServerStorage')[${luauString(foreign.rootName)}].Chunks.Unowned:Destroy() return true`);
    await ok(foreign.abort());

    const collision = transfer();
    await raw(`local f = Instance.new('Folder') f.Name = ${luauString(collision.rootName)} f.Parent = game:GetService('ServerStorage') return true`);
    assert.equal((await reject(collision.begin())).success, false);
    assert.equal((await reject(collision.abort())).success, false);
    await truth(`local f = game:GetService('ServerStorage'):FindFirstChild(${luauString(collision.rootName)}) return f ~= nil and f:GetAttribute('Owner') == nil`);
    await raw(`game:GetService('ServerStorage')[${luauString(collision.rootName)}]:Destroy() return true`);
    console.log(JSON.stringify({ cases: ['http-geometry-once', 'missing', 'tampered', 'reordered', 'failed-partial-effects-no-replay', 'failed-verification-no-replay', 'compile-failure-zero-effects', 'abort', 'unowned-descendant', 'unowned-root'], chunks: success.chunkCount }));
  } finally {
    // Test-only disposal after observation, never a production recovery policy.
    for (const value of transfers) {
      await raw(`for _, parent in {game:GetService('ServerStorage'), workspace} do
for _, name in {${luauString(value.rootName)}, ${luauString(value.outputName)}} do
local root = parent:FindFirstChild(name)
if root and root:GetAttribute('Owner') == ${luauString(value.transferId)} then
local owned = true for _, child in root:GetDescendants() do if child:GetAttribute('Owner') ~= ${luauString(value.transferId)} then owned = false end end
if owned then root:Destroy() end
end end end return true`).catch(() => {});
    }
  }
});
