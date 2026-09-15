#!/usr/bin/env node
// Field report #5: execute_luau never cuts a large return value silently; the result carries
// truncated/totalBytes/returnedBytes and max_output_bytes raises the budget. Also a regression
// check: HttpService:GetAsync("http://127.0.0.1:<port>/...") keeps working from the edit context.
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { McpClient, runTest } from '../lib/mcp-client.mjs';

const KB = 1000;
const MEASURE_SIZES = [30 * KB, 200 * KB, 2000 * KB];

function record(label, args, result) {
  const body = result.body;
  const returnValue = typeof body?.returnValue === 'string' ? body.returnValue : undefined;
  const line = {
    label,
    timestamp: new Date().toISOString(),
    tool: 'execute_luau',
    args: { ...args, code: args.code.length > 120 ? `${args.code.slice(0, 120)}…` : args.code },
    isError: result.isError,
    success: body?.success,
    returnValueLength: returnValue?.length,
    returnValueBytes: returnValue === undefined ? undefined : Buffer.byteLength(returnValue),
    truncated: body?.truncated,
    totalBytes: body?.totalBytes,
    returnedBytes: body?.returnedBytes,
    maxOutputBytes: body?.maxOutputBytes,
    responseBytes: Buffer.byteLength(JSON.stringify(body ?? null)),
    error: body?.error,
  };
  console.log(JSON.stringify(line));
  return line;
}

