#!/usr/bin/env node
// Run after compiling the plugin through run-all.mjs --managed --test input-release-cleanup.mjs.
// Executes the compiled InputHandlers with a stub RenderMonitor (settable
// stale flag, captured onRenderResumed callback) and a fake VirtualInput that
// records SendKey/SendMouseButton and can be told to throw. Covers the render
// gate exemptions for releases, queued releases re-sent on resume, and taps or
// clicks whose release may not have reached the engine.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { McpClient, runTest } from './lib/mcp-client.mjs';

const inputSource = readFileSync(new URL('../studio-plugin/out/modules/handlers/InputHandlers.luau', import.meta.url), 'utf8');

export const fixture = `
-- Deterministic engine stand-ins, shadowing the real globals in Studio too.
local KeyCode = {W = {Name = 'W'}, E = {Name = 'E'}, Space = {Name = 'Space'}}
setmetatable(KeyCode, {__index = function(_, name) error('not a valid member of KeyCode: ' .. tostring(name)) end})
local Enum = {
  KeyCode = KeyCode,
  UserInputType = {MouseButton1 = {Name = 'MouseButton1'}, MouseButton2 = {Name = 'MouseButton2'}, MouseButton3 = {Name = 'MouseButton3'}},
}
local Vector2 = {new = function(x, y) return {X = x, Y = y} end}

local stale = false
local staleDuringWait = false
local resumeCallback
local RenderMonitor = {
  notRenderingReason = function() if stale then return 'Window is not rendering.' end return nil end,
  onRenderResumed = function(callback) resumeCallback = callback end,
}

local calls = {}
local throwOn = {}
local vi = {}
function vi:SendKey(down, key)
  table.insert(calls, {kind = 'key', down = down, key = key})
  if throwOn[down and 'keyDown' or 'keyUp'] then error('fake key failure') end
end
function vi:SendMouseButton(pos, inputType, down)
  table.insert(calls, {kind = 'mouse', down = down, inputType = inputType, pos = pos})
  if throwOn[down and 'mouseDown' or 'mouseUp'] then error('fake mouse failure') end
end
function vi:SendMousePosition() end
function vi:SendPointerAction() end
function vi:SendTextInput() end

local UserInputService = {MouseEnabled = true}
function UserInputService:CreateVirtualInput() return vi end
local game = {GetService = function(_, name)
  assert(name == 'UserInputService', name)
  return UserInputService
end}
local task = {wait = function()
  if staleDuringWait then stale = true end
end}

local TS = {import = function(_, _, name)
  assert(name == 'RenderMonitor', tostring(name))
  return RenderMonitor
end}
local script = {Parent = {Parent = {Parent = {include = {RuntimeLib = TS}}}}}
local require = function(module) return module end

local Input = (function()
${inputSource}
end)()

local function reset()
  table.clear(calls)
  table.clear(throwOn)
  stale = false
  staleDuringWait = false
end
local function check(condition, message)
  if not condition then error(message, 2) end
end

assert(type(resumeCallback) == 'function', 'InputHandlers must register an onRenderResumed callback')

-- release while stale still sends the up and reports it unconfirmed.
reset()
stale = true
local r = Input.simulateKeyboardInput({keyCode = 'W', action = 'release'})
check(r.success == true and r.deliveryConfirmed == false, 'stale release result')
check(string.find(r.warning, 're-sent', 1, true) ~= nil, 'stale release warning')
check(#calls == 1 and calls[1].kind == 'key' and calls[1].down == false and calls[1].key == KeyCode.W, 'stale release SendKey(false)')

-- mouseUp is exempt from the gate.
reset()
stale = true
r = Input.simulateMouseInput({action = 'mouseUp', x = 10, y = 20})
check(r.success == true and r.deliveryConfirmed == false, 'stale mouseUp result')
check(#calls == 1 and calls[1].kind == 'mouse' and calls[1].down == false, 'stale mouseUp sent')

-- press and click are blocked while stale.
reset()
stale = true
r = Input.simulateKeyboardInput({keyCode = 'E', action = 'press'})
check(r.error == 'Window is not rendering.', 'stale press blocked')
r = Input.simulateMouseInput({action = 'click', x = 1, y = 2})
check(r.error == 'Window is not rendering.', 'stale click blocked')
check(#calls == 0, 'blocked inputs send nothing')

-- resume re-sends pending releases (W key, MouseButton1) once and clears them.
reset()
resumeCallback()
local keyUps, mouseUps = 0, 0
for _, call in calls do
  check(call.down == false, 'resume sends only releases')
  if call.kind == 'key' then keyUps += 1; check(call.key == KeyCode.W, 'resumed key') end
  if call.kind == 'mouse' then
    mouseUps += 1
    check(call.pos.X == 10 and call.pos.Y == 20, 'resumed mouse position')
  end
end
check(keyUps == 1 and mouseUps == 1, 'resume re-sent each release once')
table.clear(calls)
resumeCallback()
check(#calls == 0, 'pending releases cleared after resume')

-- a tap whose up throws reports the key may still be held and is queued.
reset()
throwOn.keyUp = true
r = Input.simulateKeyboardInput({keyCode = 'Space', action = 'tap', duration = 2})
check(r.error ~= nil and string.find(r.error, 'may still be held', 1, true) ~= nil, 'tap up failure error')
table.clear(calls)
table.clear(throwOn)
resumeCallback()
check(#calls == 1 and calls[1].key == KeyCode.Space and calls[1].down == false, 'failed tap release queued')

-- a tap that goes stale during the hold reports deliveryConfirmed=false and is queued.
reset()
staleDuringWait = true
r = Input.simulateKeyboardInput({keyCode = 'E', action = 'tap', duration = 3})
check(r.success == true and r.deliveryConfirmed == false, 'tap stale mid-hold result')
check(string.find(r.warning, 're-sent', 1, true) ~= nil, 'tap stale mid-hold warning')
check(#calls == 2 and calls[1].down == true and calls[2].down == false, 'tap sent down and up')
table.clear(calls)
resumeCallback()
check(#calls == 1 and calls[1].key == KeyCode.E, 'stale tap release queued')

-- a click that goes stale during the hold reports deliveryConfirmed=false and is queued.
reset()
staleDuringWait = true
r = Input.simulateMouseInput({action = 'click', x = 5, y = 6, button = 'Right'})
check(r.success == true and r.deliveryConfirmed == false, 'click stale mid-hold result')
table.clear(calls)
resumeCallback()
check(#calls == 1 and calls[1].inputType == Enum.UserInputType.MouseButton2, 'stale click release queued')

-- a bad keyCode while stale reports the validation error, not the render gate.
reset()
stale = true
r = Input.simulateKeyboardInput({keyCode = 'NotAKey', action = 'release'})
check(r.error ~= nil and string.find(r.error, 'Unknown keyCode: NotAKey', 1, true) ~= nil, 'bad keyCode validation error')
check(#calls == 0, 'bad keyCode sends nothing')

return 'input-release-cleanup-passed'
`;

if (process.env.INPUT_RELEASE_CLEANUP_PRINT === '1') {
  process.stdout.write(fixture);
} else {
  await runTest('Input release cleanup while not rendering', async ({ track }) => {
    const client = track(new McpClient('input-release-cleanup', { startupTimeoutMs: 20000 }));
    await client.start();
    await client.initialize();
    const instanceId = process.env.MCP_INSTANCE_ID;
    assert.ok(instanceId, 'Run with an explicitly targeted managed instance');
    const result = await client.callTool('execute_luau', { instance_id: instanceId, target: 'edit', code: fixture });
    assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(String(result.returnValue), 'input-release-cleanup-passed');
  });
}
