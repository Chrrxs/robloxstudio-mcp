#!/usr/bin/env node
// Run after npm run build -w packages/core on Windows or WSL with PowerShell interop.
// Executes the shipped selector against synthetic HWND/PID entries only: no window
// enumeration, screenshots, or interaction with the user's Studio processes.
import assert from 'node:assert/strict';
import childProcess, { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { WINDOWS_CAPTURE_SCRIPT } from '../packages/core/dist/host-capture.js';
import { BridgeService } from '../packages/core/dist/bridge-service.js';
import { StudioInstanceManager } from '../packages/core/dist/studio-instance-manager.js';
import { RobloxStudioTools } from '../packages/core/dist/tools/index.js';
import { StudioHttpClient } from '../packages/core/dist/tools/studio-client.js';

const powershell = process.platform === 'win32'
  ? process.env.SystemRoot
    ? join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : 'powershell.exe'
  : '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
assert.ok(process.platform === 'win32' || existsSync(powershell), 'This test requires Windows PowerShell or WSL PowerShell interop');

const start = WINDOWS_CAPTURE_SCRIPT.indexOf('function Emit(');
const end = WINDOWS_CAPTURE_SCRIPT.indexOf('if ([McpStudioCapture]::IsIconic');
const enumeration = "$candidates = [McpStudioCapture]::Find('RobloxStudioBeta')";
assert.ok(start > 0 && end > start, 'Expected selector boundaries in the shipped helper');
const selection = WINDOWS_CAPTURE_SCRIPT.slice(start, end);
assert.ok(selection.includes(enumeration), 'Expected native enumeration seam');

function quote(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function selectorScript(candidates, hint = 'Same Place', expectedIdentity) {
  // Keep all production matching/identity/error logic, replacing only OS enumeration.
  const fixture = `$candidates = @((${quote(JSON.stringify(candidates))} | ConvertFrom-Json) | ForEach-Object {
    [pscustomobject]@{ Handle = [IntPtr]$_.windowId; Pid = [uint32]$_.processId; Title = $_.title }
  })`;
  return `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$env:MCP_CAPTURE_TITLE_HINT = ${quote(hint)}
$env:MCP_CAPTURE_EXPECTED_IDENTITY = ${quote(expectedIdentity === undefined ? '' : JSON.stringify(expectedIdentity))}
${selection.replace(enumeration, fixture)}
Emit @{ ok = $true; selectedWindowId = $pick.Handle.ToInt64(); selectedProcessId = [long]$pick.Pid; identity = $identity }
`;
}

function select(candidates, hint = 'Same Place', expectedIdentity) {
  const script = selectorScript(candidates, hint, expectedIdentity);
  const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-NoLogo', '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64')], {
    encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024, windowsHide: true,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.replace(/^\uFEFF/, '').trim());
}

const first = { windowId: 101, processId: 1001, title: 'Same Place - Roblox Studio' };
const second = { windowId: 202, processId: 1002, title: 'Same Place - Roblox Studio' };
const identity = { windowId: second.windowId, processId: second.processId, bundleIdentifier: 'RobloxStudioBeta' };
let assertions = 0;
function rejected(result, reason) {
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.match(result.error, reason);
  assertions++;
}
function selected(result, window) {
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.selectedWindowId, window.windowId);
  assert.equal(result.selectedProcessId, window.processId);
  assert.deepEqual(result.identity, {
    windowId: window.windowId, processId: window.processId, bundleIdentifier: 'RobloxStudioBeta',
  });
  assertions++;
}

// Both client requests see the same ambiguous windows, regardless of enumeration order.
rejected(select([first, second]), /ambiguous/);
rejected(select([second, first]), /ambiguous/);
rejected(select([first, second], ''), /ambiguous/);
rejected(select([]), /no visible/);
rejected(select([first], 'Another Place'), /no visible.*matches/);
selected(select([second]), second);
selected(select([second], ''), second);
selected(select([first, { ...second, title: 'Different Place - Roblox Studio' }]), first);

// Cached/clean grabs stay pinned even when enumeration order changes or another
// same-title window appears. Losing the pinned window must not select a replacement.
selected(select([first, second], 'Same Place', identity), second);
selected(select([second, first], 'Same Place', identity), second);
rejected(select([first], 'Same Place', identity), /identity changed/);
rejected(select([{ ...second, processId: 2002 }], 'Same Place', identity), /identity changed/);
rejected(select([{ ...second, windowId: 303 }], 'Same Place', identity), /identity changed/);
rejected(select([second], 'Same Place', { ...identity, bundleIdentifier: 'another.exe' }), /identity changed/);
rejected(select([{ ...second, title: 'Another Place - Roblox Studio' }], 'Same Place', identity), /identity changed/);

