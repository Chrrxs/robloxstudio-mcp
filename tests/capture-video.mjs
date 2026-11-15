#!/usr/bin/env node
// Run through run-all.mjs --managed --test capture-video.mjs on Windows.
// Requires FFmpeg 8.0+ (gfxcapture) readable by the Studio test account: put
// it on that account's PATH, or pass ROBLOX_STUDIO_FFMPEG=C:\...\ffmpeg.exe to
// the profile launcher. Set RSMCP_CAPTURE_VIDEO_OUTPUT_DIR (a directory the
// test account can write) to keep the recordings; otherwise they are deleted.
//
// Plays the dance emote on the local character, orbits a scripted camera
// around it, records 30 s with action=record, then checks start/stop and
// storyboard re-sampling of the saved file.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { McpClient, runTest, startPlaytestAndWait, safeStopPlaytest } from './lib/mcp-client.mjs';

const DANCE_SECONDS = 30;

const DANCE = `
local Players = game:GetService('Players')
local RunService = game:GetService('RunService')
local StarterGui = game:GetService('StarterGui')
local player = Players.LocalPlayer
local character = player.Character or player.CharacterAdded:Wait()
local humanoid = character:WaitForChild('Humanoid')
local root = character:WaitForChild('HumanoidRootPart')
local animator = humanoid:WaitForChild('Animator')
character:WaitForChild('Animate')
task.wait(1)

local method = 'none'
local ok, played = pcall(function() return humanoid:PlayEmote('dance') end)
if ok and played then
  method = 'PlayEmote'
else
  local folder = character.Animate:FindFirstChild('dance')
  local animation = folder and folder:FindFirstChildOfClass('Animation')
  if animation then
    local track = animator:LoadAnimation(animation)
    track.Looped = true
    track.Priority = Enum.AnimationPriority.Action
    track:Play()
    method = 'Animator'
  end
end

pcall(function() StarterGui:SetCoreGuiEnabled(Enum.CoreGuiType.All, false) end)
local camera = workspace.CurrentCamera
camera.CameraType = Enum.CameraType.Scriptable
local focus = root.Position + Vector3.new(0, 1, 0)
local facing = Vector3.new(root.CFrame.LookVector.X, 0, root.CFrame.LookVector.Z).Unit
local start = os.clock()
local connection
connection = RunService.RenderStepped:Connect(function()
  local elapsed = os.clock() - start
  if elapsed > ${DANCE_SECONDS + 15} or camera.CameraType ~= Enum.CameraType.Scriptable then
    connection:Disconnect()
    return
  end
  -- One slow orbit over the take, gently rising and pulling in.
  local angle = elapsed / ${DANCE_SECONDS} * math.pi * 2
  local distance = 11 - 3 * math.sin(elapsed / ${DANCE_SECONDS} * math.pi)
  local offset = CFrame.fromAxisAngle(Vector3.yAxis, angle):VectorToWorldSpace(facing * distance)
  camera.CFrame = CFrame.lookAt(focus + offset + Vector3.new(0, 2 + math.sin(elapsed * 0.5), 0), focus)
end)
return method
`;

const CLEANUP = `
pcall(function() game:GetService('StarterGui'):SetCoreGuiEnabled(Enum.CoreGuiType.All, true) end)
workspace.CurrentCamera.CameraType = Enum.CameraType.Custom
return true
`;

await runTest('capture_video records a dancing character', async ({ track }) => {
  assert.equal(process.platform, 'win32', 'capture_video is Windows-only');
  const keepDirectory = process.env.RSMCP_CAPTURE_VIDEO_OUTPUT_DIR;
  if (keepDirectory) fs.mkdirSync(keepDirectory, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outputPath = (name) => keepDirectory ? path.join(keepDirectory, `${stamp}-${name}.mp4`) : undefined;

  const client = track(new McpClient('capture-video', { startupTimeoutMs: 20000 }));
  await client.start(); await client.initialize();
  const video = async (args, timeoutMs = 120000) => {
    const result = await client.rpc('tools/call', {
      name: 'capture_video', arguments: { instance_id: process.env.MCP_INSTANCE_ID, ...args },
    }, timeoutMs);
    assert.notEqual(result.isError, true, JSON.stringify(result));
    const body = JSON.parse(result.content.find((item) => item.type === 'text').text);
    assert.equal(body.error, undefined, JSON.stringify(body));
    const image = result.content.find((item) => item.type === 'image');
    let jpeg;
    if (image) {
      assert.equal(image.mimeType, 'image/jpeg');
      jpeg = Buffer.from(image.data, 'base64');
      assert.equal(jpeg.subarray(0, 2).toString('hex'), 'ffd8');
    }
    return { body, jpeg };
  };

  // Simulator state persists across launches in the dedicated profile, and a
  // scaled simulated device is refused by capture_video. Record the plain viewport.
  let simulator = await client.callTool('get_device_simulator_state', { target: 'edit' });
  if (simulator.isSimulating) {
    await client.callTool('set_device_simulator', { target: 'edit', stopSimulation: true });
    simulator = await client.callTool('get_device_simulator_state', { target: 'edit' });
  }
  assert.equal(simulator.isSimulating, false, 'Start with device simulation off');

  await startPlaytestAndWait(client);
  const recorded = [];
  try {
    const dance = await client.callTool('eval_client_runtime', { target: 'client-1', code: DANCE }, 60000);
    console.log(`dance started: ${JSON.stringify(dance)}`);

    const take = await video({ action: 'record', duration_ms: DANCE_SECONDS * 1000, fps: 30, output_path: outputPath('dance') });
    recorded.push(take.body.video.path);
    assert.equal(take.body.target, 'client-1');
    assert.ok(take.jpeg, 'record returns a storyboard image');
    assert.ok(Math.abs(take.body.video.duration_ms - DANCE_SECONDS * 1000) < 1500, JSON.stringify(take.body.video));
    assert.ok(fs.statSync(take.body.video.path).size > 100_000, 'MP4 has content');
    assert.equal(take.body.storyboard.times_ms.length, 9);
    if (keepDirectory) fs.writeFileSync(take.body.video.path.replace(/\.mp4$/u, '-storyboard.jpg'), take.jpeg);
    console.log(`dance recorded: ${JSON.stringify(take.body.video)}`);

    const started = await video({ action: 'start', output_path: outputPath('start-stop') });
    assert.equal(started.body.recording, true);
    recorded.push(started.body.video.path);
    await delay(3000);
    const stopped = await video({ action: 'stop', frames: 4 });
    assert.ok(stopped.jpeg, 'stop returns a storyboard image');
    assert.ok(stopped.body.video.duration_ms >= 2500, JSON.stringify(stopped.body.video));
    assert.equal(stopped.body.storyboard.frames, 4);

    const sampled = await video({ action: 'storyboard', input_path: take.body.video.path, start_ms: 10000, end_ms: 12000, frames: 2 });
    assert.ok(sampled.jpeg);
    assert.deepEqual(sampled.body.storyboard.times_ms, [10500, 11500]);
  } finally {
    await client.callTool('eval_client_runtime', { target: 'client-1', code: CLEANUP }).catch(() => {});
    await safeStopPlaytest(client);
    if (!keepDirectory) for (const file of recorded) fs.rmSync(file, { force: true });
  }
  if (keepDirectory) console.log(`Kept recordings in ${keepDirectory}`);
});
