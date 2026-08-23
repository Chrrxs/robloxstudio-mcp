// Shared utility for integration tests under tests/.
//
// Spawns the built MCP server (packages/robloxstudio-mcp/dist/index.js) as a
// subprocess and drives it via stdio JSON-RPC. Every subprocess in one suite
// shares BASE_PORT: the first is primary and later subprocesses proxy through
// it. Self-contained suite wrappers assign distinct ports so concurrent
// worktrees cannot proxy into one another.
//
// Each test file is responsible for its own playtest start/stop lifecycle.
// Tests should leave the Studio state clean (no orphan playtests, no
// orphan instances under Workspace/ServerStorage).

import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { testBasePort } from './test-port.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(__dirname, '..', '..');
export const DIST = resolve(REPO_ROOT, 'packages/robloxstudio-mcp/dist/index.js');
export const BASE_PORT = testBasePort();

const ROUTED_TOOLS = new Set([
  'solo_playtest',
  'execute_luau',
  'eval_server_runtime',
  'eval_client_runtime',
  'get_simulation_state',
  'reset_simulation_state',
  'set_network_profile',
  'get_device_simulator_state',
  'set_device_simulator',
  'capture_device_matrix',
  'get_runtime_logs',
  'get_memory_breakdown',
  'multiplayer_playtest',
  'capture_screenshot',
  'capture_micro_profiler',
  'generate_model',
  'simulate_mouse_input',
  'simulate_keyboard_input',
]);

let confirmedAutoAssignedPrimary;

function hasLiveConfirmedPrimary() {
  const client = confirmedAutoAssignedPrimary;
  return client?.proc
    && client.exitCode === null
    && !client.proc.killed
    && client.proc.signalCode === null;
}

export class McpClient {
  constructor(label = 'client', options = {}) {
    this.label = label;
    this.command = options.command ?? 'node';
    this.args = options.args ?? [DIST];
    this.env = options.env;
    this.cwd = options.cwd ?? REPO_ROOT;
    this.startupTimeoutMs = options.startupTimeoutMs ?? 5000;
    this.proc = null;
    this.nextId = 1;
    this.pending = new Map();
    this.stderrLines = [];
    this.stdoutBuf = '';
    this.stderrBuf = '';
    this.exitCode = null;
  }

