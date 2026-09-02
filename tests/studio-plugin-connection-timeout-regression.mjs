#!/usr/bin/env node

import { BASE_PORT, assert, runTest } from './lib/mcp-client.mjs';
import { callMcpHttpTool } from './lib/mcp-http-client.mjs';

const FIXTURE_NAME = '__RSMCPConnectionTimeout';
const FIXTURE_PATH = `game.ServerStorage.${FIXTURE_NAME}`;
const SOURCE_CHARS = 145_000;
const CALL_COUNT = 50;
const ROUND_COUNT = 2;
const EXPECTED_NUMBERED_SOURCE = `1: --${'x'.repeat(SOURCE_CHARS)}\n2: return "ok"`;

function callTool(name, args, timeoutMs = 30_000) {
  return callMcpHttpTool(name, args, {
    port: BASE_PORT,
    env: process.env,
    timeoutMs,
  });
}

async function readHealth() {
  const response = await fetch(`http://127.0.0.1:${BASE_PORT}/health`);
  if (!response.ok) throw new Error(`/health returned HTTP ${response.status}`);
  return response.json();
}

async function createFixture(instanceId) {
  const result = await callTool('execute_luau', {
    instance_id: instanceId,
    target: 'edit',
    code: `
local ServerStorage = game:GetService("ServerStorage")
local existing = ServerStorage:FindFirstChild("${FIXTURE_NAME}")
if existing then existing:Destroy() end

local scriptInstance = Instance.new("ModuleScript")
scriptInstance.Name = "${FIXTURE_NAME}"
scriptInstance.Source = "--" .. string.rep("x", ${SOURCE_CHARS}) .. "\\nreturn \\"ok\\""
scriptInstance.Parent = ServerStorage
return scriptInstance:GetFullName()
`,
  });
  assert(result.success === true, `created source fixture (${JSON.stringify(result)})`);
}

async function destroyFixture(instanceId) {
  const result = await callTool('execute_luau', {
    instance_id: instanceId,
    target: 'edit',
    code: `
local scriptInstance = game:GetService("ServerStorage"):FindFirstChild("${FIXTURE_NAME}")
if scriptInstance then scriptInstance:Destroy() end
return scriptInstance ~= nil
`,
  });
  if (result.success !== true) {
    throw new Error(`fixture cleanup failed: ${JSON.stringify(result)}`);
  }
}

async function assertBurst(instanceId, round) {
  const startedAt = Date.now();
  const reads = Array.from({ length: CALL_COUNT }, () => callTool('get_script_source', {
    instance_id: instanceId,
    instancePath: FIXTURE_PATH,
  }, 40_000));
  const results = await Promise.allSettled(reads);
  const elapsedMs = Date.now() - startedAt;
  const failures = results.filter((result) => result.status === 'rejected');
  const successes = results.filter((result) => result.status === 'fulfilled');
  const failureMessages = failures.slice(0, 5).map((result) =>
    result.reason instanceof Error ? result.reason.message : String(result.reason));

  assert(failures.length === 0,
    `round ${round}: all burst reads complete (${JSON.stringify(failureMessages)})`);
  assert(successes.length === CALL_COUNT,
    `round ${round}: all ${CALL_COUNT} source responses arrive (${successes.length})`);
  assert(successes.every((result) =>
    result.value.path === FIXTURE_PATH &&
    result.value.className === 'ModuleScript' &&
    result.value.lineCount === 2 &&
    result.value.source === EXPECTED_NUMBERED_SOURCE),
  `round ${round}: every response contains the exact complete numbered source`);

  const health = await readHealth();
  assert(health.pluginConnected === true && health.activeEventStreams > 0,
    `round ${round}: Studio remains connected (${JSON.stringify(health)})`);
  assert(health.pendingRequests === 0,
    `round ${round}: no requests remain pending (${JSON.stringify(health)})`);
  console.log(`  round=${round} calls=${CALL_COUNT} success=${successes.length} elapsed=${elapsedMs}ms`);
}

await runTest('get_script_source bursts do not starve the Studio event stream', async () => {
  const instanceId = process.env.MCP_INSTANCE_ID;
  if (!instanceId) throw new Error('MCP_INSTANCE_ID is required');
  let fixtureCreated = false;

  try {
    await createFixture(instanceId);
    fixtureCreated = true;
    for (let round = 1; round <= ROUND_COUNT; round++) {
      await assertBurst(instanceId, round);
    }
  } finally {
    if (fixtureCreated) await destroyFixture(instanceId);
  }
}).then((ok) => process.exit(ok ? 0 : 1));
