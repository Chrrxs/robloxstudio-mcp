#!/usr/bin/env node
// Field report #6 + #15: a client runtime error is ONE get_runtime_logs entry (message + script + line + stack),
// level/since_ts/exclude filter the stream, and dedupe:true collapses 5 identical errors into count:5.

import {
  McpClient,
  runTest,
  assert,
  startPlaytestAndWait,
  safeStopPlaytest,
} from '../lib/mcp-client.mjs';
import { setTimeout as delay } from 'node:timers/promises';

const ONCE_MESSAGE = 'Field6 boom once';
const FIVE_MESSAGE = 'Field6 boom five';

const SETUP = `
local StarterGui = game:GetService("StarterGui")
local old = StarterGui:FindFirstChild("Field6Gui")
if old then old:Destroy() end
local gui = Instance.new("ScreenGui")
gui.Name = "Field6Gui"
gui.ResetOnSpawn = false
local once = Instance.new("LocalScript")
once.Name = "Field6Once"
once.Enabled = false
once.Source = 'error("${ONCE_MESSAGE}")'
once.Parent = gui
local five = Instance.new("LocalScript")
five.Name = "Field6Five"
five.Enabled = false
five.Source = 'for i = 1, 5 do\\n\\ttask.spawn(function()\\n\\t\\terror("${FIVE_MESSAGE}")\\n\\tend)\\nend'
five.Parent = gui
gui.Parent = StarterGui
return "ready"
`;

const CLEANUP = `
local old = game:GetService("StarterGui"):FindFirstChild("Field6Gui")
if old then old:Destroy() end
return "clean"
`;

function enableScript(name) {
  return `
local gui = game:GetService("Players").LocalPlayer:WaitForChild("PlayerGui"):WaitForChild("Field6Gui", 10)
local target = gui:WaitForChild("${name}", 10)
target.Enabled = true
return target:GetFullName()
`;
}

function dump(label, body) {
  console.log(`  [${label}] ${JSON.stringify(body)}`);
}

