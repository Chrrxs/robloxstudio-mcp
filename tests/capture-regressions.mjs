#!/usr/bin/env node
// Run through run-all.mjs --managed --test capture-regressions.mjs.
// Set RSMCP_EXPECT_STUDIO_CAPTURE=enabled or disabled after configuring Studio's flag.
// On Windows/Vulkan, RSMCP_EXPECT_HOST_CAPTURE=1 also verifies the real host
// fallback across physical-size clipping, resizing, and concurrent captures.
// Requires an idle instance with device simulation off; restores both on completion.
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { BASE_PORT, McpClient, runTest, selectRoutingPeer } from './lib/mcp-client.mjs';

// Decode the engine/host's 8-bit RGB(A) PNGs so assertions inspect actual pixels,
// not just metadata (a correctly sized crop was the original regression).
function decodePng(data) {
  assert.equal(data.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  let width, height, channels;
  const chunks = [];
  for (let offset = 8; offset < data.length;) {
    const length = data.readUInt32BE(offset);
    const kind = data.toString('ascii', offset + 4, offset + 8);
    const body = data.subarray(offset + 8, offset + 8 + length);
    if (kind === 'IHDR') {
      width = body.readUInt32BE(0); height = body.readUInt32BE(4);
      assert.equal(body[8], 8, '8-bit PNG');
      assert.ok(body[9] === 2 || body[9] === 6, 'RGB or RGBA PNG');
      assert.equal(body[12], 0, 'non-interlaced PNG');
      channels = body[9] === 6 ? 4 : 3;
    }
    if (kind === 'IDAT') chunks.push(body);
    offset += length + 12;
  }
  assert.ok(width && height && channels);
  const stride = width * channels;
  const filtered = inflateSync(Buffer.concat(chunks));
  assert.equal(filtered.length, (stride + 1) * height);
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = filtered[y * (stride + 1)];
    assert.ok(filter <= 4);
    for (let x = 0; x < stride; x++) {
      const index = y * stride + x;
      const left = x >= channels ? pixels[index - channels] : 0;
      const up = y > 0 ? pixels[index - stride] : 0;
      const upperLeft = y > 0 && x >= channels ? pixels[index - stride - channels] : 0;
      let predictor = 0;
      if (filter === 1) predictor = left;
      if (filter === 2) predictor = up;
      if (filter === 3) predictor = Math.floor((left + up) / 2);
      if (filter === 4) {
        const p = left + up - upperLeft;
        const a = Math.abs(p - left), b = Math.abs(p - up), c = Math.abs(p - upperLeft);
        predictor = a <= b && a <= c ? left : b <= c ? up : upperLeft;
      }
      pixels[index] = (filtered[y * (stride + 1) + 1 + x] + predictor) & 255;
    }
  }
  return { width, height, channels, pixels };
}

function colorBounds(image, red, green, blue) {
  let minX = image.width, minY = image.height, maxX = -1, maxY = -1;
  for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
    const i = (y * image.width + x) * image.channels;
    if (Math.abs(image.pixels[i] - red) < 16 && Math.abs(image.pixels[i + 1] - green) < 16 && Math.abs(image.pixels[i + 2] - blue) < 16) {
      minX = Math.min(minX, x); minY = Math.min(minY, y);
      maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
    }
  }
  assert.ok(maxX >= minX && maxY >= minY, `Missing RGB(${red},${green},${blue}) marker`);
  return [minX, minY, maxX, maxY];
}

