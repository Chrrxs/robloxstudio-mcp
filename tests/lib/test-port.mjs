import { execFileSync } from 'node:child_process';
import { randomInt, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import {
  existsSync,
  mkdirSync,
  lstatSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_TEST_PORT = 58741;

const lockScope = typeof process.getuid === 'function' ? `uid-${process.getuid()}` : 'user';
const PORT_LOCK_DIR = path.join(os.tmpdir(), `robloxstudio-mcp-test-ports-${lockScope}`);
const DYNAMIC_PORT_MIN = 49152;
const DYNAMIC_PORT_MAX_EXCLUSIVE = 65531;
const MAX_ALLOCATION_ATTEMPTS = 100;

export function configuredTestPort(env = process.env) {
  const raw = env.ROBLOX_STUDIO_PORT;
  if (raw === undefined || raw === '') return undefined;
  if (!/^\d+$/.test(raw)) {
    throw new Error(`ROBLOX_STUDIO_PORT must be an integer from 1 to 65535; received ${JSON.stringify(raw)}`);
  }
  const port = Number(raw);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error(`ROBLOX_STUDIO_PORT must be an integer from 1 to 65535; received ${JSON.stringify(raw)}`);
  }
  return port;
}

export function testBasePort(env = process.env) {
  return configuredTestPort(env) ?? DEFAULT_TEST_PORT;
}

function processIsRunning(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

function assertPrivatePath(stats, target, expectedType) {
  const validType = expectedType === 'directory' ? stats.isDirectory() : stats.isFile();
  if (stats.isSymbolicLink() || !validType) {
    throw new Error(`Unsafe test port lock ${expectedType} at ${target}`);
  }
  if (typeof process.getuid === 'function') {
    if (stats.uid !== process.getuid()) {
      throw new Error(`Test port lock path is owned by uid ${stats.uid}, expected ${process.getuid()}: ${target}`);
    }
    if ((stats.mode & 0o077) !== 0) {
      throw new Error(`Test port lock path must not be accessible by group or other users: ${target}`);
    }
  }
}

function ensurePrivateLockDir() {
  mkdirSync(PORT_LOCK_DIR, { recursive: true, mode: 0o700 });
  assertPrivatePath(lstatSync(PORT_LOCK_DIR), PORT_LOCK_DIR, 'directory');
}

function readOwnedLock(lockPath) {
  assertPrivatePath(lstatSync(lockPath), lockPath, 'file');
  return readFileSync(lockPath, 'utf8');
}

function claimPortLock(port) {
  ensurePrivateLockDir();
  const lockPath = path.join(PORT_LOCK_DIR, `${port}.lock`);
  const token = `${process.pid}:${randomUUID()}`;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(lockPath, token, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      return { lockPath, token };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      let ownerPid;
      try {
        ownerPid = Number(readOwnedLock(lockPath).split(':', 1)[0]);
      } catch (lockError) {
        if (lockError?.code === 'ENOENT') continue;
        throw lockError;
      }
      if (processIsRunning(ownerPid)) return undefined;
      rmSync(lockPath, { force: true });
    }
  }

  return undefined;
}

function releasePortLock(lock) {
  if (!lock) return;
  try {
    if (readOwnedLock(lock.lockPath) === lock.token) {
      rmSync(lock.lockPath, { force: true });
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

export function windowsPortIsAvailable(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Cannot check invalid Windows port ${port}`);
  }
  if (process.platform !== 'linux' || !existsSync('/mnt/c/Windows')) return true;
  try {
    const output = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        `if (Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue) { 'LISTENING' }`,
      ],
      {
        cwd: '/mnt/c/Windows',
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    );
    return !output.includes('LISTENING');
  } catch {
    // WSL interop may be disabled in non-Studio CI. The primary-only server
    // guard still fails closed if a WSL-side process wins the port.
    return true;
  }
}

async function reservePort(port, host) {
  const server = net.createServer();
  const listening = once(server, 'listening');
  server.listen(port, host);
  await listening;
  return server;
}

async function closeReservation(server) {
  if (!server?.listening) return;
  const closed = once(server, 'close');
  server.close();
  await closed;
}

export async function acquireSuitePort({
  env = process.env,
  host = '127.0.0.1',
  windowsAvailabilityCheck = windowsPortIsAvailable,
} = {}) {
  const configured = configuredTestPort(env);
  if (configured !== undefined) {
    return {
      port: configured,
      autoAssigned: false,
      handoff: async () => {},
      release: async () => {},
    };
  }

  for (let attempt = 0; attempt < MAX_ALLOCATION_ATTEMPTS; attempt += 1) {
    const port = randomInt(DYNAMIC_PORT_MIN, DYNAMIC_PORT_MAX_EXCLUSIVE);
    if (port === DEFAULT_TEST_PORT) continue;
    const lock = claimPortLock(port);
    if (!lock) continue;
    try {
      if (!(await windowsAvailabilityCheck(port))) {
        releasePortLock(lock);
        continue;
      }
    } catch (error) {
      releasePortLock(lock);
      throw error;
    }

    let reservation;
    try {
      reservation = await reservePort(port, host);
    } catch (error) {
      releasePortLock(lock);
      if (error?.code === 'EADDRINUSE' || error?.code === 'EACCES') continue;
      throw error;
    }

    let server = reservation;
    let released = false;
    return {
      port,
      autoAssigned: true,
      async handoff() {
        if (!server) return;
        const current = server;
        server = undefined;
        await closeReservation(current);
      },
      async release() {
        if (released) return;
        released = true;
        if (server) {
          const current = server;
          server = undefined;
          await closeReservation(current);
        }
        releasePortLock(lock);
      },
    };
  }

  throw new Error(`Could not reserve an isolated test port after ${MAX_ALLOCATION_ATTEMPTS} attempts`);
}
