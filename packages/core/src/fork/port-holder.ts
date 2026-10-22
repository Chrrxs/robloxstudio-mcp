// Bridge-port ownership check. Upstream falls back to proxy mode whenever the
// bridge port is taken; that only works when the holder is a live
// robloxstudio-mcp. Anything else (a stale or foreign process) used to hang or
// fail cryptically, so fail fast with one line naming the holder's pid.
import { execFile } from 'node:child_process';
import { readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export class BridgeBusyError extends Error {
  override name = 'BridgeBusyError';
}

export interface BridgeHolderProbe {
  ours: boolean;
  pid?: number;
  version?: string;
  reason?: string;
}

function urlHost(host: string): string {
  if (host === '0.0.0.0' || host === '::' || host === '') return '127.0.0.1';
  return host.includes(':') ? `[${host}]` : host;
}

/** Asks the port holder's /health whether it is a robloxstudio-mcp primary. */
export async function probeBridgeHolder(host: string, port: number, timeoutMs = 1500): Promise<BridgeHolderProbe> {
  let response: Response;
  try {
    response = await fetch(`http://${urlHost(host)}:${port}/health`, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    // Timeouts reject with a DOMException, which need not be an Error instance in every realm.
    const errorName = (error as { name?: unknown } | null)?.name;
    const timedOut = errorName === 'TimeoutError' || errorName === 'AbortError';
    return { ours: false, reason: timedOut ? `no /health answer within ${timeoutMs} ms` : 'not an HTTP server' };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ours: false, reason: `/health returned HTTP ${response.status}, not robloxstudio-mcp` };
  }
  const health = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  if (!response.ok || health.service !== 'robloxstudio-mcp') {
    return { ours: false, reason: `/health returned HTTP ${response.status}, not robloxstudio-mcp` };
  }
  return {
    ours: true,
    pid: typeof health.pid === 'number' ? health.pid : undefined,
    version: typeof health.version === 'string' ? health.version : undefined,
  };
}

function linuxListenerPid(port: number): number | undefined {
  const portHex = port.toString(16).toUpperCase().padStart(4, '0');
  const inodes = new Set<string>();
  for (const table of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let text: string;
    try {
      text = readFileSync(table, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n').slice(1)) {
      const cols = line.trim().split(/\s+/);
      // cols[1] = local address:port, cols[3] = state (0A = LISTEN), cols[9] = inode
      if (cols.length > 9 && cols[3] === '0A' && cols[1].endsWith(`:${portHex}`)) inodes.add(cols[9]);
    }
  }
  if (inodes.size === 0) return undefined;
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    let fds: string[];
    try {
      fds = readdirSync(`/proc/${entry}/fd`);
    } catch {
      continue; // another user's process
    }
    for (const fd of fds) {
      try {
        const match = /^socket:\[(\d+)\]$/.exec(readlinkSync(`/proc/${entry}/fd/${fd}`));
        if (match && inodes.has(match[1])) return Number(entry);
      } catch {
        // fd closed while scanning
      }
    }
  }
  return undefined;
}

/** Best-effort OS lookup of the process listening on a TCP port. */
export async function findListenerPid(port: number): Promise<number | undefined> {
  try {
    if (process.platform === 'linux') return linuxListenerPid(port);
    if (process.platform === 'darwin') {
      const { stdout } = await execFileAsync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { timeout: 3000 });
      const pid = Number(stdout.trim().split('\n')[0]);
      return Number.isInteger(pid) && pid > 0 ? pid : undefined;
    }
    if (process.platform === 'win32') {
      const { stdout } = await execFileAsync('netstat', ['-ano', '-p', 'TCP'], { timeout: 3000 });
      for (const line of stdout.split(/\r?\n/)) {
        const cols = line.trim().split(/\s+/);
        if (cols.length >= 5 && cols[3] === 'LISTENING' && cols[1].endsWith(`:${port}`)) return Number(cols[4]);
      }
    }
  } catch {
    // lookup tools missing or denied
  }
  return undefined;
}

/**
 * Returns when the port holder is a live robloxstudio-mcp that this process can
 * proxy to; throws BridgeBusyError with one human-readable line otherwise.
 */
export async function assertBridgeHolderUsable(host: string, port: number, ownVersion?: string): Promise<void> {
  const probe = await probeBridgeHolder(host, port);
  if (probe.ours) {
    if (ownVersion && probe.version && probe.version !== ownVersion) {
      console.error(`Bridge port ${port} is held by robloxstudio-mcp v${probe.version} (this is v${ownVersion}); proxying anyway.`);
    }
    return;
  }
  const pid = await findListenerPid(port);
  throw new BridgeBusyError(`Studio bridge busy, held by pid ${pid ?? 'unknown'} (port ${port}: ${probe.reason}).`);
}
