#!/usr/bin/env node

import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  McpClient,
  assert,
  routingPeers,
  runTest,
  selectRoutingPeer,
  startPlaytestAndWait,
} from './lib/mcp-client.mjs';

const MAX_CONCURRENT_RESPONSE_MS = 3000;
const CAPTURE_DURATION_MS = 5000;
const MAX_EVENTS = 1_000_000;

function assertDescending(rows, field, label) {
  if (!Array.isArray(rows)) throw new Error(`${label}: expected an array`);
  for (let index = 1; index < rows.length; index += 1) {
    const previous = Number(rows[index - 1]?.[field]);
    const current = Number(rows[index]?.[field]);
    if (Number.isFinite(previous) && Number.isFinite(current) && previous < current) {
      throw new Error(`${label}: ${field} increased at rows ${index} and ${index + 1} (${previous} < ${current})`);
    }
  }
  assert(true, `${label} remains sorted by ${field} descending`);
}

async function waitForRuntimePeersToDrain(client, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await client.callTool('get_connected_instances', {});
    const peers = routingPeers(last);
    if (!peers.some((peer) => peer.role === 'server' || peer.role.startsWith('client-'))) return;
    await delay(250);
  }
  throw new Error(`runtime peers did not drain after playtest stop: ${JSON.stringify(last)}`);
}

function newSevereProfilerLogs(logs) {
  const entries = Array.isArray(logs?.entries) ? logs.entries : [];
  return entries.filter((entry) => {
    const message = String(entry?.message ?? '');
    const severity = String(entry?.level ?? entry?.messageType ?? entry?.type ?? '');
    return /micro.?profiler|robloxstudio-mcp/i.test(message)
      && /error|exception|timeout|failed/i.test(`${severity} ${message}`);
  });
}

