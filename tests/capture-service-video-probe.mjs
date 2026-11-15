#!/usr/bin/env node
// Diagnostic, Windows only: run through
//   run-all.mjs --managed --test capture-service-video-probe.mjs
// Asks whether Roblox's own CaptureService:StartVideoCaptureAsync can record a
// Studio playtest and whether the resulting video is reachable: through the
// VideoCapture object from a game script or the plugin, or as a file on disk.
// It reports facts and only fails when the tools themselves fail. Set
// RSMCP_CAPTURE_VIDEO_OUTPUT_DIR to copy any video files found for inspection.
//
// Observed on Studio 0.747 (solo playtest), from both the game client and the
// plugin: StartVideoCaptureAsync returns Success, but CaptureBegan never fires,
// the onCaptureReady callback never runs (neither after StopVideoCapture nor
// past the 30 s limit), and no video file is written. VideoCapture.FilePath is
// RobloxScriptSecurity in any case, so plugins could not read it. capture_video
// therefore records the window on the host.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { McpClient, runTest, startPlaytestAndWait, safeStopPlaytest } from './lib/mcp-client.mjs';

const START = `
local CaptureService = game:GetService('CaptureService')
local previous = shared.__rsmcpVideoProbe
if previous and previous.connections then for _, c in previous.connections do c:Disconnect() end end
shared.__rsmcpVideoProbe = { done = false, events = {}, connections = {} }
local probe = shared.__rsmcpVideoProbe
table.insert(probe.connections, CaptureService.CaptureBegan:Connect(function(kind) table.insert(probe.events, 'began ' .. tostring(kind)) end))
table.insert(probe.connections, CaptureService.CaptureEnded:Connect(function(kind) table.insert(probe.events, 'ended ' .. tostring(kind)) end))
local ok, started = pcall(function()
  return CaptureService:StartVideoCaptureAsync(function(result, capture)
    probe.done = true
    probe.result = tostring(result)
    probe.capture = capture
  end, {})
end)
probe.startedAt = os.clock()
return { ok = ok, started = tostring(started) }
`;

// stop=true calls StopVideoCapture; otherwise it only reports, so the host can
// poll until the callback fires (an eval must return within the bridge budget).
const finish = (stop) => `
local CaptureService = game:GetService('CaptureService')
local probe = shared.__rsmcpVideoProbe
if not probe then return { error = 'no probe state' } end
local stopOk, stopErr = true, nil
if ${stop} then stopOk, stopErr = pcall(function() CaptureService:StopVideoCapture() end) end
local report = { stopped = ${stop}, stopOk = stopOk, stopErr = stopErr and tostring(stopErr), done = probe.done, result = probe.result,
  events = table.concat(probe.events, ', '), elapsed = os.clock() - probe.startedAt }
local capture = probe.capture
if capture then
  report.className = capture.ClassName
  for _, property in { 'TimeLength', 'CaptureType', 'CaptureTime', 'SourcePlaceId', 'LocalId', 'FilePath', 'FilePathString' } do
    local readOk, value = pcall(function() return capture[property] end)
    report[property] = readOk and tostring(value) or ('ERROR: ' .. tostring(value))
  end
  local contentOk, content = pcall(function() return Content.fromObject(capture) end)
  report.contentFromObject = contentOk and tostring(content) or ('ERROR: ' .. tostring(content))
end
return report
`;

// Any sizeable file the Studio account wrote during the window, whatever its
// name, in case the engine stores captures without a video extension.
function largeRecentFiles(since) {
  const found = [];
  const walk = (directory, depth) => {
    if (depth > 8) return;
    let entries;
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) { if (!entry.isSymbolicLink()) walk(full, depth + 1); continue; }
      let stats;
      try { stats = fs.statSync(full); } catch { continue; }
      if (stats.mtimeMs >= since && stats.size >= 200_000) found.push({ path: full, bytes: stats.size });
    }
  };
  walk(process.env.USERPROFILE ?? '', 0);
  return found.sort((a, b) => b.bytes - a.bytes).slice(0, 25);
}