await runTest('field #6/#15: runtime error merge, level/since_ts/exclude, dedupe', async ({ track }) => {
  const client = track(new McpClient('A'));
  await client.start();
  await client.initialize();

  const setup = await client.callTool('execute_luau', { target: 'edit', code: SETUP });
  assert(setup.success === true && String(setup.returnValue) === 'ready', 'edit DM staged StarterGui.Field6Gui with two disabled LocalScripts');

  await startPlaytestAndWait(client);
  try {
    const enabledOnce = await client.callTool('eval_client_runtime', { target: 'client-1', code: enableScript('Field6Once') });
    assert(enabledOnce.ok === true, `Field6Once enabled at ${enabledOnce.result}`);
    await delay(750);

    const rawOnce = await client.callTool('get_runtime_logs', { filter: 'Field6', tail: 20 });
    dump('raw filter=Field6', rawOnce.entries);
    const onceEntries = (rawOnce.entries ?? []).filter((entry) => entry.message.includes(ONCE_MESSAGE) || entry.message.includes('Field6Once'));
    assert(onceEntries.length === 1, `one error yields exactly one entry mentioning Field6Once (got ${onceEntries.length})`);
    const once = onceEntries[0];
    assert(once.level === 'ERR', `the merged entry keeps level ERR (got ${once.level})`);
    assert(typeof once.script === 'string' && once.script.endsWith('Field6Gui.Field6Once'), `script is the LocalScript path (got ${once.script})`);
    assert(once.line === 1, `line is 1 (got ${once.line})`);
    assert(Array.isArray(once.stack) && once.stack.length >= 1 && once.stack[0].startsWith("Script '"), `stack holds the Script frames (got ${JSON.stringify(once.stack)})`);

    const errOnly = await client.callTool('get_runtime_logs', { level: 'ERR', filter: 'Field6', tail: 20 });
    dump('level=ERR filter=Field6', errOnly.entries);
    assert(errOnly.entries.length === 1, `level:"ERR" returns exactly the merged error (got ${errOnly.entries.length})`);
    const infoOnly = await client.callTool('get_runtime_logs', { level: 'INFO', filter: 'Field6', tail: 20 });
    dump('level=INFO filter=Field6', infoOnly.entries);
    assert(infoOnly.entries.length === 0, `no separate INFO "Script ..., Line N" entry remains (got ${infoOnly.entries.length})`);

    const invalid = await client.callToolError('get_runtime_logs', { level: 'error' });
    dump('level=error', invalid);
    const invalidText = JSON.stringify(invalid);
    assert(invalidText.includes('level must be one of') || invalidText.includes('allowed values'), 'an unknown level is rejected (schema enum or server check)');

    const enabledFive = await client.callTool('eval_client_runtime', { target: 'client-1', code: enableScript('Field6Five') });
    assert(enabledFive.ok === true, `Field6Five enabled at ${enabledFive.result}`);
    await delay(750);

    const fiveRaw = await client.callTool('get_runtime_logs', { level: 'ERR', filter: FIVE_MESSAGE, tail: 50 });
    dump('level=ERR filter=five', fiveRaw.entries);
    assert(fiveRaw.entries.length === 5, `five identical errors are five merged entries without dedupe (got ${fiveRaw.entries.length})`);
    assert(fiveRaw.entries.every((entry) => entry.line === 3 && Array.isArray(entry.stack)), 'each of the five carries line 3 and a stack');

    const deduped = await client.callTool('get_runtime_logs', { level: 'ERR', filter: FIVE_MESSAGE, dedupe: true, tail: 50 });
    dump('dedupe=true', deduped.entries);
    assert(deduped.entries.length === 1, `dedupe:true collapses them into one entry (got ${deduped.entries.length})`);
    assert(deduped.entries[0].count === 5, `count is 5 (got ${deduped.entries[0].count})`);
    assert(typeof deduped.entries[0].firstTs === 'number' && typeof deduped.entries[0].lastTs === 'number' && deduped.entries[0].firstTs <= deduped.entries[0].lastTs, 'firstTs/lastTs bracket the repeats');

    const fiveFirstTs = fiveRaw.entries[0].ts;
    assert(typeof fiveFirstTs === 'number' && fiveFirstTs > once.ts, 'the five errors are timestamped after the first error');
    const sinceSeconds = await client.callTool('get_runtime_logs', { level: 'ERR', filter: 'Field6', since_ts: fiveFirstTs, tail: 50 });
    dump('since_ts seconds', sinceSeconds.entries.map((entry) => entry.message));
    assert(sinceSeconds.entries.length === 5 && sinceSeconds.entries.every((entry) => entry.message.includes(FIVE_MESSAGE)), `since_ts (seconds) drops the earlier error (got ${sinceSeconds.entries.length})`);
    const sinceMillis = await client.callTool('get_runtime_logs', { level: 'ERR', filter: 'Field6', since_ts: Math.round(fiveFirstTs * 1000), tail: 50 });
    assert(sinceMillis.entries.length === 5, `since_ts (milliseconds) is accepted too (got ${sinceMillis.entries.length})`);

    const excluded = await client.callTool('get_runtime_logs', { level: 'ERR', filter: 'Field6', exclude: 'five', tail: 50 });
    dump('exclude=five', excluded.entries.map((entry) => entry.message));
    assert(excluded.entries.length === 1 && excluded.entries[0].message.includes(ONCE_MESSAGE), `exclude:"five" leaves only the first error (got ${excluded.entries.length})`);
  } finally {
    await safeStopPlaytest(client);
    try {
      await client.callTool('execute_luau', { target: 'edit', code: CLEANUP });
    } catch (error) {
      console.warn(`  (cleanup error, ignored): ${error.message}`);
    }
  }
}).then((ok) => process.exit(ok ? 0 : 1));
