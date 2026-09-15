#!/usr/bin/env node
// Field report #1: in play mode capture_screenshot returns a non-uniform image plus viewportRect and peer, with device emulation off and on; fallback:"window" returns the uncropped window.
// Evidence gathered along the way: PrintWindow vs CopyFromScreen colour counts (root cause), an edit-mode control capture, the two play scenarios and the window fallback.
import assert from 'node:assert/strict';
import { McpClient, runTest, startPlaytestAndWait, safeStopPlaytest, routingPeers, connectedInstances } from '../lib/mcp-client.mjs';
import { decodePng, uniqueColours } from './lib/png.mjs';
import { findManagedStudioWindow, probeWindow } from './lib/studio-window.mjs';

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

await runTest('field #1 capture_screenshot play-mode blank frame', async ({ track }) => {
  const instanceId = process.env.MCP_INSTANCE_ID;
  assert.ok(instanceId, 'Run with an explicitly targeted managed instance');
  const client = track(new McpClient('field-01', { startupTimeoutMs: 20000 }));
  await client.start(); await client.initialize();
  const tool = (name, args = {}) => client.callTool(name, { instance_id: instanceId, ...args }, 120000);

  async function capture(args = {}) {
    const startedAt = Date.now();
    const result = await client.rpc('tools/call', { name: 'capture_screenshot', arguments: { instance_id: instanceId, format: 'png', ...args } }, 120000);
    const text = JSON.parse(result.content.find((item) => item.type === 'text').text);
    const image = result.content.find((item) => item.type === 'image');
    const elapsedMs = Date.now() - startedAt;
    console.log(`  capture_screenshot ${JSON.stringify(args)} -> ${elapsedMs}ms ${JSON.stringify(text)}`);
    if (result.isError || !image) return { text, isError: true, elapsedMs };
    const decoded = decodePng(Buffer.from(image.data, 'base64'));
    const colours = uniqueColours(decoded);
    console.log(`    image ${decoded.width}x${decoded.height}, ${colours} unique colours`);
    return { text, decoded, colours, elapsedMs };
  }

  async function viewportOf(target) {
    const r = await tool('execute_luau', { target, code: 'local v = workspace.CurrentCamera.ViewportSize return { w = v.X, h = v.Y }' });
    assert.equal(r.success, true, JSON.stringify(r));
    return JSON.parse(r.returnValue);
  }

  const topology = await tool('get_connected_instances');
  const instance = connectedInstances(topology).find((item) => item.id === instanceId);
  assert.ok(instance, JSON.stringify(topology));
  console.log(`  instance ${instanceId} placeName=${instance.placeName} dataModelName=${instance.dataModelName} peers=${JSON.stringify(instance.peers)}`);
  assert.ok(!instance.peers.server && !instance.peers['client-1'], 'Start with an idle Studio');
  await tool('set_device_simulator', { target: 'edit', stopSimulation: true });

  const edit = await capture();
  assert.ok(!edit.isError, `edit capture failed: ${JSON.stringify(edit.text)}`);
  assert.ok(edit.colours > 1, `edit control capture is a single colour (${edit.colours})`);

  const window = await findManagedStudioWindow(tool, instanceId, instance.placeName);
  console.log(`  Studio window ${JSON.stringify(window)}`);

  let playing = false;
  let simulating = false;
  try {
    await startPlaytestAndWait(client, { timeoutSec: 60 });
    playing = true;
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const peers = routingPeers(await tool('get_connected_instances'), instanceId);
      if (peers.some((peer) => peer.role === 'client-1')) break;
      await delay(500);
    }
    await tool('execute_luau', { target: 'client-1', code: "game:GetService('RunService').RenderStepped:Wait() game:GetService('RunService').RenderStepped:Wait() return true" });

    const probe = probeWindow(window.handle);
    console.log(`  window probe (play, no markers): ${JSON.stringify(probe)}`);
    const playViewport = await viewportOf('client-1');
    console.log(`  client-1 ViewportSize ${playViewport.w}x${playViewport.h} (emulation off)`);
    const off = await capture();

    const state = await tool('get_device_simulator_state', { target: 'client-1', includeDeviceList: true });
    const hd720 = (state.devices || []).find((device) => /720/.test(String(device.DeviceId ?? device.deviceId ?? '')) || /720/.test(String(device.Name ?? device.name ?? '')));
    const simulatorArgs = hd720
      ? { target: 'client-1', deviceId: String(hd720.DeviceId ?? hd720.deviceId) }
      : { target: 'client-1', resolution: { width: 1280, height: 720 } };
    console.log(`  set_device_simulator ${JSON.stringify(simulatorArgs)} (device ${hd720 ? JSON.stringify(hd720) : 'not in list; resolution fallback'})`);
    await tool('set_device_simulator', simulatorArgs);
    simulating = true;
    let emulatedViewport = playViewport;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await tool('execute_luau', { target: 'client-1', code: "game:GetService('RunService').RenderStepped:Wait() game:GetService('RunService').RenderStepped:Wait() task.wait(0.5) return true" });
      emulatedViewport = await viewportOf('client-1');
      if (emulatedViewport.w !== playViewport.w || emulatedViewport.h !== playViewport.h) break;
    }
    const emulationState = await tool('get_device_simulator_state', { target: 'client-1', includeDeviceList: false });
    console.log(`  client-1 ViewportSize ${emulatedViewport.w}x${emulatedViewport.h} (emulation on: ${JSON.stringify(emulationState)})`);
    const probeOn = probeWindow(window.handle);
    console.log(`  window probe (play, emulation on): ${JSON.stringify(probeOn)}`);

    const on = await capture();
    const whole = await capture({ fallback: 'window' });

    assert.ok(!off.isError, `play capture (emulation off) failed: ${JSON.stringify(off.text)}`);
    assert.ok(off.colours > 1, `play capture (emulation off) is a single colour (${off.colours}); message: ${off.text.message}`);
    assert.ok(!on.isError, `play capture (emulation on) failed: ${JSON.stringify(on.text)}`);
    assert.ok(on.colours > 1, `play capture (emulation on) is a single colour (${on.colours}); message: ${on.text.message}`);
    assert.equal(off.decoded.width, Math.floor(playViewport.w));
    assert.equal(off.decoded.height, Math.floor(playViewport.h));
    const emulatedResolution = emulationState.resolution ?? {};
    const emulatedSizeOk = (actual, viewport, resolution) => actual === Math.floor(viewport) || (Number.isFinite(resolution) && Math.abs(actual - resolution) <= 1);
    assert.ok(emulatedSizeOk(on.decoded.width, emulatedViewport.w, emulatedResolution.width), `emulated width ${on.decoded.width} vs ViewportSize ${emulatedViewport.w} / resolution ${emulatedResolution.width}`);
    assert.ok(emulatedSizeOk(on.decoded.height, emulatedViewport.h, emulatedResolution.height), `emulated height ${on.decoded.height} vs ViewportSize ${emulatedViewport.h} / resolution ${emulatedResolution.height}`);
    assert.equal(edit.text.peer, 'edit', 'edit result names the peer that rendered the image');
    assert.equal(off.text.peer, 'client-1', 'play result names the play client peer');
    assert.equal(on.text.peer, 'client-1');
    assert.ok(off.text.viewportRect && Number.isFinite(off.text.viewportRect.x) && off.text.viewportRect.width > 0, `viewportRect missing: ${JSON.stringify(off.text)}`);
    assert.ok(on.text.viewportRect && on.text.viewportRect.width > 0, `viewportRect missing: ${JSON.stringify(on.text)}`);
    assert.ok(!whole.isError, `fallback:"window" failed: ${JSON.stringify(whole.text)}`);
    assert.ok(whole.colours > 1, `fallback:"window" image is a single colour (${whole.colours})`);
    assert.ok(whole.decoded.width >= Math.floor(emulatedViewport.w) && whole.decoded.height >= Math.floor(emulatedViewport.h),
      `window capture ${whole.decoded.width}x${whole.decoded.height} smaller than viewport ${emulatedViewport.w}x${emulatedViewport.h}`);
    assert.equal(whole.text.source, 'host-window', JSON.stringify(whole.text));
    assert.equal(whole.text.cropped, false, JSON.stringify(whole.text));

    console.log(`  RESULT edit=${edit.decoded.width}x${edit.decoded.height}/${edit.colours}c play-off=${off.decoded.width}x${off.decoded.height}/${off.colours}c play-on=${on.decoded.width}x${on.decoded.height}/${on.colours}c window=${whole.decoded.width}x${whole.decoded.height}/${whole.colours}c`);
  } finally {
    if (simulating) await tool('set_device_simulator', { target: 'client-1', stopSimulation: true }).catch(() => undefined);
    if (playing) await safeStopPlaytest(client);
    await tool('set_device_simulator', { target: 'edit', stopSimulation: true }).catch(() => undefined);
  }
});
