import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import lockfile from 'proper-lockfile';
import { resolvePluginsDir } from '../../scripts/studio-lifecycle.mjs';
import { randomUUID } from 'node:crypto';

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_POLL_MS = 250;
const DEFAULT_STALE_MS = 2 * 60 * 1000;
const MIN_STALE_MS = 5000;
const LEASE_NAME_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;
const PROTECTED_PLUGIN_ASSETS = new Set([
  'MCPPlugin.rbxmx',
  'MCPInspectorPlugin.rbxmx',
  '000_RSMCP_EditHistoryRepro.rbxmx',
]);
const PLUGIN_BACKUP_DIR = 'plugin-backup.pending';

function configuredTimeout(env) {
  const raw = env.RSMCP_STUDIO_TEST_LEASE_TIMEOUT_MS;
  if (raw === undefined || raw === '') return DEFAULT_TIMEOUT_MS;
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) < 1) {
    throw new Error(`RSMCP_STUDIO_TEST_LEASE_TIMEOUT_MS must be a positive integer; received ${JSON.stringify(raw)}`);
  }
  return Number(raw);
}

export function defaultStudioTestLeaseRoot(env = process.env) {
  const configured = env.RSMCP_STUDIO_TEST_LEASE_DIR;
  if (configured) {
    if (!path.isAbsolute(configured)) {
      throw new Error(`RSMCP_STUDIO_TEST_LEASE_DIR must be absolute; received ${JSON.stringify(configured)}`);
    }
    return path.normalize(configured);
  }
  // WSL and native Windows resolve different path strings here, but both map
  // to the same physical directory beside %LOCALAPPDATA%/Roblox/Plugins.
  return path.join(path.resolve(resolvePluginsDir()), '..', '.robloxstudio-mcp-test-leases');
}

function ensureLeaseTarget(leaseRoot, name) {
  if (!path.isAbsolute(leaseRoot)) {
    throw new Error(`Studio test lease root must be absolute; received ${JSON.stringify(leaseRoot)}`);
  }
  mkdirSync(leaseRoot, { recursive: true });
  const target = path.join(leaseRoot, `${name}.resource`);
  try {
    writeFileSync(target, 'robloxstudio-mcp Studio test resource\n', {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  const stats = lstatSync(target);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(`Unsafe Studio test lease target at ${target}`);
  }
  return target;
}

function restorePluginBackup(leaseRoot, pluginsDir) {
  const backupDir = path.join(leaseRoot, PLUGIN_BACKUP_DIR);
  if (!existsSync(backupDir)) return;
  const manifest = JSON.parse(readFileSync(path.join(backupDir, 'manifest.json'), 'utf8'));
  if (manifest?.version !== 1 || !Array.isArray(manifest.files)) {
    throw new Error(`Invalid interrupted plugin backup manifest at ${backupDir}`);
  }
  mkdirSync(pluginsDir, { recursive: true });
  for (const record of manifest.files) {
    if (!PROTECTED_PLUGIN_ASSETS.has(record?.name) || typeof record.present !== 'boolean') {
      throw new Error(`Unsafe interrupted plugin backup entry at ${backupDir}`);
    }
    const destination = path.join(pluginsDir, record.name);
    if (!record.present) {
      rmSync(destination, { force: true });
      continue;
    }
    if (!/^\d+\.bin$/.test(record.backup)) {
      throw new Error(`Unsafe interrupted plugin backup file at ${backupDir}`);
    }
    const temporary = `${destination}.restore-${process.pid}-${randomUUID()}`;
    copyFileSync(path.join(backupDir, record.backup), temporary);
    rmSync(destination, { force: true });
    renameSync(temporary, destination);
  }
  rmSync(backupDir, { recursive: true, force: true });
}

function beginPluginBackup(leaseRoot, pluginsDir) {
  restorePluginBackup(leaseRoot, pluginsDir);
  mkdirSync(pluginsDir, { recursive: true });
  const temporaryDir = path.join(leaseRoot, `plugin-backup.tmp-${process.pid}-${randomUUID()}`);
  mkdirSync(temporaryDir, { mode: 0o700 });
  const files = [];
  try {
    let index = 0;
    for (const name of PROTECTED_PLUGIN_ASSETS) {
      const source = path.join(pluginsDir, name);
      const present = existsSync(source);
      const record = { name, present };
      if (present) {
        const stats = lstatSync(source);
        if (stats.isSymbolicLink() || !stats.isFile()) {
          throw new Error(`Unsafe protected plugin file at ${source}`);
        }
        record.backup = `${index}.bin`;
        copyFileSync(source, path.join(temporaryDir, record.backup));
      }
      files.push(record);
      index += 1;
    }
    writeFileSync(
      path.join(temporaryDir, 'manifest.json'),
      `${JSON.stringify({ version: 1, files })}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
    renameSync(temporaryDir, path.join(leaseRoot, PLUGIN_BACKUP_DIR));
  } catch (error) {
    rmSync(temporaryDir, { recursive: true, force: true });
    throw error;
  }
}

export async function acquireStudioTestLease({
  name = 'global-studio-and-plugins',
  leaseRoot = defaultStudioTestLeaseRoot(),
  timeoutMs = configuredTimeout(process.env),
  pollMs = DEFAULT_POLL_MS,
  staleMs = DEFAULT_STALE_MS,
  protectPlugins = true,
  pluginsDir = resolvePluginsDir(),
} = {}) {
  if (!LEASE_NAME_PATTERN.test(name)) {
    throw new Error(`Invalid Studio test lease name ${JSON.stringify(name)}`);
  }
  for (const [label, value] of [
    ['timeout', timeoutMs],
    ['poll interval', pollMs],
    ['stale interval', staleMs],
  ]) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`Invalid Studio test lease ${label} ${value}`);
    }
  }
  if (staleMs < MIN_STALE_MS) {
    throw new Error(`Studio test lease stale interval must be at least ${MIN_STALE_MS}ms`);
  }

  const target = ensureLeaseTarget(leaseRoot, name);
  const deadline = Date.now() + timeoutMs;
  const updateMs = Math.max(1000, Math.min(5000, Math.floor(staleMs / 2)));
  let waited = false;
  let releaseLock;

  while (!releaseLock) {
    try {
      releaseLock = await lockfile.lock(target, {
        realpath: false,
        stale: staleMs,
        update: updateMs,
        retries: 0,
      });
    } catch (error) {
      if (error?.code !== 'ELOCKED') throw error;
      waited = true;
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        throw new Error(
          `Timed out waiting ${timeoutMs}ms for the shared Studio test lease`,
          { cause: error },
        );
      }
      await delay(Math.min(pollMs, remainingMs));
    }
  }

  if (protectPlugins) {
    try {
      beginPluginBackup(leaseRoot, path.resolve(pluginsDir));
    } catch (error) {
      await releaseLock();
      throw error;
    }
  }

  let released = false;
  return {
    waited,
    async release() {
      if (released) return;
      let restoreError;
      let releaseError;
      try {
        if (protectPlugins) restorePluginBackup(leaseRoot, path.resolve(pluginsDir));
      } catch (error) {
        restoreError = error;
      }
      try {
        await releaseLock();
        released = true;
      } catch (error) {
        releaseError = error;
      }
      if (restoreError && releaseError) {
        throw new AggregateError(
          [restoreError, releaseError],
          `Plugin backup could not be restored and the Studio test lease could not be released`,
        );
      }
      if (restoreError) throw restoreError;
      if (releaseError) throw releaseError;
    },
  };
}
