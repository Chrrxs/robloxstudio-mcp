#!/usr/bin/env node
// Run through run-all.mjs --managed --test capture-video.mjs on Windows.
// Requires FFmpeg 8.0+ (gfxcapture) on the Studio test account's machine or
// user PATH: the profile launcher does not pass ROBLOX_STUDIO_FFMPEG through.
// Records a scripted camera move during a solo playtest and checks the MP4,
// the storyboard image, and storyboard re-sampling of the saved file.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { McpClient, runTest, startPlaytestAndWait, safeStopPlaytest } from './lib/mcp-client.mjs';

const CAMERA_MOVE = `
local camera = workspace.CurrentCamera
camera.CameraType = Enum.CameraType.Scriptable
local part = Instance.new('Part')
part.Name = '__RSMCP_VideoSubject'
part.Anchored = true
part.Size = Vector3.new(8, 8, 8)
part.Color = Color3.fromRGB(255, 80, 0)
part.CFrame = CFrame.new(0, 20, 0)
part.Parent = workspace
camera.CFrame = CFrame.lookAt(Vector3.new(-40, 30, 0), part.Position)
task.spawn(function()
  local start = os.clock()
  while os.clock() - start < 2.5 do
    local t = (os.clock() - start) / 2.5
    camera.CFrame = CFrame.lookAt(Vector3.new(-40 + 80 * t, 30, 40 * t), part.Position)
    task.wait()
  end
end)
return true
`;

const CLEANUP = `
local part = workspace:FindFirstChild('__RSMCP_VideoSubject')
if part then part:Destroy() end
workspace.CurrentCamera.CameraType = Enum.CameraType.Custom
return true
`;

await runTest('capture_video records a playtest viewport', async ({ track }) => {
  assert.equal(process.platform, 'win32', 'capture_video is Windows-only');
  const client = track(new McpClient('capture-video', { startupTimeoutMs: 20000 }));
  await client.start(); await client.initialize();
  const raw = async (args, timeoutMs = 120000) => {
    const result = await client.rpc('tools/call', {
      name: 'capture_video', arguments: { instance_id: process.env.MCP_INSTANCE_ID, ...args },
    }, timeoutMs);
    assert.notEqual(result.isError, true, JSON.stringify(result));
    const body = JSON.parse(result.content.find((item) => item.type === 'text').text);
    assert.equal(body.error, undefined, JSON.stringify(body));
    const image = result.content.find((item) => item.type === 'image');
    if (image) {
      assert.equal(image.mimeType, 'image/jpeg');
      const bytes = Buffer.from(image.data, 'base64');
      assert.equal(bytes.subarray(0, 2).toString('hex'), 'ffd8');
    }
    return { body, image };
  };

  await startPlaytestAndWait(client);
  const paths = [];
  try {
    const started = await raw({ action: 'start', fps: 30 });
    assert.equal(started.body.recording, true);
    assert.equal(started.body.target, 'client-1');
    paths.push(started.body.video.path);
    await client.callTool('eval_client_runtime', { target: 'client-1', code: CAMERA_MOVE });
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const stopped = await raw({ action: 'stop' });
    assert.ok(stopped.image, 'stop returns a storyboard image');
    assert.ok(fs.statSync(stopped.body.video.path).size > 10_000, 'MP4 has content');
    assert.ok(stopped.body.video.duration_ms >= 2500, JSON.stringify(stopped.body.video));
    assert.equal(stopped.body.video.width, started.body.video.width);
    assert.equal(stopped.body.storyboard.times_ms.length, 9);
    console.log(`start/stop recorded ${JSON.stringify(stopped.body.video)}`);

    const recorded = await raw({ action: 'record', duration_ms: 1500, frames: 4 });
    paths.push(recorded.body.video.path);
    assert.ok(Math.abs(recorded.body.video.duration_ms - 1500) < 600, JSON.stringify(recorded.body.video));
    assert.equal(recorded.body.storyboard.frames, 4);

    const sampled = await raw({ action: 'storyboard', input_path: stopped.body.video.path, start_ms: 500, end_ms: 1500, frames: 2 });
    assert.ok(sampled.image);
    assert.deepEqual(sampled.body.storyboard.times_ms, [750, 1250]);
  } finally {
    await client.callTool('eval_client_runtime', { target: 'client-1', code: CLEANUP }).catch(() => {});
    await safeStopPlaytest(client);
    for (const file of paths) fs.rmSync(file, { force: true });
  }
});
