#!/usr/bin/env node
// Live diagnostic: serialized public start/stop calls without an extra settle barrier.
// Run through run-all.mjs --managed so its finally closes only our disposable Studio.
import { BASE_PORT, McpClient, assert, runTest, waitForEditPeer } from './lib/mcp-client.mjs';
import { callMcpHttpTool } from './lib/mcp-http-client.mjs';

const cycles = Number.parseInt(process.env.RSMCP_PLAY_CYCLES ?? '8', 10);
if (!Number.isSafeInteger(cycles) || cycles < 1 || cycles > 100) {
  throw new Error('RSMCP_PLAY_CYCLES must be an integer from 1 through 100');
}
const instanceId = process.env.MCP_INSTANCE_ID;
if (!instanceId) throw new Error('Run this diagnostic through the managed runner');
const settle = process.env.RSMCP_PLAY_SETTLE === '1';
const direct = process.env.RSMCP_PLAY_DIRECT === '1';

await runTest(`serialized playtest control (settle=${settle}, direct=${direct})`, async ({ track }) => {
  const stdio = track(new McpClient('playtest-control-repro'));
  await stdio.start();
  await stdio.initialize();
  const client = direct ? {
    callTool(name, args = {}, timeoutMs = 30_000) {
      return callMcpHttpTool(name, args, { port: BASE_PORT, env: process.env, timeoutMs });
    },
  } : stdio;
  await waitForEditPeer(client, { timeoutMs: 120_000 });
  const version = await client.callTool('execute_luau', {
    instance_id: instanceId, target: 'edit', code: 'return version()',
  });
  console.log(`Studio version: ${version.returnValue}`);

  for (let cycle = 1; cycle <= cycles; cycle += 1) {
    for (const action of ['start', 'stop']) {
      const args = { instance_id: instanceId, action, timeout: 30 };
      if (action === 'start') args.mode = 'play';
      const startedAt = Date.now();
      try {
        const result = await client.callTool('solo_playtest', args, 45_000);
        console.log(JSON.stringify({ cycle, action, elapsedMs: Date.now() - startedAt, result }));
        assert(result.success === true, `cycle ${cycle}: ${action} succeeds`);
      } catch (error) {
        console.error(`cycle ${cycle} ${action} failed after ${Date.now() - startedAt}ms: ${error.message}`);
        // Observe without retrying any mutation whose outcome might be unknown.
        for (const [name, probeArgs] of [
          ['solo_playtest', { instance_id: instanceId, action: 'status' }],
          ['execute_luau', {
            instance_id: instanceId, target: 'edit',
            code: 'return { editModeActive = game:GetService("StudioTestService").EditModeActive, running = game:GetService("RunService"):IsRunning() }',
          }],
          ['get_runtime_logs', {
            instance_id: instanceId, tail: 20, filter: 'Playtest ended with error',
          }],
        ]) {
          try {
            console.error(JSON.stringify({ probe: name, result: await client.callTool(name, probeArgs, 10_000) }));
          } catch (probeError) {
            console.error(`${name} observation failed: ${probeError.message}`);
          }
        }
        throw error;
      }
    }
    if (settle) {
      // Wait on the external Studio engine, not a guessed wall-clock delay.
      const settled = await client.callTool('execute_luau', {
        instance_id: instanceId, target: 'edit',
        code: 'local s = game:GetService("StudioTestService") local deadline = os.clock() + 10 while not s.EditModeActive and os.clock() < deadline do task.wait() end return tostring(s.EditModeActive)',
      }, 15_000);
      assert(settled.success === true && settled.returnValue === 'true', `cycle ${cycle}: native edit mode settled`);
    }
  }
  // Do not issue cleanup mutations here: the managed runner owns process cleanup,
  // including failures whose late execution must not be confused with a retry.
}).then((ok) => process.exit(ok ? 0 : 1));