const VIDEO_EXTENSIONS = new Set(['.mp4', '.webm', '.mkv', '.mov', '.avi', '.h264', '.ivf']);

// Lists video-like files changed since `since` under the test account's own
// profile folders, where Roblox keeps temporary captures.
function recentVideos(since) {
  const roots = [process.env.LOCALAPPDATA, process.env.TEMP, path.join(process.env.USERPROFILE ?? '', 'Videos'), path.join(process.env.USERPROFILE ?? '', 'Pictures')]
    .filter((root) => root && fs.existsSync(root));
  const found = [];
  const seen = new Set();
  const walk = (directory, depth) => {
    if (depth > 7 || seen.has(directory)) return;
    seen.add(directory);
    let entries;
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!entry.isSymbolicLink() && !/^(?:node_modules|Packages|Microsoft|Google|npm-cache)$/i.test(entry.name)) walk(full, depth + 1);
        continue;
      }
      let stats;
      try { stats = fs.statSync(full); } catch { continue; }
      if (stats.mtimeMs < since) continue;
      if (VIDEO_EXTENSIONS.has(path.extname(entry.name).toLowerCase()) || /capture|video|record/i.test(entry.name)) {
        found.push({ path: full, bytes: stats.size, modified: new Date(stats.mtimeMs).toISOString() });
      }
    }
  };
  for (const root of roots) walk(root, 0);
  return found;
}

await runTest('CaptureService video capture probe', async ({ track }) => {
  const client = track(new McpClient('capture-service-video-probe', { startupTimeoutMs: 20000 }));
  await client.start(); await client.initialize();
  const simulator = await client.callTool('get_device_simulator_state', { target: 'edit' });
  if (simulator.isSimulating) await client.callTool('set_device_simulator', { target: 'edit', stopSimulation: true });

  await startPlaytestAndWait(client);
  try {
    for (const [label, tool, args, stop] of [
      ['game client, StopVideoCapture after 5 s', 'eval_client_runtime', { target: 'client-1' }, true],
      ['game client, 30 s time limit', 'eval_client_runtime', { target: 'client-1' }, false],
      ['plugin in the client DataModel, StopVideoCapture after 5 s', 'execute_luau', { target: 'client-1' }, true],
    ]) {
      const since = Date.now() - 2000;
      const started = await client.callTool(tool, { ...args, code: START }, 60000);
      console.log(`\n[${label}] start: ${JSON.stringify(started)}`);
      await delay(stop ? 5000 : 10000);
      let report = await client.callTool(tool, { ...args, code: finish(stop) }, 60000);
      const deadline = Date.now() + (stop ? 20_000 : 35_000);
      const parse = (value) => JSON.parse(value.result ?? value.returnValue);
      while (!parse(report).done && Date.now() < deadline) {
        await delay(2000);
        report = await client.callTool(tool, { ...args, code: finish(false) }, 60000);
      }
      console.log(`[${label}] finish: ${JSON.stringify(parse(report))}`);
      await delay(2000);
      const files = recentVideos(since);
      console.log(`[${label}] video-like files changed on disk: ${JSON.stringify(files, null, 2)}`);
      console.log(`[${label}] large files changed in the profile: ${JSON.stringify(largeRecentFiles(since), null, 2)}`);
      const keep = process.env.RSMCP_CAPTURE_VIDEO_OUTPUT_DIR;
      if (keep) {
        fs.mkdirSync(keep, { recursive: true });
        for (const file of files.filter((item) => VIDEO_EXTENSIONS.has(path.extname(item.path).toLowerCase()))) {
          const target = path.join(keep, `capture-service-${label.split(' ')[0]}-${path.basename(file.path)}`);
          fs.copyFileSync(file.path, target);
          console.log(`[${label}] copied ${file.path} -> ${target}`);
        }
      }
    }
  } finally {
    await safeStopPlaytest(client);
  }
});