await runTest('high-volume MicroProfiler capture remains cooperative', async ({ track }) => {
  const client = track(new McpClient('micro-profiler-responsiveness'));
  const outputDirectory = mkdtempSync(path.join(os.tmpdir(), 'rsmcp-profiler-responsive-'));
  const rawOutputPath = path.join(outputDirectory, 'capture.mp');
  const cleanupErrors = [];
  let bodyError;
  let playtestStarted = false;
  let capturePromise;

  try {
    await client.start();
    await client.initialize();
    playtestStarted = true;
    await startPlaytestAndWait(client, { timeoutSec: 60 });

    const connected = await client.callTool('get_connected_instances', {});
    const serverPeer = selectRoutingPeer(connected, 'server');
    const editPeer = selectRoutingPeer(connected, 'edit');
    if (!serverPeer || !editPeer) {
      throw new Error(`runtime log Peers were not connected: ${JSON.stringify(connected)}`);
    }
    assert(serverPeer.instanceId === editPeer.instanceId,
      'solo edit and server Peers share one process Instance');
    const logInstanceId = editPeer.instanceId;
    const processLogBaseline = await client.callTool('get_runtime_logs', {
      instance_id: logInstanceId,
      tail: 1,
    });
    const processCursor = processLogBaseline.nextCursor;
    assert(typeof processCursor === 'string' && processCursor.length > 0,
      'solo process log read returns an opaque cursor');

    const preflight = await client.callTool('execute_luau', {
      target: 'server',
      code: 'return "RSMCP_PROFILER_PREFLIGHT"',
    });
    assert(
      preflight.success === true && String(preflight.returnValue) === 'RSMCP_PROFILER_PREFLIGHT',
      'server peer accepts an adjacent request before profiling',
    );

    let captureSettled = false;
    const captureStartedAt = Date.now();
    capturePromise = client.callTool('capture_micro_profiler', {
      target: 'server',
      duration_ms: CAPTURE_DURATION_MS,
      focus: 'all',
      max_timers: 100,
      max_groups: 100,
      max_timers_per_group: 20,
      max_related_timers: 10,
      max_events: MAX_EVENTS,
      frame_window: 2000,
      include_idle: true,
      include_gpu: true,
      output_path: rawOutputPath,
    }, 120_000).finally(() => {
      captureSettled = true;
    });

    await delay(CAPTURE_DURATION_MS - 500);
    const probes = [];
    while (!captureSettled && probes.length < 50 && Date.now() - captureStartedAt < 60_000) {
      const issuedAt = Date.now();
      const [serverProbe, pluginProbe] = await Promise.all([
        client.callTool('get_connected_instances', {}, 5000),
        client.callTool('execute_luau', {
          target: 'server',
          code: 'return "RSMCP_CONCURRENT_RESPONSIVE"',
        }, 5000),
      ]);
      const latencyMs = Date.now() - issuedAt;
      if (!Array.isArray(serverProbe.instances) || serverProbe.instances.length === 0) {
        throw new Error(`MCP server probe failed during capture: ${JSON.stringify(serverProbe)}`);
      }
      if (pluginProbe.success !== true || String(pluginProbe.returnValue) !== 'RSMCP_CONCURRENT_RESPONSIVE') {
        throw new Error(`runtime plugin probe failed during capture: ${JSON.stringify(pluginProbe)}`);
      }
      probes.push({ offsetMs: issuedAt - captureStartedAt, latencyMs });
      await delay(25);
    }

    const capture = await capturePromise;
    const captureElapsedMs = Date.now() - captureStartedAt;
    assert(capture.ok === true && !capture.error,
      `high-volume capture_micro_profiler succeeds (${JSON.stringify({ error: capture.error, counts: capture.counts })})`);
    assert(capture.applied?.max_events === MAX_EVENTS && capture.applied?.frame_window === 2000,
      'high-volume capture applies the requested event and frame limits');
    assert(Number.isInteger(capture.counts?.events_sampled) && capture.counts.events_sampled > 0,
      `high-volume capture samples events (${capture.counts?.events_sampled})`);
    assert(probes.length > 0, `at least one responsiveness probe overlaps the capture (${JSON.stringify(probes)})`);
    assert(probes.some((probe) => probe.offsetMs >= CAPTURE_DURATION_MS),
      `a responsiveness probe overlaps post-capture analysis (${JSON.stringify(probes)})`);
    const maxProbeLatencyMs = Math.max(...probes.map((probe) => probe.latencyMs));
    assert(maxProbeLatencyMs < MAX_CONCURRENT_RESPONSE_MS,
      `concurrent server/plugin latency stays below ${MAX_CONCURRENT_RESPONSE_MS}ms (max=${maxProbeLatencyMs}ms)`);
    assert(captureElapsedMs < 30_000,
      `high-volume capture completes before the 30s plugin bridge timeout (${captureElapsedMs}ms)`);
    assert(existsSync(rawOutputPath) && statSync(rawOutputPath).size > 0,
      `raw profiler snapshot is written (${statSync(rawOutputPath).size} bytes)`);

    assertDescending(capture.top_timers, 'inclusive_us', 'cooperative timer sort');
    assertDescending(capture.top_timers_by_exclusive, 'exclusive_us', 'cooperative exclusive timer sort');
    assertDescending(capture.top_groups, 'inclusive_us', 'cooperative group sort');
    assertDescending(capture.top_call_edges, 'inclusive_us', 'cooperative call-edge sort');
    assertDescending(capture.frame_summary?.top_frames, 'duration_us', 'cooperative frame sort');

    const adjacentCapture = await client.callTool('capture_micro_profiler', {
      target: 'server',
      duration_ms: 100,
      max_events: 10_000,
      frame_window: 30,
      max_timers: 5,
      max_groups: 5,
      max_timers_per_group: 0,
      max_related_timers: 0,
    }, 60_000);
    assert(adjacentCapture.ok === true && adjacentCapture.counts?.events_sampled > 0,
      `a follow-up bounded profiler capture succeeds (${JSON.stringify(adjacentCapture.counts)})`);

    const after = await client.callTool('execute_luau', {
      target: 'server',
      code: 'return "RSMCP_PROFILER_AFTER"',
    });
    assert(after.success === true && String(after.returnValue) === 'RSMCP_PROFILER_AFTER',
      'server peer remains usable after profiler cleanup');

    const processLogs = await client.callTool('get_runtime_logs', {
      instance_id: logInstanceId,
      cursor: processCursor,
      tail: 200,
    });
    const severeLogs = newSevereProfilerLogs(processLogs);
    assert(severeLogs.length === 0,
      `runtime logs contain no new profiler/plugin timeout or error (${JSON.stringify(severeLogs)})`);
    console.log(
      `  capture elapsed=${captureElapsedMs}ms events=${capture.counts.events_sampled} ` +
      `buffer=${capture.counts.buffer_bytes} maxProbeLatency=${maxProbeLatencyMs}ms ` +
      `runtimeLogs=${(processLogs.entries ?? []).length}`,
    );
  } catch (error) {
    bodyError = error;
    throw error;
  } finally {
    if (capturePromise) {
      try {
        await capturePromise;
      } catch (error) {
        if (error !== bodyError) {
          cleanupErrors.push(error instanceof Error ? error : new Error(String(error)));
        }
      }
    }
    if (playtestStarted) {
      try {
        const stopped = await client.callTool('solo_playtest', { action: 'stop' }, 30_000);
        if (stopped.success !== true) throw new Error(`solo_playtest stop failed: ${JSON.stringify(stopped)}`);
        await waitForRuntimePeersToDrain(client);
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error : new Error(String(error)));
      }
    }
    try {
      rmSync(outputDirectory, { recursive: true, force: true });
    } catch (error) {
      cleanupErrors.push(error instanceof Error ? error : new Error(String(error)));
    }
    if (cleanupErrors.length > 0) {
      if (bodyError) {
        throw new AggregateError([bodyError, ...cleanupErrors], 'profiler regression and cleanup failed', { cause: bodyError });
      }
      throw new AggregateError(cleanupErrors, 'profiler regression cleanup failed');
    }
  }
}).then((ok) => process.exit(ok ? 0 : 1));
