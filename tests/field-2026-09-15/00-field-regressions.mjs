#!/usr/bin/env node
// Field report "behaviors that must keep working": solo_playtest start ≤ 15 s and a prompt stop,
// eval_server_runtime/eval_client_runtime reach live modules through the require cache,
// export_rbxm reads the edit DataModel during play, grep_scripts stays fast.
import { McpClient, assert, runTest, safeStopPlaytest, startPlaytestAndWait, waitForEditPeer } from '../lib/mcp-client.mjs';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const FIXTURE = '__Field0_Regressions';

await runTest('field regression list', async ({ track }) => {
  const client = track(new McpClient('field-00'));
  await client.start();
  await client.initialize();
  await waitForEditPeer(client, { timeoutMs: 120_000 });

  const setup = await client.callTool('execute_luau', {
    target: 'edit',
    code: `
local SS = game:GetService("ServerStorage")
local old = SS:FindFirstChild("${FIXTURE}") if old then old:Destroy() end
local folder = Instance.new("Folder") folder.Name = "${FIXTURE}" folder.Parent = SS
local m = Instance.new("ModuleScript") m.Name = "Counter" m.Source = "local M = {n = 0} function M.bump() M.n += 1 return M.n end return M" m.Parent = folder
for i = 1, 50 do local s = Instance.new("Script") s.Name = "S"..i s.Source = "-- field0 filler "..i.."\\nlocal x = "..i.."\\nreturn x" s.Parent = folder end
for i = 1, 5 do local p = Instance.new("Part") p.Name = "P"..i p.Parent = folder end
return #folder:GetChildren()`,
  });
  assert(setup.returnValue === 56 || setup.returnValue === '56', `fixture has 56 children (${JSON.stringify(setup.returnValue)})`);

  const grepStart = Date.now();
  const grep = await client.callTool('grep_scripts', { pattern: 'field0 filler' });
  const grepMs = Date.now() - grepStart;
  console.log(JSON.stringify({ grepMs, matches: grep.totalMatches ?? grep.matches?.length ?? grep }));
  assert(grepMs < 5000, `grep_scripts ${grepMs} ms < 5000 ms`);

  const startAt = Date.now();
  await startPlaytestAndWait(client, { timeoutSec: 30 });
  const startMs = Date.now() - startAt;
  console.log(JSON.stringify({ soloPlaytestStartMs: startMs }));
  assert(startMs <= 15_000 + 1500, `solo_playtest start ${startMs} ms ≤ 15 s (+1.5 s poll allowance)`);
  try {
    const a = await client.callTool('eval_server_runtime', { code: `return require(game:GetService("ServerStorage").${FIXTURE}.Counter).bump()` }, 30_000);
    const b = await client.callTool('eval_server_runtime', { code: `return require(game:GetService("ServerStorage").${FIXTURE}.Counter).bump()` }, 30_000);
    console.log(JSON.stringify({ evalServerA: a.returnValue ?? a, evalServerB: b.returnValue ?? b }));
    assert(Number(b.returnValue ?? b.result) === 2, 'eval_server_runtime require cache: second call returns 2');

    const c = await client.callTool('eval_client_runtime', { code: 'return game:GetService("Players").LocalPlayer.Name' }, 30_000);
    console.log(JSON.stringify({ evalClient: c.returnValue ?? c }));
    assert(typeof (c.returnValue ?? c.result) === 'string', 'eval_client_runtime returns the LocalPlayer name');

    const dir = mkdtempSync(join(tmpdir(), 'field0-'));
    try {
      const file = join(dir, 'fixture.rbxm');
      const exported = await client.callTool('export_rbxm', { instance_paths: [`ServerStorage.${FIXTURE}`], output_path: file }, 60_000);
      console.log(JSON.stringify({ exported }));
      assert(readFileSync(file).length > 500, `export_rbxm wrote the edit DataModel fixture during play (${file})`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  } finally {
    const stopAt = Date.now();
    await safeStopPlaytest(client);
    console.log(JSON.stringify({ soloPlaytestStopMs: Date.now() - stopAt }));
  }
  await client.callTool('execute_luau', { target: 'edit', code: `local f = game:GetService("ServerStorage"):FindFirstChild("${FIXTURE}") if f then f:Destroy() end return true` });
}).then((ok) => process.exit(ok ? 0 : 1));