await runTest('Screenshot beta and legacy regressions', async ({ track }) => {
  const expectation = process.env.RSMCP_EXPECT_STUDIO_CAPTURE;
  assert.ok(['enabled', 'disabled'].includes(expectation), 'Set RSMCP_EXPECT_STUDIO_CAPTURE explicitly');
  const enabled = expectation === 'enabled';
  const instanceId = process.env.MCP_INSTANCE_ID;
  assert.ok(instanceId, 'Run with an explicitly targeted managed instance');
  const client = track(new McpClient('capture-regressions', { startupTimeoutMs: 20000 }));
  await client.start(); await client.initialize();
  const tool = (name, args = {}) => client.callTool(name, { instance_id: instanceId, ...args }, 120000);
  async function execute(code, target = 'edit') {
    const result = await tool('execute_luau', { target, code });
    assert.equal(result.success, true, JSON.stringify(result));
    return JSON.parse(result.returnValue);
  }
  async function capture(format, quality = 80, requireHost = false, captureClient = client) {
    const result = await captureClient.rpc('tools/call', {
      name: 'capture_screenshot', arguments: { instance_id: instanceId, format, quality },
    }, 120000);
    assert.notEqual(result.isError, true, JSON.stringify(result));
    if (requireHost) {
      const metadata = JSON.parse(result.content.find(item => item.type === 'text').text);
      assert.match(metadata.message, /Captured from the Studio window through the host OS/);
    }
    const image = result.content?.find(item => item.type === 'image');
    assert.ok(image, JSON.stringify(result));
    assert.equal(image.mimeType, format === 'png' ? 'image/png' : 'image/jpeg');
    const bytes = Buffer.from(image.data, 'base64');
    if (format === 'jpeg') {
      assert.equal(bytes.subarray(0, 2).toString('hex'), 'ffd8');
      assert.equal(bytes.subarray(-2).toString('hex'), 'ffd9');
    } else decodePng(bytes);
    return bytes;
  }
  const topology = await tool('get_connected_instances');
  const instance = topology.instances.find(item => item.id === instanceId);
  assert.ok(instance?.peers.edit);
  assert.ok(!instance.peers.server && !instance.peers['client-1'], 'Start with an idle Studio');
  const simulator = await tool('get_device_simulator_state', { target: 'edit' });
  assert.equal(simulator.isSimulating, false, 'Start with device simulation off');
  const capability = await execute("return {can=game:GetService('StudioCaptureService'):CanCaptureScreenshot()}");
  assert.equal(capability.can, enabled, 'Studio must be restarted with the expected beta flag');
  const endpoint = await execute("local r=require(script.modules.handlers.CaptureHandlers).captureStudio({encoding='png'});return {source=r.source,unavailable=r.unavailable,error=r.error}");
  if (enabled) assert.equal(endpoint.source, 'StudioCaptureService');
  else assert.ok(endpoint.unavailable, JSON.stringify(endpoint));
  let playing = false;
  try {
    await capture('png');
    const low = await capture('jpeg', 20), high = await capture('jpeg', 90);
    assert.ok(!low.equals(high), 'JPEG quality changes output');
    console.log(`Edit PNG/JPEG and quality passed (beta ${expectation}, proxy=${client.isProxy()})`);
    // A stable density override creates a logical/framebuffer size mismatch on
    // desktop monitors without changing Windows display settings.
    await tool('set_device_simulator', { target: 'edit', deviceId: 'hd_1080', resolution: { width: 1600, height: 900 }, pixelDensity: 88 });
    playing = true;
    assert.equal((await tool('solo_playtest', { action: 'start', mode: 'play' })).success, true);
    if (process.env.RSMCP_EXPECT_HOST_CAPTURE === '1') {
      // Independent stdio sessions have distinct server-side tool objects.
      // Their transactions must still coordinate in the shared Studio plugin.
      const concurrentClient = track(new McpClient('capture-regressions-concurrent', { startupTimeoutMs: 20000 }));
      await concurrentClient.start(); await concurrentClient.initialize();
      await execute(`
local gui=Instance.new('ScreenGui');gui.Name='__RSMCP_HostCaptureRegression';gui.IgnoreGuiInset=true;gui.DisplayOrder=10000;gui.ResetOnSpawn=false;gui.Parent=game:GetService('Players').LocalPlayer:WaitForChild('PlayerGui')
local bg=Instance.new('Frame');bg.Size=UDim2.fromScale(1,1);bg.BorderSizePixel=0;bg.BackgroundColor3=Color3.fromRGB(40,50,60);bg.Parent=gui
local b=Instance.new('TextButton');b.Position=UDim2.fromScale(0.2,0.25);b.Size=UDim2.fromScale(0.15,0.12);b.Text='';b.BorderSizePixel=0;b.AutoButtonColor=false;b.BackgroundColor3=Color3.fromRGB(0,255,255);b.Parent=bg
local edge=Instance.new('Frame');edge.Position=UDim2.fromScale(0.7,0.7);edge.Size=UDim2.fromScale(0.1,0.1);edge.BorderSizePixel=0;edge.BackgroundColor3=Color3.fromRGB(255,255,0);edge.Parent=bg
gui:SetAttribute('Clicks',0);b.MouseButton1Click:Connect(function()gui:SetAttribute('Clicks',gui:GetAttribute('Clicks')+1)end);return true`, 'client-1');
      let clicks = 0;
      const assertRestored = async (before) => {
        const after = await tool('get_device_simulator_state', { target: 'client-1' });
        for (const key of ['activeDeviceId', 'resolution', 'pixelDensity', 'scalingMode', 'orientation']) {
          assert.deepEqual(after[key], before[key], `Host capture must restore simulator ${key}`);
        }
        const leftover = await execute("return game:GetService('CoreGui'):FindFirstChild('__MCPCaptureMarkers')~=nil", 'client-1');
        assert.equal(leftover, false, 'Host marker GUI must be removed');
      };
      const inspectHostImage = (bytes, size) => {
        const image = decodePng(bytes);
        assert.equal(image.width, size.width); assert.equal(image.height, size.height);
        const button = colorBounds(image, 0, 255, 255);
        const edge = colorBounds(image, 255, 255, 0);
        console.log(`Host crop ${size.width}x${size.height}: button ${button}; edge ${edge}`);
        // Resampling physical window pixels can round an edge by a few logical pixels.
        for (const [actual, expected] of [[button[0], size.width * 0.2], [button[1], size.height * 0.25], [edge[0], size.width * 0.7], [edge[1], size.height * 0.7]]) {
          assert.ok(Math.abs(actual - Math.round(expected)) <= 3, `Misaligned host crop: ${actual}, expected ${Math.round(expected)}`);
        }
        return button;
      };
      try {
        for (const [width, height] of [[1000, 600], [1200, 700], [1920, 1080], [1000, 600]]) {
          await tool('set_device_simulator', { target: 'client-1', resolution: { width, height }, pixelDensity: 88, scalingMode: 'ScaleToPhysicalSize' });
          const size = await execute("game:GetService('RunService').RenderStepped:Wait();game:GetService('RunService').RenderStepped:Wait();return {width=workspace.CurrentCamera.ViewportSize.X,height=workspace.CurrentCamera.ViewportSize.Y}", 'client-1');
          const before = await tool('get_device_simulator_state', { target: 'client-1' });
          const button = inspectHostImage(await capture('png', 80, true), size);
          await assertRestored(before);
          await tool('simulate_mouse_input', { target: 'client-1', action: 'click', x: Math.round((button[0] + button[2]) / 2), y: Math.round((button[1] + button[3]) / 2) });
          assert.equal(await execute("return game:GetService('Players').LocalPlayer.PlayerGui.__RSMCP_HostCaptureRegression:GetAttribute('Clicks')", 'client-1'), ++clicks);
          await capture('jpeg', 80, true);
          await assertRestored(before);
          const concurrent = await Promise.all([capture('png', 80, true), capture('png', 80, true, concurrentClient)]);
          for (const bytes of concurrent) inspectHostImage(bytes, size);
          await assertRestored(before);
          console.log(`Host capture PNG/JPEG, clicks, concurrency and restoration passed at ${width}x${height}`);
        }
        const targetPeerId = selectRoutingPeer(await tool('get_connected_instances'), 'client-1', instanceId)?.peerId;
        assert.ok(targetPeerId);
        assert.ok(process.env.ROBLOX_STUDIO_AUTH_TOKEN, 'Marker ownership checks require the managed primary authentication token');
        const markerCall = async (action, captureId) => {
          const response = await fetch(`http://127.0.0.1:${BASE_PORT}/proxy`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-MCP-Auth': process.env.ROBLOX_STUDIO_AUTH_TOKEN },
            body: JSON.stringify({ endpoint: '/api/capture-markers', targetPeerId, data: { action, captureId } }),
          });
          assert.equal(response.ok, true);
          const payload = await response.json();
          assert.ok(payload.response, JSON.stringify(payload));
          return payload.response;
        };
        const before = await tool('get_device_simulator_state', { target: 'client-1' });
        let ownedToken;
        try {
          const first = await markerCall('prepare');
          ownedToken = first.captureId;
          assert.equal(first.success, true, JSON.stringify(first));
          assert.equal((await markerCall('finish', first.captureId)).success, true);
          const second = await markerCall('prepare');
          ownedToken = second.captureId;
          assert.equal(second.success, true, JSON.stringify(second));
          assert.equal((await markerCall('show', second.captureId)).success, true);
          for (const action of ['show', 'hide', 'query']) {
            assert.match((await markerCall(action, first.captureId)).error, /stale|expired/);
          }
          assert.equal((await markerCall('finish', first.captureId)).stale, true);
          assert.equal(await execute("return game:GetService('CoreGui'):FindFirstChild('__MCPCaptureMarkers')~=nil", 'client-1'), true);
        } finally {
          if (ownedToken) assert.equal((await markerCall('finish', ownedToken)).success, true);
        }
        await assertRestored(before);
        console.log('Stale marker tokens cannot mutate or finish a newer capture');
      } finally {
        await execute("local gui=game:GetService('Players').LocalPlayer.PlayerGui:FindFirstChild('__RSMCP_HostCaptureRegression');if gui then gui:Destroy()end;return true", 'client-1');
        await tool('set_device_simulator', { target: 'client-1', resolution: { width: 1600, height: 900 }, pixelDensity: 88 });
      }
    }
    await execute(`
local pg=game:GetService('Players').LocalPlayer:WaitForChild('PlayerGui')
local gui=Instance.new('ScreenGui');gui.Name='__RSMCP_CaptureRegression';gui.IgnoreGuiInset=true;gui.DisplayOrder=10000;gui.ResetOnSpawn=false;gui.Parent=pg
local b=Instance.new('TextButton');b.Position=UDim2.fromOffset(600,350);b.Size=UDim2.fromOffset(120,80);b.Text='';b.AutoButtonColor=false;b.BorderSizePixel=0;b.BackgroundColor3=Color3.fromRGB(255,0,255);b.Parent=gui
local edge=Instance.new('Frame');edge.Position=UDim2.fromOffset(1300,700);edge.Size=UDim2.fromOffset(120,80);edge.BorderSizePixel=0;edge.BackgroundColor3=Color3.fromRGB(0,255,255);edge.Parent=gui
 gui:SetAttribute('Clicks',0);b.MouseButton1Click:Connect(function()gui:SetAttribute('Clicks',gui:GetAttribute('Clicks')+1)end)
game:GetService('RunService').RenderStepped:Wait();game:GetService('RunService').RenderStepped:Wait();return true`, 'client-1');
    const image = decodePng(await capture('png'));
    const magenta = colorBounds(image, 255, 0, 255);
    const cyan = colorBounds(image, 0, 255, 255);
    if (enabled) {
      assert.equal(image.width, 1600); assert.equal(image.height, 900);
      for (const [actual, expected] of [[magenta[0], 600], [magenta[1], 350], [cyan[0], 1300], [cyan[1], 700]]) {
        assert.ok(Math.abs(actual - expected) <= 1, `Expected logical pixel ${expected}; got ${actual}`);
      }
      await tool('simulate_mouse_input', { target: 'client-1', action: 'click', x: Math.round((magenta[0] + magenta[2]) / 2), y: Math.round((magenta[1] + magenta[3]) / 2) });
      const clicks = await execute("return game:GetService('Players').LocalPlayer.PlayerGui.__RSMCP_CaptureRegression:GetAttribute('Clicks')", 'client-1');
      assert.equal(clicks, 1, 'Screenshot coordinates click the real GUI target');
    }
    await capture('jpeg');
    console.log(`Scaled play PNG/JPEG passed: ${image.width}x${image.height}; markers ${magenta}, ${cyan}`);
    await tool('set_device_simulator', { target: 'client-1', resolution: { width: 3840, height: 2160 }, pixelDensity: 96 });
    await execute("game:GetService('RunService').RenderStepped:Wait();game:GetService('RunService').RenderStepped:Wait();return true", 'client-1');
    await capture('jpeg', 70);
    await capture('jpeg', 90);
    if (enabled) {
      // Two 4K base64 responses exceed the separate 64 MiB WebSocket
      // retained-result budget. Exercise concurrent chunks within that bound.
      await tool('set_device_simulator', { target: 'client-1', resolution: { width: 2560, height: 1440 } });
      await execute("game:GetService('RunService').RenderStepped:Wait();game:GetService('RunService').RenderStepped:Wait();return true", 'client-1');
      const concurrent = await Promise.allSettled([capture('jpeg', 70), capture('jpeg', 90)]);
      for (const result of concurrent) {
        assert.equal(result.status, 'fulfilled', result.status === 'rejected' ? String(result.reason) : undefined);
      }
    }
    const stillAlive = await execute("return game:GetService('Players').LocalPlayer.Parent == game:GetService('Players')", 'client-1');
    assert.equal(stillAlive, true, 'Large JPEG responses must not disconnect the client');
    console.log(`4K play JPEGs${enabled ? ' and concurrent 1440p transfers' : ''} passed; client remains connected`);
  } finally {
    if (playing) await tool('solo_playtest', { action: 'stop' });
    await tool('set_device_simulator', { target: 'edit', stopSimulation: true });
  }
  await capture('png');
  console.log('Post-play edit capture passed');
});
