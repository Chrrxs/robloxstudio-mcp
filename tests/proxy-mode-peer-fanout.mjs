#!/usr/bin/env node
// In multi-session deployments, every MCP subprocess past the first runs
// in proxy mode (forwarding to the suite's shared port). Tools that enumerate
// capture/peer data — get_runtime_logs target=all, get_connected_instances,
// get_memory_breakdown target=all — must return the primary's actual connected
// data, not the proxy's own empty instances Map. ProxyBridgeService caches
// the primary's /instances response and overrides getInstances() so any
// peer-fanout tool works from any subprocess.
//
// Regression test for the multi-session proxy-mode fanout bug fixed in
// v2.11.3. The bug's signature was perCaptureNextSince:{} (zero keys, not
// zero values), meaning the aggregator didn't even attempt to query any
// capture buffer.
//
// The test starts a control subprocess first so a primary exists on the suite
// port, then starts a second subprocess which must proxy through that primary.

import { McpClient, runTest, assert, assertContains, startPlaytestAndWait, safeStopPlaytest, waitForEditPeer } from './lib/mcp-client.mjs';
import { setTimeout as delay } from 'node:timers/promises';

const MARKER = 'FANOUT_MARKER_d7e4f1';

await runTest('proxy-mode subprocess fans out to peers via primary', async ({ track }) => {
  const control = track(new McpClient('primary-control'));
  await control.start();
  await control.initialize();
  await waitForEditPeer(control);

  const proxy = track(new McpClient('proxy'));
  await proxy.start();
  await proxy.initialize();

  // Confirm setup: this subprocess MUST be in proxy mode for the test to
  // actually exercise the bug. If it's primary, the bug doesn't trigger.
  assert(proxy.isProxy(), 'spawned subprocess is in proxy mode (suite primary exists)');
  assert(!proxy.isPrimary(), 'spawned subprocess is NOT a fake primary');

  await startPlaytestAndWait(proxy);

  try {
    // Emit a marker via the primary's plugin so the runtime log buffer has
    // a distinctive entry. eval_server_runtime works in proxy mode (uses
    // sendRequest, which forwards to primary) — so we can drive a print
    // into the play-server DM from the proxy itself.
    await proxy.callTool('eval_server_runtime', {
      code: `print("${MARKER}")\nreturn "ok"`,
    });

    // Give LogService.MessageOut a moment to flush to the buffer
    await delay(500);

    // Case 1: get_runtime_logs target=all should now have capture buffers
    const logs = await proxy.callTool('get_runtime_logs', { target: 'all', tail: 50 });
    const captureKeys = Object.keys(logs.perCaptureNextSince ?? {});
    assert(captureKeys.length > 0,
      `get_runtime_logs target=all reports at least one capture buffer (got: ${captureKeys.length} -> ${JSON.stringify(captureKeys)})`);
    assertContains(JSON.stringify(logs), MARKER,
      'log entries contain our marker (fanout actually reached primary)');

    // Case 2: get_connected_instances should not be empty when peers exist
    const instances = await proxy.callTool('get_connected_instances', {});
    // Compact response shape: { instances: [{ id, name, roles }] }
    const instList = instances.instances ?? instances;
    assert(Array.isArray(instList) && instList.length > 0,
      `get_connected_instances reports >=1 peer (got: ${Array.isArray(instList) ? instList.length : 'non-array'})`);

    // Case 3: get_memory_breakdown target=all should produce per-peer data
    const mem = await proxy.callTool('get_memory_breakdown', { target: 'all' });
    const memPeers = Object.keys(mem);
    assert(memPeers.length > 0,
      `get_memory_breakdown target=all reports per-peer data (got peers: ${JSON.stringify(memPeers)})`);
  } finally {
    await safeStopPlaytest(proxy);
  }
}).then((ok) => process.exit(ok ? 0 : 1));