// Titles are data, including quotes, shell metacharacters, and non-ASCII names.
const unusual = { ...second, title: "雪'; $(throw 'injected') - Roblox Studio" };
selected(select([unusual], "雪'; $(throw 'injected')"), unusual);
console.log(`Windows capture selector: ${assertions} cases passed (no windows accessed)`);

// Original failure scenario: concurrent explicit-client captures share a title.
// Run the real bridge/tools/Windows report boundary, with only native enumeration
// and the Studio transport replaced. The selector still runs in real PowerShell.
const platform = Object.getOwnPropertyDescriptor(process, 'platform');
const environment = process.env;
const nativeSpawn = childProcess.spawn;
const studioRequest = StudioHttpClient.prototype.request;
const pendingLaunches = StudioInstanceManager.prototype.pendingLaunches;
let tools;
try {
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  process.env = { ...environment, ROBLOX_STUDIO_HOST_CAPTURE: '1' };
  StudioInstanceManager.prototype.pendingLaunches = async () => [];
  const markers = new Set();
  const bothShown = Promise.withResolvers();
  const requests = [];
  let hostCalls = 0;
  childProcess.spawn = (command, args, options) => {
    assert.ok(command.endsWith('powershell.exe'), `Unexpected process: ${command}`);
    assert.equal(Buffer.from(args.at(-1), 'base64').toString('utf16le'), WINDOWS_CAPTURE_SCRIPT);
    hostCalls++;
    const env = options.env;
    const expected = env.MCP_CAPTURE_EXPECTED_IDENTITY ? JSON.parse(env.MCP_CAPTURE_EXPECTED_IDENTITY) : undefined;
    const script = selectorScript([first, second], env.MCP_CAPTURE_TITLE_HINT, expected);
    return nativeSpawn(powershell, ['-NoProfile', '-NonInteractive', '-NoLogo', '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64')], options);
  };
  syncBuiltinESMExports();
  StudioHttpClient.prototype.request = async (endpoint, data, peerId) => {
    requests.push({ endpoint, action: data?.action, peerId });
    if (endpoint === '/api/capture-studio') return { unavailable: 'synthetic unavailable native frame' };
    if (endpoint === '/api/capture-begin') return { error: 'synthetic capture callback failure' };
    if (endpoint === '/api/capture-markers') {
      if (data.action === 'show') {
        markers.add(peerId);
        if (markers.size === 2) bothShown.resolve();
        await bothShown.promise;
      }
      if (data.action === 'hide' || data.action === 'finish') markers.delete(peerId);
      return { success: true, captureId: peerId, viewportWidth: 100, viewportHeight: 60, markerSize: 12 };
    }
    if (endpoint === '/api/simulate-mouse-input') return { success: true };
    throw new Error(`Unexpected Studio request: ${endpoint}`);
  };
  const bridge = new BridgeService();
  const register = (instanceId, role, multiplayerGroupId) => {
    const peerId = `peer:${instanceId}:${role}`;
    assert.equal(bridge.registerPeer({
      peerId, transportPeerId: peerId, instanceId, role, multiplayerGroupId,
      placeId: 123, placeName: 'Same Place', dataModelName: 'Same Place', isRunning: role !== 'edit',
    }).ok, true);
  };
  register('instance:controller', 'edit');
  bridge.createMultiplayerGroup('group:two', 'instance:controller');
  register('instance:server', 'server', 'group:two');
  register('instance:player1', 'client-1', 'group:two');
  register('instance:player2', 'client-2', 'group:two');
  tools = new RobloxStudioTools(bridge);
  const results = await Promise.all([
    tools.captureScreenshot('instance:player1-client-1', 'png'),
    tools.captureScreenshot('instance:player2-client-2', 'png'),
  ]);
  results.push(await tools.captureScreenshot('instance:player2-client-2', 'png'));
  for (const result of results) {
    assert.equal(result.content.some(item => item.type === 'image'), false, 'Never return another client image');
    assert.match(JSON.parse(result.content.find(item => item.type === 'text').text).error, /capture is ambiguous/);
  }
  assert.equal(hostCalls, 3);
  assert.equal(requests.filter(request => request.action === 'show').length, 3, 'A retry must not use a wrong-client cache');
  assert.equal(requests.filter(request => request.action === 'finish').length, 3);
  assert.equal(markers.size, 0);
  await tools.simulateMouseInput('click', 10, 20, undefined, undefined, undefined, 'instance:player2-client-2');
  assert.equal(requests.at(-1).peerId, 'peer:instance:player2:client-2');
  console.log('Concurrent explicit-client captures and retry: rejected safely; markers restored; input still targets client 2');
} finally {
  if (tools) await tools.managedConnectionAssociations;
  childProcess.spawn = nativeSpawn;
  syncBuiltinESMExports();
  StudioHttpClient.prototype.request = studioRequest;
  StudioInstanceManager.prototype.pendingLaunches = pendingLaunches;
  Object.defineProperty(process, 'platform', platform);
  process.env = environment;
}
