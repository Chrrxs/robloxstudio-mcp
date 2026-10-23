import { readFileSync } from 'node:fs';

// LibMP cannot report whether capture is on, and the plugin's copy is not
// reachable from execute_luau. Tests stage the bundled LibMP as a ModuleScript
// so peer code can drive the same engine controls and observe the effect: a
// peer is recording when the newest FrameAbsoluteId moves between two reads.
export const LIBMP_MODULE_NAME = 'RSMCP_LibMP_TestProbe';
const libmpSource = readFileSync(new URL('../../studio-plugin/include/LibMP.lua', import.meta.url), 'utf8');

export const LIBMP_PRELUDE = `
local LibMP = require(game:GetService("ReplicatedStorage"):WaitForChild("${LIBMP_MODULE_NAME}", 20))
local Control = LibMP.Control
local function newest()
  local started = os.clock()
  local data = Control:CaptureToBufferSync()
  local session = LibMP.Session.OpenFromBuffer(data)
  local maxId, minId = session:GetFrameIdMax(), session:GetFrameIdMin()
  local absolute = 0
  if maxId > 0 then absolute = session:FetchFrameDesc(maxId).FrameAbsoluteId end
  session:Dispose()
  return { frames = if maxId > 0 then maxId - minId + 1 else 0, abs = absolute, bytes = buffer.len(data), read_ms = (os.clock() - started) * 1000 }
end
local function state()
  local first = newest()
  task.wait(0.3)
  local second = newest()
  return { recording = second.abs ~= first.abs, frames = second.frames, newest_abs = second.abs, bytes = second.bytes, read_ms = second.read_ms }
end
`;

export async function stageLibMP(client) {
  const created = await client.callTool('execute_luau', {
    target: 'edit',
    code: `
local storage = game:GetService("ReplicatedStorage")
local existing = storage:FindFirstChild("${LIBMP_MODULE_NAME}")
if existing then existing:Destroy() end
local module = Instance.new("ModuleScript")
module.Name = "${LIBMP_MODULE_NAME}"
module.Parent = storage
return module:GetFullName()`,
  });
  if (created.success !== true) throw new Error(`stage LibMP module failed: ${JSON.stringify(created)}`);
  const set = await client.callTool('set_script_source', {
    instancePath: `game.ReplicatedStorage.${LIBMP_MODULE_NAME}`,
    source: libmpSource,
  }, 120_000);
  if (set.success !== true) throw new Error(`stage LibMP source failed: ${JSON.stringify(set).slice(0, 500)}`);
}

export async function removeLibMP(client) {
  await client.callTool('execute_luau', {
    target: 'edit',
    code: `local m = game:GetService("ReplicatedStorage"):FindFirstChild("${LIBMP_MODULE_NAME}") if m then m:Destroy() end return true`,
  }).catch(() => undefined);
}

export async function runLibMP(client, target, code, timeoutMs = 60_000) {
  const result = await client.callTool('execute_luau', { target, code: LIBMP_PRELUDE + code }, timeoutMs);
  if (result.success !== true) throw new Error(`${target} LibMP probe failed: ${JSON.stringify(result)}`);
  return JSON.parse(result.returnValue);
}
