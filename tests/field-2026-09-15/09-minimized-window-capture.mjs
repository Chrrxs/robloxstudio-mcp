#!/usr/bin/env node
// Field report #9 (capture half): with the Studio window minimized during play, capture_screenshot restores it (IsIconic=false) and returns a non-uniform image.
// Only the managed baseplate's window is touched (matched by the managed process id); the user's other Studio windows are listed but left alone.
import assert from 'node:assert/strict';
import { McpClient, runTest, connectedInstances, startPlaytestAndWait, safeStopPlaytest, routingPeers } from '../lib/mcp-client.mjs';
import { decodePng, uniqueColours } from './lib/png.mjs';
import { findManagedStudioWindow, listStudioWindows, showWindow, windowState } from './lib/studio-window.mjs';

const SW_MINIMIZE = 6;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

await runTest('field #9 capture_screenshot restores a minimized Studio window', async ({ track }) => {
  const instanceId = process.env.MCP_INSTANCE_ID;
  assert.ok(instanceId, 'Run with an explicitly targeted managed instance');
  const client = track(new McpClient('field-09', { startupTimeoutMs: 20000 }));
  await client.start(); await client.initialize();
  const tool = (name, args = {}) => client.callTool(name, { instance_id: instanceId, ...args }, 120000);

  const topology = await tool('get_connected_instances');
  const instance = connectedInstances(topology).find((item) => item.id === instanceId);
  assert.ok(instance, JSON.stringify(topology));
  assert.ok(!instance.peers.server && !instance.peers['client-1'], 'Start with an idle Studio');
  await tool('set_device_simulator', { target: 'edit', stopSimulation: true });

  const before = listStudioWindows();
  console.log(`  Studio windows before: ${JSON.stringify(before)}`);
  const window = await findManagedStudioWindow(tool, instanceId, instance.placeName);
  const others = before.filter((w) => w.handle !== window.handle);
  console.log(`  managed window: ${JSON.stringify(window)}; untouched windows: ${others.length}`);

  let playing = false;
  let text;
  let decoded;
  let colours;
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

    const minimized = showWindow(window.handle, SW_MINIMIZE);
    console.log(`  ShowWindow(${window.handle}, SW_MINIMIZE) -> ${JSON.stringify(minimized)}`);
    assert.equal(minimized.iconic, true, 'the managed Studio window must be minimized before the capture');
    await delay(1500);

    const startedAt = Date.now();
    const result = await client.rpc('tools/call', { name: 'capture_screenshot', arguments: { instance_id: instanceId, format: 'png' } }, 120000);
    text = JSON.parse(result.content.find((item) => item.type === 'text').text);
    console.log(`  capture_screenshot (minimized) -> ${Date.now() - startedAt}ms ${JSON.stringify(text)}`);
    const image = result.content.find((item) => item.type === 'image');
    assert.ok(!result.isError && image, `capture failed while minimized: ${JSON.stringify(text)}`);
    decoded = decodePng(Buffer.from(image.data, 'base64'));
    colours = uniqueColours(decoded);
    console.log(`    image ${decoded.width}x${decoded.height}, ${colours} unique colours`);
  } finally {
    const state = windowState(window.handle);
    console.log(`  window state after capture: ${JSON.stringify(state)}`);
    if (state.iconic) showWindow(window.handle, 9);
    if (playing) await safeStopPlaytest(client);
    const after = listStudioWindows();
    for (const other of others) {
      const now = after.find((w) => w.handle === other.handle);
      assert.ok(now, `another Studio window disappeared: ${other.title}`);
      assert.equal(now.iconic, other.iconic, `another Studio window changed state: ${other.title}`);
    }
    console.log(`  other Studio windows unchanged (${others.length})`);
  }

  const state = windowState(window.handle);
  assert.equal(state.iconic, false, 'capture_screenshot must restore the minimized Studio window');
  assert.ok(colours > 1, `capture from a minimized window is a single colour (${colours}); message: ${text.message}`);
  assert.equal(text.peer, 'client-1');
  assert.ok(text.window && text.window.restored === true, `result must report the restore: ${JSON.stringify(text.window)}`);
  console.log(`  RESULT IsIconic=false, image ${decoded.width}x${decoded.height}/${colours}c, restored=${text.window.restored}, method=${text.window.method}`);
});
