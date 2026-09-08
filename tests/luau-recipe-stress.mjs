#!/usr/bin/env node
import assert from 'node:assert/strict';
import { BASE_PORT, McpClient, runTest } from './lib/mcp-client.mjs';

await runTest('live recipe transfer stress', async ({ track }) => {
  const client = track(new McpClient('recipe-stress', { startupTimeoutMs: 20000 }));
  await client.start();
  await client.initialize();
  const instance_id = process.env.MCP_INSTANCE_ID;
  assert.ok(instance_id);
  const root = '__RSMCP_Recipes';
  let calls = 0;
  let verification = 'return true';
  async function call(name, args) {
    const started = performance.now();
    try {
      const value = await client.callTool(name, { instance_id, ...args });
      assert.notEqual(value.success, false, JSON.stringify(value));
      assert.ok(!value.summary?.failed, JSON.stringify(value));
      if (performance.now() - started > 500) console.log(JSON.stringify({ slow: name, calls, elapsedMs: performance.now() - started, argumentBytes: Buffer.byteLength(JSON.stringify(args)), timestamp: new Date().toISOString() }));
      calls++;
      return value;
    } catch (error) {
      console.log(JSON.stringify({ failure: error.message, name, calls, argumentBytes: Buffer.byteLength(JSON.stringify(args)), elapsedMs: performance.now() - started, timestamp: new Date().toISOString() }));
      console.log('instances', JSON.stringify(await client.callTool('get_connected_instances', {}).catch(e => e.message)));
      const readbackStarted = performance.now();
      const readback = await client.callTool('execute_luau', { instance_id, target: 'edit', code: verification }).catch(e => e.message);
      console.log('readback', JSON.stringify({ elapsedMs: performance.now() - readbackStarted, result: readback }));
      throw error;
    }
  }
  const execute = code => call('execute_luau', { code, target: 'edit' });
  const literal = text => `[====[${text}]====]`;
  try {
    await execute(`local old=workspace:FindFirstChild('${root}') if old then old:Destroy() end local f=Instance.new('Folder', workspace) f.Name='${root}' local s=Instance.new('StringValue',f) s.Name='Text' return true`);
    if (process.env.RSMCP_HTTP_PRESSURE === '1') {
      // Real engine HTTP traffic, not a mocked transport or a sleep past the deadline.
      // Background work only reads this test server's health endpoint.
      await execute(`task.spawn(function()
local h=game:GetService('HttpService')
local f=workspace.${root}
local n=0
for i=1,2000 do
  local ok,err=pcall(function() h:GetAsync('http://localhost:${BASE_PORT}/health', true) end)
  if not ok then warn('[quota-probe] '..tostring(err)) break end
  n=i
end
f:SetAttribute('HealthRequests', n)
end) return true`);
    }
    const rounds = Number(process.env.RSMCP_RECIPE_ROUNDS ?? 100);
    for (let round = 0; round < rounds; round++) {
      const partCount = [30, 40, 180, 400][round % 4];
      const modelName = `Recipe${round}`;
      const lines = [`local model=Instance.new('Model') model.Name='${modelName}'`];
      for (let part = 0; part < partCount; part++) {
        lines.push(`do local p=Instance.new('Part') p.Name='Part${part}' p.Anchored=true p.Size=Vector3.new(1,2,3) p.CFrame=CFrame.new(${part % 20},${Math.floor(part / 20) * 3},0) p.Color=Color3.fromRGB(${part % 256},128,64) p.Material=Enum.Material.SmoothPlastic p.Parent=model end`);
      }
      lines.push(`model.Parent=workspace.${root} return true`);
      const recipe = lines.join('\n');
      const mode = ['direct', 'attributes', 'folders', 'string-value'][Math.floor(round / 4) % 4];
      verification = `local m=workspace.${root}:FindFirstChild('${modelName}') return m ~= nil and #m:GetChildren() == ${partCount}`;
      if (mode === 'direct') {
        await execute(recipe);
      } else {
        const chunks = [];
        for (let offset = 0; offset < recipe.length; offset += 3000) chunks.push(recipe.slice(offset, offset + 3000));
        for (let index = 0; index < chunks.length; index++) {
          const chunk = chunks[index];
          const key = `Chunk${index}`;
          verification = mode === 'folders'
            ? `local f=workspace.${root}:FindFirstChild('${key}') return f ~= nil and f:GetAttribute('Text') == ${literal(chunk)}`
            : `return workspace.${root}:GetAttribute('${key}') == ${literal(chunk)}`;
          if (mode === 'attributes') {
            await execute(`workspace.${root}:SetAttribute('${key}', ${literal(chunk)}) return true`);
          } else if (mode === 'folders') {
            await execute(`local f=workspace.${root}:FindFirstChild('${key}') or Instance.new('Folder', workspace.${root}) f.Name='${key}' f:SetAttribute('Text', ${literal(chunk)}) return true`);
          } else {
            verification = `return workspace.${root}.Text.Value == ${literal(chunk)}`;
            await call('set_properties', { instancePath: `game.Workspace.${root}.Text`, properties: { Value: chunk } });
            await execute(`workspace.${root}:SetAttribute('${key}', workspace.${root}.Text.Value) return true`);
          }
          const value = mode === 'folders' ? `workspace.${root}.${key}:GetAttribute('Text')` : `workspace.${root}:GetAttribute('${key}')`;
          const verify = await execute(`return ${value} == ${literal(chunk)}`);
          assert.equal(String(verify.returnValue), 'true');
        }
        const lookup = mode === 'folders' ? `workspace.${root}['Chunk'..i]:GetAttribute('Text')` : `workspace.${root}:GetAttribute('Chunk'..i)`;
        verification = `local m=workspace.${root}:FindFirstChild('${modelName}') return m ~= nil and #m:GetChildren() == ${partCount}`;
        await execute(`local chunks={} for i=0,${chunks.length - 1} do table.insert(chunks, ${lookup}) end local fn,err=loadstring(table.concat(chunks)) assert(fn,err) return fn()`);
      }
      const verified = await execute(`local m=workspace.${root}:FindFirstChild('${modelName}') return m ~= nil and #m:GetChildren() == ${partCount}`);
      assert.equal(String(verified.returnValue), 'true');
      await execute(`workspace.${root}.${modelName}:Destroy() return true`);
      console.log(JSON.stringify({ round, mode, recipeBytes: Buffer.byteLength(recipe), partCount, calls, timestamp: new Date().toISOString() }));
    }
  } finally {
    await execute(`local f=workspace:FindFirstChild('${root}') if f then f:Destroy() end return true`).catch(() => {});
  }
});
