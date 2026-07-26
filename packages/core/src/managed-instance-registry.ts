import * as fs from 'fs/promises';
import { randomUUID } from 'crypto';
import * as os from 'os';
import * as path from 'path';

const REGISTRY_VERSION = 1;
const LOCK_STALE_MS = 10000;
const LOCK_RETRY_MS = 25;
const LOCK_TIMEOUT_MS = 15000;
const EVENT_RETENTION_DAYS = 2;
const TERMINAL_RECORD_RETENTION_MS = 24 * 60 * 60 * 1000;
const DEFAULT_CONFIRMED_EXIT_MISSES = 2;
const DEFAULT_CONFIRMED_EXIT_GRACE_MS = 5000;
const activeLockTokens = new Set<string>();
const activeLockPaths = new Set<string>();

export type ManagedInstanceLifecycleState = 'launching' | 'connected' | 'exited' | 'failed';

export interface ManagedInstanceRegistryRecord {
  version: 1;
  recordId: string;
  instanceId?: string;
  source: string;
  nativeProcessId?: number;
  nativeProcessStartedAt?: string;
  spawnPid?: number;
  exe: string;
  args: string[];
  placeId?: number;
  universeId?: number;
  placeVersion?: number;
  localPlaceFile?: string;
  deleteLocalPlaceFileOnClose?: boolean;
  launchedAt: number;
  attachedAt?: number;
  connectionDeadlineAt?: number;
  state?: ManagedInstanceLifecycleState;
  failedAt?: number;
  exitedAt?: number;
  exitCode?: number;
  failureReason?: string;
  closedAt?: number;
  ownerPid?: number;
  bootId: string;
  processObservationStatus?: 'running' | 'not_running' | 'unknown';
  processAuthorizationState?: 'pending' | 'authorized' | 'released';
  lastProcessObservationAt?: number;
  lastSuccessfulProcessObservationAt?: number;
  lastProcessObservationError?: string;
  consecutiveConfirmedMisses?: number;
  firstConfirmedMissAt?: number;
}

export type ManagedProcessObservation =
  | { status: 'running'; observedAt: number }
  | { status: 'not_running'; observedAt: number; reason: 'missing' | 'identity_mismatch' }
  | { status: 'unknown'; observedAt: number; error: string };

export interface RegistrySweepOptions {
  currentBootId: string;
  now?: number;
  observeProcess?: (record: ManagedInstanceRegistryRecord) => ManagedProcessObservation | Promise<ManagedProcessObservation>;
  cleanupRecord?: (record: ManagedInstanceRegistryRecord) => void | Promise<void>;
  confirmedExitMisses?: number;
  confirmedExitGraceMs?: number;
}

export interface RegistryEvent {
  event: string;
  recordId?: string;
  instanceId?: string;
  source?: string;
  reason?: string;
  action?: string;
}

interface RegistryLockOwner {
  pid: number;
  token: string;
  createdAt: number;
}

export function defaultManagedInstanceRegistryDir(): string {
  if (process.env.ROBLOXSTUDIO_MCP_MANAGED_INSTANCE_REGISTRY_DIR) {
    return process.env.ROBLOXSTUDIO_MCP_MANAGED_INSTANCE_REGISTRY_DIR;
  }

  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    return path.join(process.env.LOCALAPPDATA, 'robloxstudio-mcp', 'managed-instances', 'v1');
  }

  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'robloxstudio-mcp', 'managed-instances', 'v1');
  }

  return path.join(os.homedir(), '.local', 'state', 'robloxstudio-mcp', 'managed-instances', 'v1');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ymd(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function eventLogDate(name: string): string | undefined {
  const match = name.match(/^events-(\d{4}-\d{2}-\d{2})\.jsonl$/);
  return match?.[1];
}

function isRecord(value: unknown): value is ManagedInstanceRegistryRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<ManagedInstanceRegistryRecord>;
  return record.version === REGISTRY_VERSION &&
    typeof record.recordId === 'string' &&
    typeof record.source === 'string' &&
    typeof record.exe === 'string' &&
    Array.isArray(record.args) &&
    typeof record.launchedAt === 'number' &&
    typeof record.bootId === 'string';
}

function isLockOwner(value: unknown): value is RegistryLockOwner {
  if (!value || typeof value !== 'object') return false;
  const owner = value as Partial<RegistryLockOwner>;
  return Number.isInteger(owner.pid) &&
    (owner.pid as number) > 0 &&
    typeof owner.token === 'string' &&
    owner.token.length > 0 &&
    typeof owner.createdAt === 'number';
}

function isProcessAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export class ManagedInstanceRegistry {
  readonly dir: string;

  constructor(dir = defaultManagedInstanceRegistryDir()) {
    this.dir = dir;
  }

  async upsert(record: ManagedInstanceRegistryRecord): Promise<void> {
    await this.withLock(() => this.writeRecordUnlocked(record));
  }

  async attachInstanceId(recordId: string, instanceId: string): Promise<void> {
    await this.withLock(async () => {
      const record = await this.readRecordUnlocked(recordId);
      if (!record) return;
      record.instanceId = instanceId;
      record.attachedAt = Date.now();
      await this.writeRecordUnlocked(record);
    });
  }

  async findOpenByInstanceId(instanceId: string, options: RegistrySweepOptions): Promise<ManagedInstanceRegistryRecord | undefined> {
    return this.withLock(async () => {
      await this.sweepUnlocked(options);
      return (await this.readOpenRecordsUnlocked()).find((record) => record.instanceId === instanceId);
    });
  }

  async findAnyByInstanceId(instanceId: string): Promise<ManagedInstanceRegistryRecord | undefined> {
    return this.withLock(async () =>
      (await this.readRecordsUnlocked()).find((record) => record.instanceId === instanceId),
    );
  }

  async findAnyByRecordId(recordId: string, options?: RegistrySweepOptions): Promise<ManagedInstanceRegistryRecord | undefined> {
    return this.withLock(async () => {
      if (options) await this.sweepUnlocked(options);
      return (await this.readRecordsUnlocked()).find((record) => record.recordId === recordId);
    });
  }

  async listOpen(options: RegistrySweepOptions): Promise<ManagedInstanceRegistryRecord[]> {
    return this.withLock(async () => {
      await this.sweepUnlocked(options);
      return this.readOpenRecordsUnlocked();
    });
  }

  async listOpenUnchecked(): Promise<ManagedInstanceRegistryRecord[]> {
    return this.withLock(() => this.readOpenRecordsUnlocked());
  }

  async markClosed(recordId: string, closedAt = Date.now()): Promise<void> {
    await this.withLock(async () => {
      const record = await this.readRecordUnlocked(recordId);
      if (!record) return;
      record.closedAt = closedAt;
      await this.writeRecordUnlocked(record);
    });
  }

  async delete(recordId: string): Promise<void> {
    await this.withLock(() => this.deleteRecordUnlocked(recordId));
  }

  async sweep(options: RegistrySweepOptions): Promise<void> {
    await this.withLock(() => this.sweepUnlocked(options));
  }

  async logEvent(event: RegistryEvent, now = Date.now()): Promise<void> {
    await this.withLock(() => this.appendEventUnlocked(event, now));
  }

  private async withLock<T>(fn: () => T | Promise<T>): Promise<T> {
    await this.ensureDir();
    const lockDir = path.join(this.dir, '.lock');
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    const owner: RegistryLockOwner = {
      pid: process.pid,
      token: randomUUID(),
      createdAt: Date.now(),
    };

    for (;;) {
      try {
        await fs.mkdir(lockDir);
        activeLockTokens.add(owner.token);
        activeLockPaths.add(lockDir);
        try {
          await fs.writeFile(path.join(lockDir, 'owner.json'), `${JSON.stringify(owner)}\n`, {
            encoding: 'utf8',
            flag: 'wx',
          });
        } catch (error) {
          activeLockTokens.delete(owner.token);
          activeLockPaths.delete(lockDir);
          await fs.rm(lockDir, { recursive: true, force: true });
          throw error;
        }
        break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'EEXIST') throw error;

        try {
          const stat = await fs.stat(lockDir);
          const currentOwner = await this.readLockOwner(lockDir, stat.isDirectory());
          const ownerIsActive = currentOwner?.pid === process.pid
            ? activeLockTokens.has(currentOwner.token)
            : currentOwner
              ? isProcessAlive(currentOwner.pid)
              : undefined;
          if (ownerIsActive === false || (
            currentOwner === undefined &&
            !activeLockPaths.has(lockDir) &&
            Date.now() - stat.mtimeMs > LOCK_STALE_MS
          )) {
            await fs.rm(lockDir, { recursive: true, force: true });
            continue;
          }
        } catch {
          continue;
        }

        if (Date.now() > deadline) {
          throw new Error(`Timed out waiting for managed instance registry lock: ${lockDir}`);
        }
        await delay(LOCK_RETRY_MS);
      }
    }

    try {
      return await fn();
    } finally {
      try {
        const stat = await fs.stat(lockDir);
        const currentOwner = await this.readLockOwner(lockDir, stat.isDirectory());
        if (currentOwner?.pid === owner.pid && currentOwner.token === owner.token) {
          await fs.rm(lockDir, { recursive: true, force: true });
        }
      } catch {
        // The lock was already reclaimed or removed.
      } finally {
        activeLockTokens.delete(owner.token);
        activeLockPaths.delete(lockDir);
      }
    }
  }

  private async readLockOwner(lockPath: string, isDirectory: boolean): Promise<RegistryLockOwner | undefined> {
    try {
      const contents = await fs.readFile(
        isDirectory ? path.join(lockPath, 'owner.json') : lockPath,
        'utf8',
      );
      const parsed = JSON.parse(contents);
      return isLockOwner(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  private async ensureDir() {
    await fs.mkdir(this.dir, { recursive: true });
  }

  private recordPath(recordId: string): string {
    return path.join(this.dir, `${recordId}.json`);
  }

  private async recordFilesUnlocked(): Promise<string[]> {
    return (await fs.readdir(this.dir))
      .filter((name) => name.endsWith('.json'))
      .map((name) => path.join(this.dir, name));
  }

  private async readRecordUnlocked(recordId: string): Promise<ManagedInstanceRegistryRecord | undefined> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.recordPath(recordId), 'utf8'));
      return isRecord(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  private async readOpenRecordsUnlocked(): Promise<ManagedInstanceRegistryRecord[]> {
    return (await this.readRecordsUnlocked()).filter((record) => record.closedAt === undefined);
  }

  private async readRecordsUnlocked(): Promise<ManagedInstanceRegistryRecord[]> {
    const records: ManagedInstanceRegistryRecord[] = [];
    for (const file of await this.recordFilesUnlocked()) {
      try {
        const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
        if (!isRecord(parsed)) continue;
        records.push(parsed);
      } catch {
        // Malformed records are removed by sweep; reads stay tolerant.
      }
    }
    return records;
  }

  private async writeRecordUnlocked(record: ManagedInstanceRegistryRecord): Promise<void> {
    await this.ensureDir();
    const finalPath = this.recordPath(record.recordId);
    const tmpPath = path.join(this.dir, `${record.recordId}.${process.pid}.${Date.now()}.tmp`);
    const fd = await fs.open(tmpPath, 'w');
    try {
      await fd.writeFile(`${JSON.stringify(record, null, 2)}\n`, 'utf8');
      await fd.sync();
    } finally {
      await fd.close();
    }
    await fs.rename(tmpPath, finalPath);
  }

  private async deleteRecordUnlocked(recordId: string): Promise<void> {
    await fs.rm(this.recordPath(recordId), { force: true });
  }

  private async appendEventUnlocked(event: RegistryEvent, now: number): Promise<void> {
    const file = path.join(this.dir, `events-${ymd(now)}.jsonl`);
    await fs.appendFile(file, `${JSON.stringify({
      ts: new Date(now).toISOString(),
      ...event,
    })}\n`, 'utf8');
  }

  private async cleanupOldEventLogsUnlocked(now: number): Promise<void> {
    const cutoff = ymd(now - EVENT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    for (const name of await fs.readdir(this.dir)) {
      const date = eventLogDate(name);
      if (!date || date >= cutoff) continue;
      try {
        await fs.rm(path.join(this.dir, name), { force: true });
      } catch {
        // Event cleanup is best-effort diagnostics hygiene.
      }
    }
  }

  private async cleanupRecord(options: RegistrySweepOptions, record: ManagedInstanceRegistryRecord) {
    try {
      await options.cleanupRecord?.(record);
    } catch {
      await this.appendEventUnlocked({
        event: 'registry_cleanup_failed',
        recordId: record.recordId,
        instanceId: record.instanceId,
        source: record.source,
        reason: 'cleanup_record_error',
      }, options.now ?? Date.now());
    }
  }

  private async sweepUnlocked(options: RegistrySweepOptions): Promise<void> {
    const now = options.now ?? Date.now();
    await this.cleanupOldEventLogsUnlocked(now);

    for (const file of await this.recordFilesUnlocked()) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(await fs.readFile(file, 'utf8'));
      } catch {
        await fs.rm(file, { force: true });
        await this.appendEventUnlocked({
          event: 'registry_pruned_malformed_record',
          reason: 'parse_error',
          action: 'deleted_record',
        }, now);
        continue;
      }

      if (!parsed || typeof parsed !== 'object') {
        await fs.rm(file, { force: true });
        await this.appendEventUnlocked({
          event: 'registry_pruned_malformed_record',
          reason: 'invalid_shape',
          action: 'deleted_record',
        }, now);
        continue;
      }

      const version = (parsed as { version?: unknown }).version;
      if (typeof version === 'number' && version > REGISTRY_VERSION) continue;

      if (!isRecord(parsed)) {
        await fs.rm(file, { force: true });
        await this.appendEventUnlocked({
          event: 'registry_pruned_malformed_record',
          reason: 'invalid_shape',
          action: 'deleted_record',
        }, now);
        continue;
      }

      const terminalAt = parsed.closedAt ?? parsed.exitedAt;
      if (terminalAt !== undefined) {
        if (now - terminalAt > TERMINAL_RECORD_RETENTION_MS) {
          await fs.rm(file, { force: true });
          await this.appendEventUnlocked({
            event: 'registry_pruned_terminal_record',
            recordId: parsed.recordId,
            instanceId: parsed.instanceId,
            source: parsed.source,
            reason: 'terminal_retention_expired',
            action: 'deleted_record',
          }, now);
        }
        continue;
      }

      if (parsed.bootId !== options.currentBootId) {
        await this.cleanupRecord(options, parsed);
        parsed.state = parsed.state === 'failed' ? 'failed' : 'exited';
        parsed.exitedAt = now;
        parsed.closedAt = now;
        parsed.failureReason ??= 'Studio process belongs to a previous host boot.';
        await this.writeRecordUnlocked(parsed);
        await this.appendEventUnlocked({
          event: 'registry_marked_previous_boot_exited',
          recordId: parsed.recordId,
          instanceId: parsed.instanceId,
          source: parsed.source,
          reason: 'boot_id_changed',
          action: 'marked_exited_and_cleaned_baseplate',
        }, now);
        continue;
      }

      if (!options.observeProcess || !(parsed.nativeProcessId || parsed.spawnPid)) continue;

      const observation = await options.observeProcess(parsed);
      if (observation.status === 'unknown') {
        parsed.processObservationStatus = 'unknown';
        parsed.lastProcessObservationAt = observation.observedAt;
        parsed.lastProcessObservationError = observation.error;
        parsed.consecutiveConfirmedMisses = 0;
        parsed.firstConfirmedMissAt = undefined;
        await this.writeRecordUnlocked(parsed);
        continue;
      }

      const previousObservationAt = parsed.lastProcessObservationAt;
      parsed.lastSuccessfulProcessObservationAt = observation.observedAt;
      parsed.lastProcessObservationAt = observation.observedAt;
      parsed.lastProcessObservationError = undefined;
      if (observation.status === 'running') {
        parsed.processObservationStatus = 'running';
        parsed.consecutiveConfirmedMisses = 0;
        parsed.firstConfirmedMissAt = undefined;
        await this.writeRecordUnlocked(parsed);
        continue;
      }

      const isNewObservation = previousObservationAt !== observation.observedAt;
      parsed.processObservationStatus = 'not_running';
      if (previousObservationAt !== observation.observedAt) {
        parsed.consecutiveConfirmedMisses = (parsed.consecutiveConfirmedMisses ?? 0) + 1;
        parsed.firstConfirmedMissAt ??= observation.observedAt;
      }
      const requiredMisses = options.confirmedExitMisses ?? DEFAULT_CONFIRMED_EXIT_MISSES;
      const graceMs = options.confirmedExitGraceMs ?? DEFAULT_CONFIRMED_EXIT_GRACE_MS;
      const confirmedAbsent = observation.reason === 'identity_mismatch' || (
        isNewObservation &&
        (parsed.consecutiveConfirmedMisses ?? 0) >= requiredMisses &&
        observation.observedAt - (parsed.firstConfirmedMissAt ?? observation.observedAt) >= graceMs
      );
      if (!confirmedAbsent) {
        await this.writeRecordUnlocked(parsed);
        continue;
      }

      await this.cleanupRecord(options, parsed);
      parsed.state = parsed.state === 'failed' ? 'failed' : 'exited';
      parsed.exitedAt = observation.observedAt;
      parsed.closedAt = observation.observedAt;
      parsed.failureReason = observation.reason === 'identity_mismatch'
        ? 'Studio process identity changed; the retained PID was not reused.'
        : parsed.instanceId
          ? 'Studio process exited.'
          : 'Studio process exited before the MCP plugin connected.';
      await this.writeRecordUnlocked(parsed);
      await this.appendEventUnlocked({
        event: 'registry_marked_process_exited',
        recordId: parsed.recordId,
        instanceId: parsed.instanceId,
        source: parsed.source,
        reason: observation.reason === 'identity_mismatch' ? 'identity_mismatch' : 'pid_not_running',
        action: 'marked_exited_and_cleaned_baseplate',
      }, now);
    }
  }
}