  async start() {
    const childEnv = { ...process.env, ...this.env };
    const autoAssignedPort = childEnv.RSMCP_AUTO_ASSIGNED_PORT === '1';
    const mustEstablishPrimary = autoAssignedPort && !hasLiveConfirmedPrimary();
    const explicitClientRequirement = Object.prototype.hasOwnProperty.call(
      this.env ?? {},
      'ROBLOX_STUDIO_REQUIRE_PRIMARY',
    );
    if (mustEstablishPrimary) {
      childEnv.ROBLOX_STUDIO_REQUIRE_PRIMARY = '1';
    } else if (autoAssignedPort && !explicitClientRequirement) {
      delete childEnv.ROBLOX_STUDIO_REQUIRE_PRIMARY;
    }

    this.proc = spawn(this.command, this.args, {
      cwd: this.cwd,
      env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc.stdout.setEncoding('utf8');
    this.proc.stderr.setEncoding('utf8');

    this.proc.stdout.on('data', (chunk) => {
      this.stdoutBuf += chunk;
      let nl;
      while ((nl = this.stdoutBuf.indexOf('\n')) !== -1) {
        const line = this.stdoutBuf.slice(0, nl).trim();
        this.stdoutBuf = this.stdoutBuf.slice(nl + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id != null && this.pending.has(msg.id)) {
            const { resolve: r, reject, timeoutId } = this.pending.get(msg.id);
            this.pending.delete(msg.id);
            clearTimeout(timeoutId);
            if (msg.error) reject(new Error(JSON.stringify(msg.error)));
            else r(msg.result);
          }
        } catch {
          // Not a JSON-RPC line — ignore (could be MCP framing noise)
        }
      }
    });

    this.proc.stderr.on('data', (chunk) => {
      this.stderrBuf += chunk;
      let nl;
      while ((nl = this.stderrBuf.indexOf('\n')) !== -1) {
        const line = this.stderrBuf.slice(0, nl).trim();
        this.stderrBuf = this.stderrBuf.slice(nl + 1);
        if (line) this.stderrLines.push(line);
      }
    });

    this.proc.on('exit', (code) => {
      this.exitCode = code;
      for (const [id, pending] of this.pending.entries()) {
        clearTimeout(pending.timeoutId);
        pending.reject(new Error(`McpClient ${this.label}: subprocess exited before RPC ${id} completed`));
      }
      this.pending.clear();
      if (confirmedAutoAssignedPrimary === this) {
        confirmedAutoAssignedPrimary = undefined;
      }
    });

    // Wait for the subprocess to print its "running on stdio" banner so we
    // know stdio MCP is ready. Bound at 5s — fresh launches usually settle
    // in <1s but cold-start can stretch.
    await this._waitForLog('running on stdio', this.startupTimeoutMs);
    if (mustEstablishPrimary) {
      if (!this.isPrimary()) {
        await this.stop();
        throw new Error(`McpClient ${this.label}: auto-assigned port did not start in primary mode`);
      }
      confirmedAutoAssignedPrimary = this;
    }
  }

  async _waitForLog(substr, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.stderrLines.some((l) => l.includes(substr))) return;
      await delay(50);
    }
    throw new Error(`McpClient ${this.label}: never logged "${substr}" within ${timeoutMs}ms. Tail:\n${this.stderrLines.slice(-10).join('\n')}`);
  }

  isPrimary() { return this.stderrLines.some((l) => l.includes('(primary mode)')); }
  isProxy() { return this.stderrLines.some((l) => l.includes('proxy mode')); }

  recentStderr(n = 10) { return this.stderrLines.slice(-n).join('\n'); }

  async rpc(method, params, timeoutMs = 30_000) {
    const id = this.nextId++;
    const p = new Promise((res, rej) => {
      const timeoutId = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          rej(new Error(`RPC ${method} timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);
      this.pending.set(id, { resolve: res, reject: rej, timeoutId });
    });
    this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    return p;
  }

  notify(method, params) {
    this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  async initialize() {
    await this.rpc('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'tests-harness', version: '0.0.0' },
    });
    this.notify('notifications/initialized', {});
  }

  /** tools/call wrapper. Returns the parsed first text-content body (the
      common shape used by the Roblox Studio MCP). Throws if no text content. */
  async callTool(name, args = {}, timeoutMs = 30_000) {
    const routedArgs = { ...args };
    if (process.env.MCP_INSTANCE_ID && ROUTED_TOOLS.has(name) && routedArgs.instance_id === undefined) {
      routedArgs.instance_id = process.env.MCP_INSTANCE_ID;
    }
    const res = await this.rpc('tools/call', { name, arguments: routedArgs }, timeoutMs);
    const text = res?.content?.[0]?.text;
    if (text == null) {
      throw new Error(`Tool ${name} returned no text content: ${JSON.stringify(res)}`);
    }
    if (res?.isError) {
      throw new Error(`Tool ${name} returned isError: ${text}`);
    }
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  async stop() {
    if (confirmedAutoAssignedPrimary === this) {
      confirmedAutoAssignedPrimary = undefined;
    }
    if (this.proc && !this.proc.killed) {
      for (const [id, pending] of this.pending.entries()) {
        clearTimeout(pending.timeoutId);
        pending.reject(new Error(`McpClient ${this.label}: stopped before RPC ${id} completed`));
      }
      this.pending.clear();
      this.proc.kill('SIGTERM');
      await delay(200);
      if (!this.proc.killed) this.proc.kill('SIGKILL');
    }
  }
}

// Minimal assertion helpers — keep the test files focused on what they're
// asserting, not on logging shape.
export function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAIL: ${msg}`);
  console.log(`  ✓ ${msg}`);
}

export function assertContains(haystack, needle, msg) {
  if (typeof haystack !== 'string' || !haystack.includes(needle)) {
    throw new Error(`ASSERT FAIL: ${msg}\n    expected substring: ${JSON.stringify(needle)}\n    in: ${JSON.stringify(haystack)}`);
  }
  console.log(`  ✓ ${msg}`);
}

export function assertNotContains(haystack, needle, msg) {
  if (typeof haystack !== 'string') {
    throw new Error(`ASSERT FAIL: ${msg}\n    expected string, got: ${typeof haystack}`);
  }
  if (haystack.includes(needle)) {
    throw new Error(`ASSERT FAIL: ${msg}\n    unexpected substring: ${JSON.stringify(needle)}\n    in: ${JSON.stringify(haystack)}`);
  }
  console.log(`  ✓ ${msg}`);
}

export function selectEditInstance(connected, expectedInstanceId = process.env.MCP_INSTANCE_ID) {
  const instances = connected?.instances ?? connected;
  if (!Array.isArray(instances)) return undefined;
  return instances.find((instance) => {
    const id = instance?.id ?? instance?.instanceId;
    const roles = Array.isArray(instance?.roles)
      ? instance.roles
      : (instance?.role ? [instance.role] : []);
    return roles.includes('edit') && (!expectedInstanceId || id === expectedInstanceId);
  });
}

async function getInstanceList(client) {
  try {
    const inst = await client.callTool('get_connected_instances', {});
    const list = inst.instances ?? inst;
    if (!Array.isArray(list)) return [];
    const peers = list.flatMap((place) => Array.isArray(place.roles)
      ? place.roles.map((role) => ({ instanceId: place.id, role }))
      : [{ instanceId: place.instanceId ?? place.id, role: place.role }]);
    return process.env.MCP_INSTANCE_ID
      ? peers.filter((peer) => peer.instanceId === process.env.MCP_INSTANCE_ID)
      : peers;
  } catch {
    return [];
  }
}

export async function waitForEditPeer(client, { timeoutMs = 60_000, pollMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const list = await getInstanceList(client);
    if (list.some((i) => i.role === 'edit')) return;
    await delay(pollMs);
  }
  throw new Error('waitForEditPeer: edit peer did not register within timeout');
}

// Convenience for tests that need a live playtest. Waits for any stale
// server peer from a prior test to drain, starts a fresh playtest, then
// polls until a *new* server peer registers (the play-server DM has spun
// up and listener buffers are ready). Fixed delays were flaky
// after a prior test's solo_playtest stop left Studio mid-teardown.
export async function startPlaytestAndWait(client, { timeoutSec = 30, pollMs = 500 } = {}) {
  await waitForEditPeer(client, { timeoutMs: timeoutSec * 1000, pollMs });

  // 1. Drain stale server peers (previous test's playtest may still be
  //    tearing down — its server peer can linger for several seconds after
  //    solo_playtest action=stop returns).
  const drainDeadline = Date.now() + 15_000;
  while (Date.now() < drainDeadline) {
    const list = await getInstanceList(client);
    if (!list.some((i) => i.role === 'server')) break;
    await delay(pollMs);
  }
  const staleIds = new Set(
    (await getInstanceList(client)).filter((i) => i.role === 'server').map((i) => i.instanceId),
  );

  // 2. Kick off the playtest.
  const res = await client.callTool('solo_playtest', { action: 'start', mode: 'play' });
  if (!res.success) throw new Error(`solo_playtest start failed: ${JSON.stringify(res)}`);

  // 3. Poll for a fresh (non-stale) server peer to register.
  const deadline = Date.now() + timeoutSec * 1000;
  while (Date.now() < deadline) {
    await delay(pollMs);
    const list = await getInstanceList(client);
    const freshServer = list.find((i) => i.role === 'server' && !staleIds.has(i.instanceId));
    if (freshServer) {
      // Server peer is registered; give bridges a moment to finish wiring.
      await delay(1000);
      return;
    }
  }
  throw new Error(`startPlaytestAndWait: fresh server peer did not register within ${timeoutSec}s`);
}

export async function safeStopPlaytest(client) {
  try {
    await client.callTool('solo_playtest', { action: 'stop' });
  } catch (err) {
    console.warn(`  (solo_playtest cleanup error, ignored): ${err.message}`);
  }
}

// Lightweight test wrapper — runs main(), prints PASS/FAIL banner, always
// cleans up clients.
export async function runTest(name, main) {
  const clients = [];
  console.log(`\n=== ${name} ===`);
  try {
    await main({ track: (c) => { clients.push(c); return c; } });
    console.log(`\n✅ ${name} PASSED`);
    return true;
  } catch (err) {
    console.error(`\n❌ ${name} FAILED: ${err.message}`);
    for (const c of clients) {
      console.error(`\n--- ${c.label} stderr tail ---`);
      console.error(c.recentStderr(10));
    }
    process.exitCode = 1;
    return false;
  } finally {
    for (const c of clients) await c.stop();
  }
}