await runTest('field #5 execute_luau large return truncation contract', async ({ track }) => {
  const client = track(new McpClient('field-05', { startupTimeoutMs: 20000 }));
  await client.start();
  await client.initialize();
  const instanceId = process.env.MCP_INSTANCE_ID;
  assert.ok(instanceId, 'Run through run-all.mjs --managed');

  const call = (args, timeoutMs = 120_000) => client.callToolResult('execute_luau', { instance_id: instanceId, target: 'edit', ...args }, timeoutMs);

  console.log('--- measurement: raw lengths layer by layer (same commands before and after the fix) ---');
  const measured = {};
  for (const size of MEASURE_SIZES) {
    const args = { code: `return string.rep("x", ${size})` };
    measured[size] = record(`string.rep ${size}`, args, await call(args));
  }
  const concatArgs = { code: `local t = {} for i = 1, ${30 * KB} do t[i] = "y" end return table.concat(t)` };
  measured.concat = record('table.concat 30000', concatArgs, await call(concatArgs));

  console.log('--- contract ---');
  const small = await call({ code: 'return "abc"' });
  assert.equal(small.body.success, true);
  assert.equal(small.body.returnValue, 'abc');
  assert.equal(small.body.truncated, false, 'a small return value carries truncated:false');
  assert.equal(small.body.totalBytes, 3, 'totalBytes is the byte length of the return value');
  assert.equal(small.body.returnedBytes, 3, 'returnedBytes is the byte length of the return value');

  const capped = await call({ code: `return string.rep("x", ${200 * KB})`, max_output_bytes: 1000 });
  record('200 kB, max_output_bytes=1000', { code: 'string.rep 200000', max_output_bytes: 1000 }, capped);
  assert.equal(capped.isError, false, `max_output_bytes must be accepted: ${JSON.stringify(capped.body).slice(0, 300)}`);
  assert.equal(capped.body.truncated, true, 'truncated:true when the value exceeds the budget');
  assert.equal(capped.body.totalBytes, 200 * KB, 'totalBytes is the size of the full return value');
  assert.equal(capped.body.returnedBytes, 1000, 'returnedBytes = max_output_bytes');
  assert.equal(capped.body.returnValue.length, 1000, 'returnValue is exactly the budget');

  const defaultRun = measured[200 * KB];
  assert.equal(defaultRun.success, true);
  if (defaultRun.truncated === true) {
    assert.equal(defaultRun.totalBytes, 200 * KB, 'totalBytes is correct when the default budget truncates');
    assert.equal(defaultRun.returnedBytes, defaultRun.returnValueBytes, 'returnedBytes matches the delivered value');
    assert.ok(defaultRun.returnedBytes < 200 * KB);
  } else {
    assert.equal(defaultRun.truncated, false, 'truncated:false when the default budget does not truncate');
    assert.equal(defaultRun.returnValueLength, 200 * KB, '200 kB return value is complete');
    assert.equal(defaultRun.totalBytes, 200 * KB);
  }

  const full = await call({ code: `return string.rep("x", ${200 * KB})`, max_output_bytes: 300 * KB });
  record('200 kB, max_output_bytes=300000', { code: 'string.rep 200000', max_output_bytes: 300 * KB }, full);
  assert.equal(full.body.truncated, false, 'truncated:false when the budget is large enough');
  assert.equal(full.body.returnValue.length, 200 * KB, 'a large value within the budget is returned in full');
  assert.equal(full.body.returnedBytes, 200 * KB);

  const twoMb = await call({ code: `return string.rep("x", ${2000 * KB})`, max_output_bytes: 2100 * KB });
  record('2 MB, max_output_bytes=2100000', { code: 'string.rep 2000000', max_output_bytes: 2100 * KB }, twoMb);
  assert.equal(twoMb.body.truncated, false);
  assert.equal(twoMb.body.returnValue.length, 2000 * KB, '2 MB return value within the budget is complete');

  const tooBig = await call({ code: 'return 1', max_output_bytes: 10 ** 12 });
  record('max_output_bytes upper bound', { code: 'return 1', max_output_bytes: 10 ** 12 }, tooBig);
  assert.equal(tooBig.isError, true, 'max_output_bytes above the HTTP body limit is rejected');

  const printed = await call({ code: `for i = 1, 50 do print(string.rep("p", 1000)) end return "done"`, max_output_bytes: 5000 });
  record('print output 50 x 1000 B, max_output_bytes=5000', { code: 'print loop', max_output_bytes: 5000 }, printed);
  assert.equal(printed.body.returnValue, 'done');
  assert.equal(printed.body.outputTruncated, true, 'print output is flagged by the same budget');
  assert.equal(printed.body.outputTotalBytes, 50 * 1000 + 49, 'outputTotalBytes = lines + separators');
  assert.ok(Array.isArray(printed.body.output) && printed.body.output.length < 50);

  console.log('--- regression: HttpService:GetAsync http://127.0.0.1 (edit context) ---');
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/plain');
    res.end(`pong:${req.url}`);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  try {
    const enabled = await call({ code: 'return game:GetService("HttpService").HttpEnabled' });
    console.log(JSON.stringify({ label: 'HttpEnabled before', returnValue: enabled.body.returnValue }));
    if (enabled.body.returnValue !== 'true') {
      const set = await call({ code: 'local ok, err = pcall(function() game:GetService("HttpService").HttpEnabled = true end) return tostring(ok) .. ":" .. tostring(err)' });
      console.log(JSON.stringify({ label: 'HttpEnabled set attempt', returnValue: set.body.returnValue }));
    }
    const probe = await call({ code: `local ok, res = pcall(function() return game:GetService("HttpService"):GetAsync("http://127.0.0.1:${port}/field05") end) return tostring(ok) .. "|" .. tostring(res)` });
    record('HttpService:GetAsync 127.0.0.1', { code: `GetAsync http://127.0.0.1:${port}/field05` }, probe);
    if (probe.body.returnValue === 'true|pong:/field05') {
      console.log('  ✓ execute_luau reaches localhost HTTP from the edit context');
    } else if (String(probe.body.returnValue).includes('Http requests are not enabled')) {
      console.log('  ⏭️ HttpEnabled is off and the plugin cannot enable it; localhost regression skipped: ' + probe.body.returnValue);
    } else {
      assert.fail(`unexpected localhost HTTP result: ${probe.body.returnValue}`);
    }
  } finally {
    server.close();
  }
});
