#!/usr/bin/env node
// Native Studio probe. No fake WebStreamClient, tool HTTP proxy, automatic retry,
// process-name cleanup, or preinstalled user plugin. Build bundles before running.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configureStudioDirectoryIsolation, createIsolatedStudioDirectory } from '../scripts/studio-lifecycle.mjs';
import { DIST, McpClient, REPO_ROOT, instancePeers, selectEditInstance } from './lib/mcp-client.mjs';
import { callMcpHttpTool } from './lib/mcp-http-client.mjs';
import { openManagedStudioSession } from './lib/managed-studio-session.mjs';
import { openStudioFrameRecorder } from './lib/studio-frame-recorder.mjs';
import { acquireSuitePort } from './lib/test-port.mjs';

const MiB = 1024 * 1024;
const FRAME_LIMIT = 64 * MiB;
const REQUEST_TIMEOUT_MS = 30000;
const CONTROL_TIMEOUT_MS = 5000;
// Native Studio 0.737.0.7371584 rejects UTF-8 byte lengths >= 200000.
const STRING_VALUE_LIMIT_EXCLUSIVE = 200000;
class ProbeTransportFailure extends Error {}
const HELP = `Usage: node tests/studio-payload-boundaries.mjs [options]
  --smoke                     Tiny native setup/readback probe instead of cap cases
  --explore                   Report native/engine rejection without calling it success
  --only=execute,property,chunks,response,http
  --request-sizes=1MiB,16MiB,52428801,64MiB,67108865
                              Exact serialized admission-envelope bytes, not source bytes
  --response-sizes=1MiB,64MiB,67108865
                              Exact native response-envelope bytes (calibrated at runtime)
  --http-sizes=50MiB,52428801 Exact production HTTP JSON-body bytes
  --chunk-bytes=64KiB --chunk-count=4
  --rpc-timeout-ms=45000       Caller wait only; bridge request-waiter deadline stays 30000ms
Environment equivalents: RSMCP_PAYLOAD_EXPLORE=1, RSMCP_PAYLOAD_ONLY,
RSMCP_PAYLOAD_REQUEST_SIZES, RSMCP_PAYLOAD_RESPONSE_SIZES,
RSMCP_PAYLOAD_CHUNK_BYTES, RSMCP_PAYLOAD_CHUNK_COUNT, RSMCP_PAYLOAD_RPC_TIMEOUT_MS.
Without flags this is strict acceptance, including exact 64MiB and +1 requests and responses.
StringValue cases cover 199999/200000/200001 bytes and multibyte values at the same boundary.
Documented engine rejection is distinct from 64MiB transport admission.
Use --smoke first, then --explore --only=execute --request-sizes=1MiB,4MiB,16MiB.
Each JSON line is a native observation. Exploration is NOT acceptance proof.
A primary RPC/protocol failure aborts further cases after bounded independent HTTP diagnostics.
`;

function parseBytes(value) {
  const match = /^(\d+)(KiB|MiB|B)?$/u.exec(value);
  assert.ok(match, `Invalid byte size ${JSON.stringify(value)}`);
  const bytes = Number(match[1]) * ({ KiB: 1024, MiB, B: 1 }[match[2] ?? 'B']);
  assert.ok(Number.isSafeInteger(bytes) && bytes > 0 && bytes <= 96 * MiB, 'Sizes must be positive integers at most 96MiB');
  return bytes;
}

function options() {
  const values = new Map();
  const flags = new Set();
  for (const arg of process.argv.slice(2)) {
    if (['--help', '--smoke', '--explore'].includes(arg)) flags.add(arg.slice(2));
    else {
      const match = /^--(only|request-sizes|response-sizes|http-sizes|chunk-bytes|chunk-count|rpc-timeout-ms)=(.+)$/u.exec(arg);
      assert.ok(match, `Unknown option ${arg}; use --help`);
      values.set(match[1], match[2]);
    }
  }
  if (flags.has('help')) { console.log(HELP); return undefined; }
  const value = (name, fallback) => values.get(name) ?? process.env[`RSMCP_PAYLOAD_${name.toUpperCase().replaceAll('-', '_')}`] ?? fallback;
  const smoke = flags.has('smoke');
  const only = new Set(value('only', 'execute,property,chunks,response,http').split(','));
  for (const kind of only) assert.ok(['execute', 'property', 'chunks', 'response', 'http'].includes(kind), `Unknown case ${kind}`);
  const chunkCount = Number(value('chunk-count', smoke ? '3' : '4'));
  const rpcTimeoutMs = Number(value('rpc-timeout-ms', '45000'));
  assert.ok(Number.isSafeInteger(chunkCount) && chunkCount > 1 && chunkCount <= 96, 'chunk-count must be 2..96');
  assert.ok(Number.isSafeInteger(rpcTimeoutMs) && rpcTimeoutMs >= 1000 && rpcTimeoutMs <= 600000, 'rpc-timeout-ms must be 1000..600000');
  return {
    smoke, explore: flags.has('explore') || process.env.RSMCP_PAYLOAD_EXPLORE === '1', only,
    requestSizes: value('request-sizes', smoke ? '4KiB,64KiB' : '1MiB,16MiB,52428801,64MiB,67108865').split(',').map(parseBytes),
    responseSizes: value('response-sizes', smoke ? '64KiB' : '1MiB,64MiB,67108865').split(',').map(parseBytes),
    httpSizes: value('http-sizes', smoke ? '64KiB' : '50MiB,52428801').split(',').map(parseBytes),
    chunkBytes: parseBytes(value('chunk-bytes', '64KiB')), chunkCount, rpcTimeoutMs,
  };
}

