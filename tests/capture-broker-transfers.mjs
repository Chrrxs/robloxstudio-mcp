#!/usr/bin/env node
// Run after building the plugin, through run-all.mjs --managed --test capture-broker-transfers.mjs.
// Executes the real compiled transport in Studio with a fake clock and in-memory
// InvokeClient adapter. Full engine/framebuffer coverage lives in capture-regressions.mjs.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { McpClient, runTest } from './lib/mcp-client.mjs';

const transport = readFileSync(new URL('../studio-plugin/out/modules/CaptureTransfer.luau', import.meta.url), 'utf8');

await runTest('Capture broker bounded chunk transport', async ({ track }) => {
  const client = track(new McpClient('capture-broker-transfers', { startupTimeoutMs: 20000 }));
  await client.start();
  await client.initialize();
  const instanceId = process.env.MCP_INSTANCE_ID;
  assert.ok(instanceId, 'Run with an explicitly targeted managed instance');
  const result = await client.callTool('execute_luau', {
    instance_id: instanceId,
    target: 'edit',
    code: `
local now = 0
local timers = {}
local os = {clock = function() return now end}
local task = {
  delay = function(seconds, callback)
    local timer = {at = now + seconds, callback = callback}
    table.insert(timers, timer)
    return timer
  end,
  cancel = function(timer) timer.cancelled = true end,
}
local transfer = (function()
${transport}
end)()
local chunkSize = 1024 * 1024
local pixelsA = string.rep('A', chunkSize) .. 'AAAA'
local pixelsB = string.rep('B', chunkSize) .. 'BBBB'
local function capture(pixels)
  return {success = true, encoding = 'png', source = 'StudioCaptureService', width = 1024, height = 1024,
    nativeWidth = 1024, nativeHeight = 1024, data = pixels}
end
local function begin(id, pixels)
  return transfer.begin({transferId = id}, function() return capture(pixels) end)
end
local function read(id, offset, length)
  return transfer.read({transferId = id, offset = offset, length = length})
end
local function release(id) return transfer.release({transferId = id}) end

-- Admission is bounded, duplicate IDs never overwrite another capture, and
-- independently interleaved chunks retain the correct bytes and offsets.
local a = begin('a', pixelsA)
local b = begin('b', pixelsB)
assert(a.data == nil and b.data == nil and a.totalBytes == #pixelsA)
assert(begin('a', pixelsB).error, 'duplicate transfer must not overwrite')
assert(begin('c', pixelsA).error, 'third capture must fail without evicting')
assert(read('b', 0, chunkSize).data == string.sub(pixelsB, 1, chunkSize))
assert(read('a', 0, chunkSize).data == string.sub(pixelsA, 1, chunkSize))
assert(read('a', chunkSize, 4).data == 'AAAA')
assert(begin('c', pixelsA).transferId == 'c', 'last chunk must release capacity')
assert(read('b', chunkSize, 4).data == 'BBBB')
assert(read('a', 0, chunkSize).error, 'completed transfer cannot be read again')
release('c')

-- Capture itself yields in Studio. Capacity must already be reserved while
-- that callback is running, not just when it finally returns its bytes.
local reserved = transfer.begin({transferId = 'capturing'}, function()
  assert(begin('second', pixelsB).transferId == 'second')
  assert(begin('third', pixelsA).error, 'in-progress capture must count toward the limit')
  release('second')
  return capture(pixelsA)
end)
assert(reserved.transferId == 'capturing')
release('capturing')
assert(transfer.begin({transferId = 'throws'}, function() error('capture failure') end).error)
assert(begin('throws', pixelsA).transferId == 'throws', 'capture failure must release its reservation')
release('throws')

-- Invalid reads release only their transfer; offset/length cannot truncate,
-- repeat, skip, or exceed the declared chunk limit.
for _, request in ipairs({
  {offset = -1, length = chunkSize}, {offset = 0.5, length = chunkSize},
  {offset = 1, length = chunkSize}, {offset = 0, length = chunkSize + 1},
  {offset = 0, length = 1}, {offset = 0, length = 0},
}) do
  assert(begin('bad', pixelsA).transferId == 'bad')
  request.transferId = 'bad'
  assert(transfer.read(request).error)
  assert(read('bad', 0, chunkSize).error, 'invalid read must discard retained data')
end
assert(begin('keep', pixelsB).transferId == 'keep')
assert(read('missing', 0, chunkSize).error)
assert(read('keep', 0, chunkSize).data == string.sub(pixelsB, 1, chunkSize))
release('keep')
for _, timer in ipairs(timers) do assert(timer.cancelled, 'settled transfers must cancel expiry tasks') end

-- Expiry is deterministic and runs without another incoming request.
assert(begin('expired', pixelsA).transferId == 'expired')
now = 61
for _, timer in ipairs(timers) do if not timer.cancelled and timer.at <= now then timer.callback() end end
assert(read('expired', 0, chunkSize).error)
assert(begin('fresh', pixelsB).transferId == 'fresh')
release('fresh')

-- Server reassembly crosses the same seam used by ClientBroker. It must reject
-- wrong IDs, offsets, lengths and metadata, and release even when invoke throws.
local function roundTrip(mode)
  local released = false
  local invokedId
  local function invoke(endpoint, data)
    if endpoint == transfer.RELEASE_ENDPOINT then
      released = true
      if mode == 'release-failure' and invokedId ~= nil then return {error = 'cleanup unavailable'} end
      return release(data.transferId)
    end
    if endpoint == '/api/capture-studio' then
      invokedId = data.transferId
      if mode == 'unavailable' then return {unavailable = 'beta disabled'} end
      local header = begin(data.transferId, pixelsA)
      if mode == 'size' then header.totalBytes = 64 * 1024 * 1024 + 4 end
      return header
    end
    assert(endpoint == transfer.READ_ENDPOINT)
    assert(data.length <= chunkSize, 'wire chunk exceeds limit')
    if mode == 'throw' then error('simulated remote failure') end
    local chunk = transfer.read(data)
    if mode == 'id' then chunk.transferId = 'another transfer' end
    if mode == 'offset' then chunk.offset += 1 end
    if mode == 'length' then chunk.data = string.sub(chunk.data, 2) end
    return chunk
  end
  local response = transfer.receive(invoke, {encoding = 'png'})
  assert(released, 'release must run on every outcome')
  assert(read(invokedId, 0, chunkSize).error, 'receiver must leave no retained transfer')
  return response
end
local full = roundTrip('ok')
assert(full.success and full.data == pixelsA and full.encoding == 'png' and full.width == 1024)
assert(full.transferId == nil, 'internal protocol must not leak into public result')
for _, mode in ipairs({'size', 'throw', 'id', 'offset', 'length'}) do
  local response = roundTrip(mode)
  assert(response.success == false and type(response.error) == 'string', mode .. ' must fail clearly')
end
assert(roundTrip('unavailable').unavailable == 'beta disabled', 'legacy fallback signal must survive')
assert(roundTrip('release-failure').data == pixelsA, 'cleanup must not mask a complete result')
local oldCaptureRequests = 0
local old = transfer.receive(function(endpoint)
  if endpoint == '/api/capture-studio' then
    oldCaptureRequests += 1
    return {unavailable = 'beta disabled'}
  end
  return {error = 'Unsupported client broker endpoint: ' .. endpoint}
end, {encoding = 'png'})
assert(old.unavailable, 'older clients must retain legacy fallback')
assert(oldCaptureRequests == 0, 'negotiate bounded transfer before requesting potentially oversized inline data')
local oldServer = transfer.begin({encoding = 'png'}, function()
  error('an older server must not trigger an unbounded capture')
end)
assert(oldServer.unavailable, 'older servers must retain legacy fallback')
assert(transfer.begin({transferId = 42}, function() return capture(pixelsA) end).error, 'malformed supplied IDs must fail')
local rejected = transfer.begin({transferId = 'bad-size'}, function()
  return {success = true, encoding = 'rgba8', source = 'StudioCaptureService', width = 2, height = 2,
    nativeWidth = 2, nativeHeight = 2, data = 'AAAA'}
end)
assert(rejected.error, 'RGBA dimensions must agree with encoded byte size')
assert(begin('after-error', pixelsA).transferId == 'after-error')
release('after-error')
return 'capture-transfer-regressions-passed'
`,
  });
  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(String(result.returnValue), 'capture-transfer-regressions-passed');
});
