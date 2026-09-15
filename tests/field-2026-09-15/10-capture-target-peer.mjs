#!/usr/bin/env node
// Field report #10: in play mode capture_screenshot picks client-1 without a target, target:"client-1"/"edit" select a peer explicitly; the result carries peer/target and error text names the peer tried.
// target:"server" and a client-N that is not connected return an explanatory error listing the connected peers.
import assert from 'node:assert/strict';
import { McpClient, runTest, startPlaytestAndWait, safeStopPlaytest, routingPeers } from '../lib/mcp-client.mjs';
import { decodePng, uniqueColours } from './lib/png.mjs';

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

await runTest('field #10 capture_screenshot target peer selection', async ({ track }) => {
  const instanceId = process.env.MCP_INSTANCE_ID;
  assert.ok(instanceId, 'Run with an explicitly targeted managed instance');
  const client = track(new McpClient('field-10', { startupTimeoutMs: 20000 }));
  await client.start(); await client.initialize();
  const tool = (name, args = {}) => client.callTool(name, { instance_id: instanceId, ...args }, 120000);

  async function capture(args = {}) {
    const startedAt = Date.now();
    const result = await client.rpc('tools/call', { name: 'capture_screenshot', arguments: { instance_id: instanceId, format: 'png', ...args } }, 120000);
    const textItem = result.content.find((item) => item.type === 'text');
    let text;
    try { text = JSON.parse(textItem.text); } catch { text = { raw: textItem.text }; }
    const image = result.content.find((item) => item.type === 'image');
    console.log(`  capture_screenshot ${JSON.stringify(args)} -> ${Date.now() - startedAt}ms isError=${result.isError === true} ${JSON.stringify(text)}`);
    if (result.isError || !image) return { text, isError: true };
    const decoded = decodePng(Buffer.from(image.data, 'base64'));
    const colours = uniqueColours(decoded);
    console.log(`    image ${decoded.width}x${decoded.height}, ${colours} unique colours`);
    return { text, decoded, colours };
  }

  const idle = routingPeers(await tool('get_connected_instances'), instanceId);
  assert.ok(!idle.some((peer) => peer.role === 'server'), 'Start with an idle Studio');
  await tool('set_device_simulator', { target: 'edit', stopSimulation: true });

  const editIdle = await capture({ target: 'edit' });
  assert.ok(!editIdle.isError, JSON.stringify(editIdle.text));

  let playing = false;
  try {
    await startPlaytestAndWait(client, { timeoutSec: 60 });
    playing = true;
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const peers = routingPeers(await tool('get_connected_instances'), instanceId);
      if (peers.some((peer) => peer.role === 'client-1')) break;
      await delay(500);
    }
    await tool('set_device_simulator', { target: 'client-1', stopSimulation: true }).catch(() => undefined);
    await tool('execute_luau', { target: 'client-1', code: "game:GetService('RunService').RenderStepped:Wait() game:GetService('RunService').RenderStepped:Wait() return true" });

    const auto = await capture();
    const explicit = await capture({ target: 'client-1' });
    const server = await capture({ target: 'server' });
    const missing = await capture({ target: 'client-7' });

    assert.ok(!auto.isError, `auto capture failed: ${JSON.stringify(auto.text)}`);
    assert.equal(auto.text.peer, 'client-1', 'play mode without target must use client-1');
    assert.equal(auto.text.target, 'auto');
    assert.ok(auto.colours > 1, `auto capture is a single colour (${auto.colours})`);

    assert.ok(!explicit.isError, `target client-1 failed: ${JSON.stringify(explicit.text)}`);
    assert.equal(explicit.text.peer, 'client-1');
    assert.equal(explicit.text.target, 'client-1');
    assert.ok(explicit.colours > 1, `target client-1 capture is a single colour (${explicit.colours})`);

    assert.equal(server.isError, true, 'target server must be rejected');
    const serverText = JSON.stringify(server.text);
    assert.match(serverText, /server/);
    assert.match(serverText, /client-1/);

    assert.equal(missing.isError, true, 'target client-7 must be rejected');
    assert.match(JSON.stringify(missing.text), /client-7/);
    assert.match(JSON.stringify(missing.text), /client-1/);

    assert.equal(editIdle.text.peer, 'edit');
    assert.equal(editIdle.text.target, 'edit');
    console.log(`  RESULT auto=${auto.text.peer}/${auto.text.source} explicit=${explicit.text.peer}/${explicit.text.source} server-error="${String(server.text.error ?? server.text.raw).slice(0, 120)}" client-7-error="${String(missing.text.error ?? missing.text.raw).slice(0, 120)}"`);
  } finally {
    if (playing) await safeStopPlaytest(client);
  }
});