const config = options();
if (config) await main(config);

async function main(config) {
  const rows = [];
  const failures = [];
  const cleanupErrors = [];
  const marker = `__MCP_Payload_${randomUUID().replaceAll('-', '')}`;
  const markerLiteral = JSON.stringify(marker);
  const rootCode = `local f=assert(workspace:FindFirstChild(${markerLiteral}),"owned fixture missing"); `;
  // ComputeStringHash returns binary, not hex (official EncodingService docs).
  // Prove this conversion against a known vector on the actual native build.
  const digestCode = 'local function digest(s) local h=game:GetService("EncodingService"):ComputeStringHash(s,Enum.HashAlgorithm.Sha256); return (h:gsub(".",function(c) return string.format("%02x",string.byte(c)) end)) end; ';
  let portLease;
  let recorderLease;
  let recorder;
  let worker;
  let session;
  let primary;
  let peerId;
  let native;
  let runtimeEnv;
  let managedLaunchAttempted = false;
  let fixtureCreated = false;
  let closeConfirmed = false;
  const sha256 = value => createHash('sha256').update(value).digest('hex');
  const emit = row => { rows.push(row); console.log(JSON.stringify(row)); };

  async function call(name, args) {
    const started = performance.now();
    try {
      const result = await primary.rpc('tools/call', { name, arguments: args }, config.rpcTimeoutMs);
      const text = result.content?.find(block => block.type === 'text')?.text;
      const body = result.structuredContent ?? (typeof text === 'string' ? JSON.parse(text) : undefined);
      assert.ok(body && typeof body === 'object', `No structured result from ${name}`);
      const observation = { body, isError: result.isError === true, elapsedMs: Math.round(performance.now() - started) };
      const failure = errorSummary(observation);
      if (failure) emit({ type: 'tool_rejection', tool: name, requestId: args.operation_id, failure, elapsedMs: observation.elapsedMs });
      return observation;
    } catch (error) {
      const failure = { rpcError: error.message, elapsedMs: Math.round(performance.now() - started) };
      emit({ type: 'primary_rpc_failure', tool: name, requestId: args.operation_id,
        ...failure, frames: recorder?.frames.get(args.operation_id) ?? [],
        stdoutBytesReceived: primary.stdoutBytesReceived, stdoutBufferedBytes: primary.stdoutBufferedBytes });
      const [observedStatus, observedReadback] = await Promise.all([
        args.operation_id ? status(args.operation_id) : { unavailable: 'No operation ID' },
        fixtureCreated ? readback().catch(diagnosticError => ({ unavailable: diagnosticError.message })) : { unavailable: 'Fixture not created' },
      ]);
      emit({ type: 'primary_rpc_failure_diagnostics', requestId: args.operation_id,
        channel: 'independent bounded HTTP control', status: observedStatus, readback: observedReadback,
        stdoutBytesReceived: primary.stdoutBytesReceived, stdoutBufferedBytes: primary.stdoutBufferedBytes,
        stderr: primary.recentStderr(5).replaceAll(runtimeEnv.ROBLOX_STUDIO_AUTH_TOKEN, '<REDACTED>'), continued: false });
      throw new ProbeTransportFailure(`Primary RPC/protocol failed: ${error.message}`, { cause: error });
    }
  }

  async function controlCall(name, args) {
    const started = performance.now();
    try {
      const body = await callMcpHttpTool(name, args, {
        port: portLease.port, env: runtimeEnv, timeoutMs: CONTROL_TIMEOUT_MS,
      });
      return { body, isError: false, elapsedMs: Math.round(performance.now() - started) };
    } catch (error) {
      return error.body
        ? { body: error.body, isError: true, elapsedMs: Math.round(performance.now() - started) }
        : { rpcError: error.message, elapsedMs: Math.round(performance.now() - started) };
    }
  }
  const controlExecute = code => controlCall('execute_luau', {
    instance_id: session.instanceId, target: 'edit', operation_id: randomUUID(), code,
  });

  function requireSuccess(result, label) {
    const failure = errorSummary(result);
    if (failure) assert.fail(`${label}: ${JSON.stringify(failure)}`);
    return result.body;
  }

  const execute = (code, operation_id = randomUUID()) => call('execute_luau', {
    instance_id: session.instanceId, target: 'edit', operation_id, code,
  });
  async function readback() {
    return JSON.parse(requireSuccess(await controlExecute(rootCode + digestCode + 'return {mutations=f:GetAttribute("Mutations"), lastOperation=f:GetAttribute("LastOperation"), bytes=#f.Payload.Value, sha256=digest(f.Payload.Value), archivable=f.Payload.Archivable}'), 'independent tiny HTTP readback').returnValue);
  }
  async function status(requestId) {
    const result = await controlCall('get_request_status', { request_id: requestId });
    if (result.rpcError || result.isError) return { unavailable: result.rpcError ?? result.body };
    const body = result.body;
    return Object.fromEntries(['requestId', 'state', 'stage', 'outcome', 'executionOutcome', 'queuedAt', 'dispatchedAt', 'executionStartedAt', 'executionCompletedAt', 'settledAt', 'resultUnavailable'].filter(key => body[key] !== undefined).map(key => [key, body[key]]));
  }
  function errorSummary(result) {
    if (result.rpcError) return { rpcError: result.rpcError };
    if (!result.isError && result.body.success !== false && !result.body.error && !result.body.summary?.failed) return undefined;
    return { isError: result.isError, ...result.body };
  }
  function assertEngineSizeRejection(body, bytes, succeeded = 0) {
    assert.equal(body?.summary?.failed, 1, 'Native property assignment rejected exactly one value');
    assert.equal(body.summary.succeeded, succeeded);
    const rejected = body.results?.find(result => result.property === 'Value' && result.success === false);
    const diagnostic = rejected?.error;
    assert.equal(typeof diagnostic, 'string', 'Engine rejection preserves its real diagnostic');
    assert.ok(diagnostic.includes(String(bytes)), 'Diagnostic reports the actual UTF-8 byte length');
    assert.ok(diagnostic.includes(String(STRING_VALUE_LIMIT_EXCLUSIVE)), 'Diagnostic reports the native exclusive boundary');
    assert.deepEqual(rejected.details, {
      stage: 'property_write', bytes, limitBytes: STRING_VALUE_LIMIT_EXCLUSIVE - 1,
    }, 'Measured per-property diagnostics retain the supported maximum, not a transport limit');
  }
  function requestEnvelope(requestId, endpoint, data, remainingMs = REQUEST_TIMEOUT_MS) {
    return { kind: 'request', requestId, peerId, target: 'edit', endpoint, data, remainingMs };
  }
  const frameBytes = (requestId, endpoint, data) => Buffer.byteLength(JSON.stringify(requestEnvelope(requestId, endpoint, data)));
  function checkFrames(requestId, endpoint, data) {
    const frames = recorder.frames.get(requestId) ?? [];
    const requests = frames.filter(frame => frame.kind === 'request');
    assert.ok(requests.length <= 1, `Operation ${requestId} must not be replayed`);
    for (const frame of requests) {
      assert.equal(frame.peerId, peerId);
      assert.equal(frame.target, 'edit');
      assert.equal(frame.endpoint, endpoint);
      const expectedBytes = Buffer.byteLength(JSON.stringify(requestEnvelope(requestId, endpoint, data, frame.remainingMs)));
      assert.equal(frame.bytes, expectedBytes, 'Observed native request bytes equal the real serialized envelope, including remainingMs and UTF-8');
    }
    return frames;
  }
  async function runCase(label, action) {
    try { await action(); }
    catch (error) {
      if (error instanceof ProbeTransportFailure) throw error;
      failures.push(new Error(`${label}: ${error.message}`, { cause: error }));
      emit({ type: 'case_failure', label, error: error.message });
    }
  }

  async function requestCase(kind, targetBytes) {
    const requestId = randomUUID();
    requireSuccess(await execute(rootCode + 'f.Payload.Value="sentinel"; return true'), 'reset property sentinel');
    const before = await readback();
    const endpoint = kind === 'execute' ? '/api/execute-luau' : '/api/set-properties';
    // Escaped JSON, multibyte UTF-8, and ASCII filler all contribute different
    // amounts. Add only one-byte ASCII after serializing the actual full shape.
    const seed = '界é"\\\n'.repeat(Math.max(1, Math.floor(targetBytes / 128)));
    const mutation = rootCode + `f:SetAttribute("Mutations",f:GetAttribute("Mutations")+1); f:SetAttribute("LastOperation",${JSON.stringify(requestId)}); return "tiny-ok"`;
    const dataFor = filler => kind === 'execute'
      ? { code: `--[=[${seed}${filler}]=]\n${mutation}` }
      : { instancePath: `game.Workspace.${marker}.Payload`, properties: { Value: seed + filler } };
    const overhead = frameBytes(requestId, endpoint, dataFor(''));
    assert.ok(targetBytes >= overhead, `Requested ${targetBytes} bytes cannot fit fixture envelope (${overhead})`);
    const data = dataFor('x'.repeat(targetBytes - overhead));
    assert.equal(frameBytes(requestId, endpoint, data), targetBytes);
    const payload = kind === 'execute' ? data.code : data.properties.Value;
    const payloadBytes = Buffer.byteLength(payload);
    const payloadSha256 = sha256(payload);
    const result = await call(kind === 'execute' ? 'execute_luau' : 'set_properties', {
      instance_id: session.instanceId, operation_id: requestId,
      ...(kind === 'execute' ? { target: 'edit', ...data } : data),
    });
    const observedStatus = await status(requestId);
    const after = await readback();
    const frames = checkFrames(requestId, endpoint, data);
    const failure = errorSummary(result);
    emit({ type: 'request', case: kind, requestId, admissionFrameBytes: targetBytes,
      payloadBytes, payloadUtf16Units: payload.length, payloadSha256,
      envelopeAndEscapingBytes: targetBytes - payloadBytes, elapsedMs: result.elapsedMs,
      classification: failure ? targetBytes > FRAME_LIMIT ? 'transport_rejection' : kind === 'property' && payloadBytes >= STRING_VALUE_LIMIT_EXCLUSIVE ? 'engine_rejection' : 'rejected_or_unknown' : 'success', failure,
      status: observedStatus, frames, before, after });
    if (kind === 'property' && payloadBytes >= STRING_VALUE_LIMIT_EXCLUSIVE && targetBytes <= FRAME_LIMIT && failure) {
      assert.equal(frames.filter(frame => frame.kind === 'request').length, 1);
      assertEngineSizeRejection(result.body, payloadBytes);
      assert.deepEqual(after, before, 'Engine size rejection preserves the prior property');
      return;
    }
    if (targetBytes > FRAME_LIMIT) {
      assert.equal(result.isError, true, 'Oversized admission returns a structured MCP error');
      assert.equal(result.body.error, 'request_too_large');
      assert.equal(result.body.transportStage, 'server_send');
      assert.equal(result.body.bytes, targetBytes);
      assert.equal(result.body.limitBytes, FRAME_LIMIT);
      assert.equal(result.body.stage, 'queued');
      assert.equal(result.body.outcome, 'not_executed');
      assert.equal(result.body.requestId, requestId);
      assert.equal(result.body.targetPeerId, peerId);
      assert.equal(frames.length, 0, 'Rejected admission never reached Studio');
      assert.deepEqual(after, before, 'Tiny independent readback proves oversize rejection did not mutate');
      return;
    }
    if (failure) {
      // An unknown outcome never means not_executed. Record any observed mutation
      // and never resubmit; exploration may continue with fresh operation IDs.
      if (result.body?.outcome === 'not_executed') assert.deepEqual(after, before);
      if (!config.explore) requireSuccess(result, `${kind} at ${targetBytes} bytes`);
      return;
    }
    assert.equal(frames.filter(frame => frame.kind === 'request').length, 1);
    if (kind === 'execute') {
      assert.equal(result.body.returnValue, 'tiny-ok');
      assert.equal(after.mutations, before.mutations + 1);
      assert.equal(after.lastOperation, requestId);
      assert.equal(after.sha256, before.sha256);
    } else {
      assert.equal(result.body.summary.succeeded, 1);
      assert.equal(after.bytes, payloadBytes);
      assert.equal(after.sha256, payloadSha256, 'Independent native SHA256 verifies full persisted StringValue.Value');
      assert.equal(after.mutations, before.mutations);
    }
  }

  async function propertyEngineCases() {
    for (const [character, count, padding, expected] of [
      ['x', 199999, '', 'success'], ['x', 200000, '', 'engine_rejection'], ['x', 200001, '', 'engine_rejection'],
      ['é', 99999, '', 'success'], ['é', 99999, 'x', 'success'],
      ['é', 100000, '', 'engine_rejection'], ['é', 100001, '', 'engine_rejection'],
    ]) await runCase(`StringValue ${count} ${character} plus ${padding.length} ASCII bytes`, async () => {
      requireSuccess(await execute(rootCode + 'f.Payload.Value="sentinel"; return true'), 'reset engine-boundary sentinel');
      const before = await readback();
      const requestId = randomUUID();
      const value = character.repeat(count) + padding;
      const data = { instancePath: `game.Workspace.${marker}.Payload`, properties: { Value: value } };
      const result = await call('set_properties', { instance_id: session.instanceId, operation_id: requestId, ...data });
      const after = await readback();
      const frames = checkFrames(requestId, '/api/set-properties', data);
      const failure = errorSummary(result);
      emit({ type: 'property_engine_boundary', requestId, character, characters: count + padding.length, asciiPaddingBytes: padding.length,
        payloadBytes: Buffer.byteLength(value), admissionFrameBytes: frameBytes(requestId, '/api/set-properties', data),
        expected, classification: failure ? 'engine_rejection' : 'success',
        failure, elapsedMs: result.elapsedMs, frames, before, after });
      assert.equal(frames.filter(frame => frame.kind === 'request').length, 1);
      if (failure) {
        assertEngineSizeRejection(result.body, Buffer.byteLength(value));
        assert.deepEqual(after, before);
        if (expected === 'success' && !config.explore) requireSuccess(result, 'native StringValue success boundary');
      } else {
        assert.notEqual(expected, 'engine_rejection', 'UTF-8 values at or above the observed exclusive native bound must reject');
        assert.equal(after.bytes, Buffer.byteLength(value));
        assert.equal(after.sha256, sha256(value));
      }
    });
    await runCase('StringValue partial property success', async () => {
      requireSuccess(await controlExecute(rootCode + 'f.Payload.Value="sentinel"; f.Payload.Archivable=true; return true'), 'reset mixed-property fixture');
      const before = await readback();
      const requestId = randomUUID();
      const data = {
        instancePath: `game.Workspace.${marker}.Payload`,
        properties: { Value: 'x'.repeat(STRING_VALUE_LIMIT_EXCLUSIVE), Archivable: false },
      };
      try {
        const result = await call('set_properties', { instance_id: session.instanceId, operation_id: requestId, ...data });
        const after = await readback();
        const observedStatus = await status(requestId);
        const frames = checkFrames(requestId, '/api/set-properties', data);
        emit({ type: 'property_partial_success', requestId, classification: 'engine_rejection',
          elapsedMs: result.elapsedMs, result: result.body, before, after, status: observedStatus, frames });
        assertEngineSizeRejection(result.body, STRING_VALUE_LIMIT_EXCLUSIVE, 1);
        assert.equal(result.body.summary.total, 2);
        assert.equal(after.archivable, false, 'Independent readback proves the valid sibling property committed');
        assert.equal(after.bytes, before.bytes);
        assert.equal(after.sha256, before.sha256, 'Rejected Value preserves its prior full contents');
        assert.equal(observedStatus.outcome, 'error', 'Mixed property outcome records the engine failure');
        assert.equal(observedStatus.executionOutcome, 'error');
      } finally {
        try {
          requireSuccess(await controlExecute(rootCode + 'f.Payload.Archivable=true; return true'), 'restore mixed-property fixture');
        } catch (error) { cleanupErrors.push(error); }
      }
    });
  }

  async function chunkCase() {
    const transfer = randomUUID();
    const chunks = [];
    const hash = createHash('sha256');
    let totalBytes = 0;
    const started = performance.now();
    const frameRecords = [];
    try {
      for (let index = 0; index < config.chunkCount; index++) {
        const prefix = `${transfer}:${index}:界é"\\\n`;
        const chunk = prefix + 'x'.repeat(config.chunkBytes - Buffer.byteLength(prefix));
        const key = `Chunk_${index + 1}`;
        chunks.push(key);
        hash.update(chunk);
        totalBytes += Buffer.byteLength(chunk);
        const requestId = randomUUID();
        const code = rootCode + `f:SetAttribute(${JSON.stringify(key)},${JSON.stringify(chunk)}); return "stored"`;
        const result = await execute(code, requestId);
        frameRecords.push(...checkFrames(requestId, '/api/execute-luau', { code }));
        const failure = errorSummary(result);
        if (failure) {
          const after = await readback();
          emit({ type: 'chunks', classification: 'rejected_or_unknown', chunkIndex: index,
            chunkBytes: config.chunkBytes, failure, status: await status(requestId), after });
          if (!config.explore) requireSuccess(result, `attribute chunk ${index}`);
          return;
        }
        const verification = JSON.parse(requireSuccess(await execute(rootCode + digestCode + `local s=assert(f:GetAttribute(${JSON.stringify(key)})); return {bytes=#s,sha256=digest(s)}`), 'independent attribute readback').returnValue);
        assert.equal(verification.bytes, config.chunkBytes);
        assert.equal(verification.sha256, sha256(chunk));
      }
      const expectedSha256 = hash.digest('hex');
      const reconstruction = await execute(rootCode + digestCode + `local pieces={}; for i=1,${config.chunkCount} do pieces[i]=assert(f:GetAttribute("Chunk_"..i)) end; local s=table.concat(pieces); f:SetAttribute("AssembledBytes",#s); f:SetAttribute("AssembledSha256",digest(s)); return "assembled"`);
      const after = JSON.parse(requireSuccess(await execute(rootCode + digestCode + `local pieces={}; for i=1,${config.chunkCount} do pieces[i]=assert(f:GetAttribute("Chunk_"..i)) end; local s=table.concat(pieces); return {bytes=#s,sha256=digest(s),assembledBytes=f:GetAttribute("AssembledBytes"),assembledSha256=f:GetAttribute("AssembledSha256")}`), 'independent reconstructed chunk readback').returnValue);
      const failure = errorSummary(reconstruction);
      emit({ type: 'chunks', classification: failure ? 'rejected_or_unknown' : 'success',
        sameFolder: `game.Workspace.${marker}`, chunkBytes: config.chunkBytes,
        chunkCount: config.chunkCount, totalBytes, expectedSha256,
        elapsedMs: Math.round(performance.now() - started), failure, after, frames: frameRecords });
      if (failure && config.explore) return;
      requireSuccess(reconstruction, 'same-folder ordered reconstruction');
      assert.equal(after.bytes, totalBytes);
      assert.equal(after.sha256, expectedSha256, 'Reconstructed value is verified by independent SHA256, not an acknowledgement');
      assert.equal(after.assembledBytes, totalBytes);
      assert.equal(after.assembledSha256, expectedSha256);
    } finally {
      try {
        requireSuccess(await controlExecute(rootCode + `for i=1,${chunks.length} do f:SetAttribute("Chunk_"..i,nil) end; return true`), 'remove staged attributes through independent HTTP');
        assert.equal(requireSuccess(await controlExecute(rootCode + `for i=1,${chunks.length} do assert(f:GetAttribute("Chunk_"..i)==nil) end; return true`), 'verify staged attribute cleanup through independent HTTP').returnValue, 'true');
      } catch (error) { cleanupErrors.push(error); }
    }
  }

  async function httpCases() {
    const limitBytes = 50 * MiB;
    for (const kind of ['execute', 'property']) for (const targetBytes of config.httpSizes) {
      await runCase(`HTTP ${kind} ${targetBytes}`, async () => {
        requireSuccess(await execute(rootCode + 'f.Payload.Value="sentinel"; return true'), 'reset HTTP sentinel');
        const before = await readback();
        const requestId = randomUUID();
        const mutation = rootCode + `f:SetAttribute("Mutations",f:GetAttribute("Mutations")+1); f:SetAttribute("LastOperation",${JSON.stringify(requestId)}); return "tiny-http-ok"`;
        const dataFor = filler => kind === 'execute'
          ? { code: `--[=[界é${filler}]=]\n${mutation}` }
          : { instancePath: `game.Workspace.${marker}.Payload`, properties: { Value: `界é${filler}` } };
        const argsFor = data => ({
          instance_id: session.instanceId, operation_id: requestId,
          ...(kind === 'execute' ? { target: 'edit' } : {}), ...data,
        });
        const baseBytes = Buffer.byteLength(JSON.stringify(argsFor(dataFor(''))));
        assert.ok(targetBytes >= baseBytes, 'HTTP body must fit the complete argument envelope');
        const data = dataFor('x'.repeat(targetBytes - baseBytes));
        const serialized = JSON.stringify(argsFor(data));
        assert.equal(Buffer.byteLength(serialized), targetBytes);
        const toolName = kind === 'execute' ? 'execute_luau' : 'set_properties';
        const started = performance.now();
        const response = await fetch(`http://127.0.0.1:${portLease.port}/mcp/${toolName}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-mcp-auth': runtimeEnv.ROBLOX_STUDIO_AUTH_TOKEN },
          body: serialized, signal: AbortSignal.timeout(config.rpcTimeoutMs),
        });
        const body = await response.json();
        const elapsedMs = Math.round(performance.now() - started);
        const endpoint = kind === 'execute' ? '/api/execute-luau' : '/api/set-properties';
        const frames = checkFrames(requestId, endpoint, data);
        const after = await readback();
        const failure = !response.ok || body.success === false || body.error || body.summary?.failed;
        emit({ type: 'http', case: kind, requestId, httpBodyBytes: targetBytes, statusCode: response.status,
          classification: failure ? targetBytes > limitBytes ? 'transport_rejection' : kind === 'property' ? 'engine_rejection' : 'rejected_or_unknown' : 'success',
          failure: failure ? body : undefined, elapsedMs, frames, before, after });
        if (targetBytes > limitBytes) {
          assert.equal(response.status, 413);
          assert.equal(body.code, 'request_too_large');
          assert.deepEqual(body.details, {
            bytes: targetBytes, limitBytes, stage: 'queued',
            outcome: 'not_executed', transportStage: 'http_receive',
          });
          assert.equal(frames.length, 0, 'HTTP rejection did not dispatch a Studio request');
          assert.deepEqual(after, before, 'Independent readback proves HTTP rejection did not execute');
          return;
        }
        assert.equal(response.status, 200, 'Exact-limit HTTP body passes the production parser');
        assert.equal(frames.filter(frame => frame.kind === 'request').length, 1);
        if (kind === 'property' && Buffer.byteLength(data.properties.Value) >= STRING_VALUE_LIMIT_EXCLUSIVE) {
          assertEngineSizeRejection(body, Buffer.byteLength(data.properties.Value));
          assert.deepEqual(after, before, 'Engine rejection is distinct from HTTP admission');
        } else if (failure) {
          if (!config.explore) assert.fail(`HTTP native execution failed: ${JSON.stringify(body)}`);
        } else if (kind === 'execute') {
          assert.equal(body.returnValue, 'tiny-http-ok');
          assert.equal(after.mutations, before.mutations + 1);
          assert.equal(after.lastOperation, requestId);
        } else {
          assert.equal(after.bytes, Buffer.byteLength(data.properties.Value));
          assert.equal(after.sha256, sha256(data.properties.Value));
        }
      });
    }
  }

  async function responseCases() {
    const calibrationId = randomUUID();
    requireSuccess(await execute('return ""', calibrationId), 'response envelope calibration');
    const calibrationFrames = recorder.frames.get(calibrationId).filter(frame => frame.kind === 'response');
    assert.equal(calibrationFrames.length, 1);
    const overhead = calibrationFrames[0].bytes;
    emit({ type: 'response_calibration', requestIdBytes: Buffer.byteLength(calibrationId), responseEnvelopeBytes: overhead });
    const cases = config.responseSizes.map(targetBytes => ({ targetBytes, pattern: 'ascii' }));
    if (!config.smoke && !config.explore && config.responseSizes.includes(FRAME_LIMIT)) {
      // One worst-case legacy MCP projection: each quote is escaped in the
      // native JSON and again in content.text, alongside structuredContent.
      cases.push({ targetBytes: FRAME_LIMIT, pattern: 'quotes' });
    }
    for (const { targetBytes, pattern } of cases) await runCase(`response ${pattern} ${targetBytes}`, async () => {
      const requestId = randomUUID();
      assert.equal(requestId.length, calibrationId.length);
      const encodedPayloadBytes = targetBytes - overhead;
      assert.ok(encodedPayloadBytes >= 0, 'Response size must fit calibrated native envelope');
      const quoteCount = pattern === 'quotes' ? Math.floor(encodedPayloadBytes / 2) : 0;
      const asciiCount = pattern === 'quotes' ? encodedPayloadBytes % 2 : encodedPayloadBytes;
      const resultBytes = quoteCount + asciiCount;
      const returnExpression = pattern === 'quotes'
        ? `string.rep(${JSON.stringify('"')},${quoteCount})..string.rep("x",${asciiCount})`
        : `string.rep("x",${asciiCount})`;
      const before = await readback();
      const code = rootCode + `f:SetAttribute("Mutations",f:GetAttribute("Mutations")+1); f:SetAttribute("LastOperation",${JSON.stringify(requestId)}); return ${returnExpression}`;
      const result = await execute(code, requestId);
      const after = await readback();
      const frames = checkFrames(requestId, '/api/execute-luau', { code });
      const responses = frames.filter(frame => frame.kind === 'response');
      const failure = errorSummary(result);
      // Do not retain or print a 64MiB return value in the summary.
      emit({ type: 'response', requestId, pattern, requestedFrameBytes: targetBytes, resultBytes,
        elapsedMs: result.elapsedMs, classification: failure ? targetBytes > FRAME_LIMIT ? 'response_rejection' : 'rejected_or_unknown' : 'success',
        failure, frames, status: await status(requestId), before, after });
      if (targetBytes > FRAME_LIMIT) {
        assert.equal(result.isError, true, 'Oversized native response produces structured MCP error');
        assert.equal(responses.length, 1, 'Plugin delivers one bounded error frame');
        assert.ok(responses[0].bytes < 4096);
        const wireError = responses[0].error;
        assert.ok(wireError !== undefined, 'Plugin error must be observed on the native wire');
        const diagnostic = typeof wireError === 'string' ? wireError : JSON.stringify(wireError);
        assert.match(diagnostic, /response_encode/u);
        assert.ok(diagnostic.includes(String(targetBytes)), 'Diagnostic reports exact attempted encoded bytes');
        assert.ok(diagnostic.includes(String(FRAME_LIMIT)), 'Diagnostic reports response frame limit');
        assert.notEqual(result.body.outcome, 'not_executed', 'Execution occurred before response rejection');
        assert.equal(result.body.error, 'studio_response_error');
        assert.equal(result.body.stage, 'response_delivery');
        assert.equal(result.body.executionOutcome, 'success');
      } else if (failure) {
        if (!config.explore) requireSuccess(result, `response at ${targetBytes} bytes`);
        return;
      } else {
        assert.equal(responses.length, 1);
        assert.equal(responses[0].bytes, targetBytes, 'Measured native response frame is exactly the selected size');
        assert.equal(Buffer.byteLength(result.body.returnValue), resultBytes);
        assert.equal(result.body.returnValue, '"'.repeat(quoteCount) + 'x'.repeat(asciiCount), 'Full response comparison, including worst-case quote escaping');
      }
      assert.equal(after.mutations, before.mutations + 1);
      assert.equal(after.lastOperation, requestId, 'Tiny readback proves completion despite an undeliverable large result');
    });
  }

  try {
    portLease = await acquireSuitePort({ env: {} });
    recorderLease = await acquireSuitePort({ env: {} });
    await configureStudioDirectoryIsolation({ requireStudioClosed: false });
    worker = createIsolatedStudioDirectory({ prefix: 'payload-boundaries' });
    runtimeEnv = {
      ...process.env, MCP_PLUGINS_DIR: worker.pluginsDirectory,
      RSMCP_STUDIO_WORKING_DIRECTORY: worker.workingDirectory,
      ROBLOX_STUDIO_PORT: String(portLease.port), RSMCP_AUTO_ASSIGNED_PORT: '0',
    };
    const installer = spawn(process.execPath, [DIST, '--install-bundled-plugin', '--plugin-path', path.join(REPO_ROOT, 'studio-plugin', 'MCPPlugin.rbxmx')], {
      env: { ...runtimeEnv, ROBLOX_STUDIO_PORT: String(recorderLease.port) }, stdio: 'inherit',
    });
    const [installCode, installSignal] = await once(installer, 'exit');
    assert.equal(installSignal, null);
    assert.equal(installCode, 0);
    assert.ok(readFileSync(path.join(worker.pluginsDirectory, 'MCPPlugin.rbxmx'), 'utf8').includes(`http://localhost:${recorderLease.port}`), 'Isolated bundled plugin contains the owned recorder server port before launch');
    await recorderLease.handoff();
    recorder = await openStudioFrameRecorder({ port: recorderLease.port, upstreamPort: portLease.port });
    await portLease.handoff();
    managedLaunchAttempted = true;
    session = await openManagedStudioSession({ port: portLease.port, env: runtimeEnv }, {
      createControl(env) {
        assert.equal(env.ROBLOX_STUDIO_REQUIRE_PRIMARY, '1');
        primary = new McpClient('native-payload-primary', { env, startupTimeoutMs: 20000 });
        return primary;
      },
    });
    await primary.initialize();
    assert.equal(primary.isPrimary(), true, 'Large requests must use captured PRIMARY stdio, never a secondary 50MiB HTTP proxy');
    assert.equal(primary.isProxy(), false);
    const connected = requireSuccess(await call('get_connected_instances', {}), 'list native peers');
    const instance = selectEditInstance(connected, session.instanceId);
    assert.ok(instance, 'Managed Studio owns the selected edit instance');
    peerId = instancePeers(instance).find(peer => peer.role === 'edit').peerId;
    const metadata = requireSuccess(await execute(digestCode + 'local ok,p=pcall(function() return game:GetService("UserInputService"):GetPlatform() end); return {NativeBuild=version(),platform=ok and tostring(p) or "Windows",platformSource=ok and "UserInputService.GetPlatform" or "managed Windows/WSL Studio launcher",platformProbeError=not ok and tostring(p) or nil,isStudio=game:GetService("RunService"):IsStudio(),sha256abc=digest("abc")}'), 'native build and SHA256 capability');
    native = JSON.parse(metadata.returnValue);
    assert.equal(native.isStudio, true);
    assert.equal(native.sha256abc, sha256('abc'), 'Native SHA256 binary-to-hex conversion matches the known vector');
    emit({ type: 'environment', ...native, node: process.version, hostPlatform: process.platform,
      hostRelease: os.release(), primary: true, primaryPid: primary.proc.pid,
      instanceId: session.instanceId, peerId, serverPort: portLease.port, recorderPort: recorderLease.port,
      mode: config.explore ? 'exploration_not_acceptance' : config.smoke ? 'smoke' : 'strict_acceptance',
      configuredFrameLimitBytes: FRAME_LIMIT, requestSizes: config.requestSizes, responseSizes: config.responseSizes,
      selectedCases: [...config.only], observer: 'byte-preserving native WebSocket pass-through; large tools use primary stdio' });
    requireSuccess(await execute(`assert(workspace:FindFirstChild(${markerLiteral})==nil); local f=Instance.new("Folder"); f.Name=${markerLiteral}; f:SetAttribute("Mutations",0); f:SetAttribute("LastOperation",""); local v=Instance.new("StringValue"); v.Name="Payload"; v.Value="sentinel"; v.Parent=f; f.Parent=workspace; return true`), 'create uniquely owned fixture');
    fixtureCreated = true;
    if (config.only.has('property')) await runCase('StringValue engine boundaries', propertyEngineCases);
    for (const kind of ['execute', 'property']) if (config.only.has(kind)) {
      for (const bytes of config.requestSizes) await runCase(`${kind} ${bytes}`, () => requestCase(kind, bytes));
    }
    if (config.only.has('chunks')) await runCase('same-folder chunks', chunkCase);
    if (config.only.has('http')) await runCase('production HTTP boundaries', httpCases);
    if (config.only.has('response')) await runCase('native responses', responseCases);
    assert.deepEqual(recorder.errors, [], 'Recorder must not hide transport errors');
  } catch (error) { failures.push(error); }
  finally {
    if (fixtureCreated) {
      try {
        requireSuccess(await controlExecute(`local f=workspace:FindFirstChild(${markerLiteral}); if f then f:Destroy() end; return true`), 'destroy owned fixture through independent HTTP');
        assert.equal(requireSuccess(await controlExecute(`return workspace:FindFirstChild(${markerLiteral})==nil`), 'verify owned fixture removal through independent HTTP').returnValue, 'true');
      } catch (error) { cleanupErrors.push(error); }
    }
    try {
      if (session) { await session.close(); closeConfirmed = true; }
      else closeConfirmed = !managedLaunchAttempted;
    } catch (error) { cleanupErrors.push(error); }
    try { await recorder?.close(); } catch (error) { cleanupErrors.push(error); }
    // openManagedStudioSession closes only its launch ID / exact PID+start-time.
    // Keep the worker on close failure rather than delete files under a live Studio.
    if (closeConfirmed) {
      try { worker?.cleanup(); } catch (error) { cleanupErrors.push(error); }
    }
    try { await recorderLease?.release(); } catch (error) { cleanupErrors.push(error); }
    try { await portLease?.release(); } catch (error) { cleanupErrors.push(error); }
    emit({ type: 'summary', NativeBuild: native?.NativeBuild, platform: native?.platform,
      mode: config.explore ? 'exploration_not_acceptance' : config.smoke ? 'smoke' : 'strict_acceptance',
      succeeded: rows.filter(row => row.classification === 'success').length,
      rejectedOrUnknown: rows.filter(row => row.classification === 'rejected_or_unknown').length,
      engineRejections: rows.filter(row => row.classification === 'engine_rejection').length,
      transportRejections: rows.filter(row => row.classification === 'transport_rejection').length,
      responseRejections: rows.filter(row => row.classification === 'response_rejection').length,
      failures: failures.map(error => error.message), cleanupErrors: cleanupErrors.map(error => error.message),
      managedCloseConfirmed: closeConfirmed,
      ...(!closeConfirmed && worker ? { retainedWorkerDirectory: worker.workingDirectory } : {}) });
  }
  if (failures.length || cleanupErrors.length) throw new AggregateError([...failures, ...cleanupErrors], 'Native payload boundary probe failed; see JSON observations above');
}
