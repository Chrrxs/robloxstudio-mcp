#!/usr/bin/env node
// In multi-session deployments, every MCP subprocess past the first runs
// in proxy mode (forwarding to the suite's shared port). Topology-backed tools
// must use the primary's actual connected process Instances rather than the
// proxy's empty local bridge state.
//
// The regression's observable contract is that a proxy can discover the
// play-server process, read that exact Instance's runtime logs, and route
// other topology-backed tools through the primary.
//
// The test starts a control subprocess first so a primary exists on the suite
// port, then starts a second subprocess which must proxy through that primary.

import {
  McpClient,
  runTest,
  assert,
  assertContains,
  safeStopPlaytest,
  selectRoutingPeer,
  startPlaytestAndWait,
  waitForEditPeer,
} from './lib/mcp-client.mjs';
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

    // Case 1: the proxy sees nested process topology and can read the exact
    // play-server Instance's log buffer.
    const connected = await proxy.callTool('get_connected_instances', {});
    const instances = connected.instances ?? [];
    assert(Array.isArray(instances) && instances.length > 0,
      `get_connected_instances reports >=1 Instance (got: ${Array.isArray(instances) ? instances.length : 'non-array'})`);
    const serverPeer = selectRoutingPeer(connected, 'server');
    if (!serverPeer) {
      throw new Error(`get_connected_instances did not expose a server peer: ${JSON.stringify(connected)}`);
    }
    const logs = await proxy.callTool('get_runtime_logs', {
      instance_id: serverPeer.instanceId,
      tail: 50,
    });
    assert(logs.instanceId === serverPeer.instanceId,
      'get_runtime_logs returns the selected play-server process key');
    assertContains(JSON.stringify(logs.entries ?? []), MARKER,
      'selected Instance log entries contain our marker');

    // Case 2: get_memory_breakdown target=all should produce per-peer data
    const mem = await proxy.callTool('get_memory_breakdown', { target: 'all' });
    const memPeers = Object.keys(mem);
    assert(memPeers.length > 0,
      `get_memory_breakdown target=all reports per-peer data (got peers: ${JSON.stringify(memPeers)})`);
  } finally {
    await safeStopPlaytest(proxy);
  }
}).then((ok) => process.exit(ok ? 0 : 1));
