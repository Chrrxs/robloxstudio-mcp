#!/usr/bin/env node

import { setTimeout as delay } from 'node:timers/promises';
import { McpClient, assert, runTest } from './lib/mcp-client.mjs';

const FIXTURE_NAME = '__RSMCPGrepResponsiveness';
const FIXTURE_PATH = `game.ServerStorage.${FIXTURE_NAME}`;
const SCRIPT_COUNT = 600;
const LINES_PER_SCRIPT = 20_000;
const MAX_CONCURRENT_RESPONSE_MS = 3000;
const MAX_COMPLETION_MS = 30_000;
const MAX_CANCELLATION_RELEASE_MS = 5000;

function parseToolResponse(name, response) {
  const text = response?.content?.[0]?.text;
  if (text == null) {
    throw new Error(`Tool ${name} returned no text content: ${JSON.stringify(response)}`);
  }
  if (response?.isError) {
    throw new Error(`Tool ${name} returned isError: ${text}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function startToolCall(client, name, args, timeoutMs = 120_000) {
  const requestId = client.nextId;
  const response = client.rpc('tools/call', { name, arguments: args }, timeoutMs);
  const result = response.then((value) => parseToolResponse(name, value));
  return {
    requestId,
    result,
    cancel(reason) {
      client.notify('notifications/cancelled', { requestId, reason });
    },
  };
}

async function createFixture(client) {
  const result = await client.callTool('execute_luau', {
    target: 'edit',
    code: `
local ServerStorage = game:GetService("ServerStorage")
local existing = ServerStorage:FindFirstChild("${FIXTURE_NAME}")
if existing then existing:Destroy() end

local root = Instance.new("Folder")
root.Name = "${FIXTURE_NAME}"
root.Parent = ServerStorage
local filler = string.rep("--x\\n", ${LINES_PER_SCRIPT})
for index = 1, ${SCRIPT_COUNT} do
    local scriptInstance = Instance.new("ModuleScript")
    scriptInstance.Name = string.format("Search%04d", index)
    scriptInstance.Source = filler .. string.format("return \\\"RSMCP_NEEDLE_%04d\\\"", index)
    scriptInstance.Parent = root
    if index % 25 == 0 then task.wait() end
end
return ${SCRIPT_COUNT}
`,
  }, 120_000);
  assert(result.success === true && Number(result.returnValue) === SCRIPT_COUNT,
    `created ${SCRIPT_COUNT} large scripts for the grep regression (${JSON.stringify(result)})`);
}

async function destroyFixture(client) {
  const result = await client.callTool('execute_luau', {
    target: 'edit',
    code: `
local root = game:GetService("ServerStorage"):FindFirstChild("${FIXTURE_NAME}")
if root then root:Destroy() end
return root ~= nil
`,
  }, 120_000);
  if (result.success !== true) {
    throw new Error(`fixture cleanup failed: ${JSON.stringify(result)}`);
  }
}

async function waitForReleasedSearch(client, instanceId, deadline) {
  let last;
  while (Date.now() < deadline) {
    last = await client.callTool('grep_scripts', {
      instance_id: instanceId,
      pattern: 'RSMCP_NEEDLE_0001',
      caseSensitive: true,
      filesOnly: true,
      maxResults: 1,
      path: FIXTURE_PATH,
      classFilter: 'ModuleScript',
    }, 15_000);
    if (last?.error !== 'plugin_busy') return last;
    await delay(25);
  }
  throw new Error(`cancelled grep did not release its exclusive job: ${JSON.stringify(last)}`);
}

await runTest('large external grep remains responsive and cancellable', async ({ track }) => {
  const client = track(new McpClient('studio-grep-responsiveness'));
  const instanceId = process.env.MCP_INSTANCE_ID;
  if (!instanceId) throw new Error('MCP_INSTANCE_ID is required');
  let fixtureCreated = false;
  const activeCalls = [];

  try {
    await client.start();
    await client.initialize();
    await createFixture(client);
    fixtureCreated = true;

    let mainSettled = false;
    const mainStartedAt = Date.now();
    const main = startToolCall(client, 'grep_scripts', {
      instance_id: instanceId,
      pattern: 'RSMCP_NEEDLE_',
      caseSensitive: true,
      filesOnly: true,
      maxResults: 1000,
      path: FIXTURE_PATH,
      classFilter: 'ModuleScript',
    });
    activeCalls.push(main);
    main.result.finally(() => {
      mainSettled = true;
    }).catch(() => {});

    await delay(50);
    const probeStartedAt = Date.now();
    const [placeInfo, overlap] = await Promise.all([
      client.callTool('get_place_info', { instance_id: instanceId }, 10_000),
      client.callTool('grep_scripts', {
        instance_id: instanceId,
        pattern: 'different-pattern',
        caseSensitive: true,
        filesOnly: true,
        path: FIXTURE_PATH,
      }, 10_000),
    ]);
    const probeElapsedMs = Date.now() - probeStartedAt;
    assert(!mainSettled, 'responsiveness probes overlap the primary grep');
    assert(typeof placeInfo.placeName === 'string', 'an unrelated Studio request completes during grep');
    assert(overlap?.error === 'plugin_busy', `overlapping grep is rejected immediately (${JSON.stringify(overlap)})`);
    assert(probeElapsedMs < MAX_CONCURRENT_RESPONSE_MS,
      `concurrent requests complete within ${MAX_CONCURRENT_RESPONSE_MS}ms (${probeElapsedMs}ms)`);

    const mainResult = await main.result;
    const mainElapsedMs = Date.now() - mainStartedAt;
    assert(mainResult.totalMatches === SCRIPT_COUNT,
      `primary grep returns all ${SCRIPT_COUNT} expected matches (${JSON.stringify({ totalMatches: mainResult.totalMatches })})`);
    assert(mainResult.scriptsSearched === SCRIPT_COUNT && mainResult.scriptsMatched === SCRIPT_COUNT,
      'primary grep preserves complete script counts');
    assert(mainResult.truncated === false, 'primary grep completes without truncation');
    assert(mainElapsedMs < MAX_COMPLETION_MS,
      `primary grep completes within ${MAX_COMPLETION_MS}ms (${mainElapsedMs}ms)`);

    const cancelled = startToolCall(client, 'grep_scripts', {
      instance_id: instanceId,
      pattern: 'RSMCP_NEEDLE_',
      caseSensitive: true,
      filesOnly: true,
      maxResults: 1000,
      path: FIXTURE_PATH,
      classFilter: 'ModuleScript',
    }, 20_000);
    activeCalls.push(cancelled);
    cancelled.result.catch(() => {});
    await delay(50);
    const cancelledAt = Date.now();
    cancelled.cancel('managed grep cancellation regression');

    const followUp = await waitForReleasedSearch(
      client,
      instanceId,
      cancelledAt + MAX_CANCELLATION_RELEASE_MS,
    );
    const cancellationElapsedMs = Date.now() - cancelledAt;
    assert(followUp.totalMatches === 1 && followUp.scriptsMatched === 1,
      `a follow-up grep succeeds after cancellation (${JSON.stringify(followUp)})`);
    assert(cancellationElapsedMs < MAX_CANCELLATION_RELEASE_MS,
      `cancellation releases grep within ${MAX_CANCELLATION_RELEASE_MS}ms (${cancellationElapsedMs}ms)`);

    console.log(
      `  main=${mainElapsedMs}ms concurrent=${probeElapsedMs}ms cancellation=${cancellationElapsedMs}ms`,
    );
  } finally {
    for (const call of activeCalls) call.cancel('grep regression cleanup');
    if (fixtureCreated) {
      await delay(100);
      await destroyFixture(client);
    }
  }
}).then((ok) => process.exit(ok ? 0 : 1));
