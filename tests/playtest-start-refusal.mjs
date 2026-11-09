#!/usr/bin/env node
// Live regression for #167: solo_playtest refuses a Run that TestService would turn
// into a separate multi-client session (the route into Studio's stuck "previous one
// is still in progress" state), and Run works again once the settings are restored.
// Studio's refusal itself only appears once Studio is stuck, so the offline suites
// cover how MCP reports it.
import { McpClient, assert, runTest, waitForEditPeer } from './lib/mcp-client.mjs';

const instanceId = process.env.MCP_INSTANCE_ID;
if (!instanceId) throw new Error('Run this test through the managed runner');

await runTest('solo playtest start refusals (#167)', async ({ track }) => {
  const client = track(new McpClient('playtest-start-refusal'));
  await client.start();
  await client.initialize();
  await waitForEditPeer(client, { timeoutMs: 120_000 });
  const luau = async (code) => {
    const result = await client.callTool('execute_luau', { instance_id: instanceId, target: 'edit', code }, 30_000);
    assert(result.success === true, `edit Luau ran: ${JSON.stringify(result)}`);
    return result.returnValue;
  };
  // Failed starts are tool errors; return their bodies for the assertions below.
  const solo = async (args, timeoutMs = 75_000) =>
    (await client.callToolResult('solo_playtest', { instance_id: instanceId, ...args }, timeoutMs)).body;

  const original = await luau(
    'local t = game:GetService("TestService") return tostring(t.ExecuteWithStudioRun) .. "," .. tostring(t.NumberOfPlayers)',
  );
  const [originalExecute, originalPlayers] = String(original).split(',');
  try {
    await luau('local t = game:GetService("TestService") t.ExecuteWithStudioRun = true t.NumberOfPlayers = 2 return "set"');
    const refused = await solo({ action: 'start', mode: 'run', timeout: 30 });
    console.log(JSON.stringify({ step: 'run with TestService NumberOfPlayers=2', refused }));
    assert(refused.success === false, 'Run with TestService clients is refused');
    assert(refused.error === 'run_opens_multiplayer_session', `refusal names the cause: ${refused.error}`);
    assert(/NumberOfPlayers is 2/.test(refused.message), 'refusal reports the configured client count');
    const status = await solo({ action: 'status' });
    assert(status.running === false, `no session was opened: ${JSON.stringify(status)}`);
  } finally {
    await luau(
      `local t = game:GetService("TestService") t.ExecuteWithStudioRun = ${originalExecute === 'true'} ` +
      `t.NumberOfPlayers = ${Number(originalPlayers) || 0} return "restored"`,
    );
  }

  // With TestService restored, Run starts and stops normally.
  const started = await solo({ action: 'start', mode: 'run', timeout: 60 });
  console.log(JSON.stringify({ step: 'run after restore', started }));
  assert(started.success === true, `run starts after restore: ${JSON.stringify(started)}`);
  const stopped = await solo({ action: 'stop', timeout: 30 });
  assert(stopped.success === true, `run stops: ${JSON.stringify(stopped)}`);
}).then((ok) => process.exit(ok ? 0 : 1));
