import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const REGISTRY_VERSION = 1;
const LOCK_STALE_MS = 10000;
const LOCK_RETRY_MS = 25;
const LOCK_TIMEOUT_MS = 5000;
const EVENT_RETENTION_DAYS = 2;
const TERMINAL_RECORD_RETENTION_MS = 24 * 60 * 60 * 1000;

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
}

export interface RegistrySweepOptions {
  currentBootId: string;
  now?: number;
  isProcessRunning?: (record: ManagedInstanceRegistryRecord) => boolean;
  cleanupRecord?: (record: ManagedInstanceRegistryRecord) => void;
}

export interface RegistryEvent {
  event: string;
  recordId?: string;
  instanceId?: string;
  source?: string;
  reason?: string;
  action?: string;
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

function sleepSync(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
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

export class ManagedInstanceRegistry {
  readonly dir: string;

  constructor(dir = defaultManagedInstanceRegistryDir()) {
    this.dir = dir;
  }

  upsert(record: ManagedInstanceRegistryRecord): void {
    this.withLock(() => this.writeRecordUnlocked(record));
  }

  attachInstanceId(recordId: string, instanceId: string): void {
    this.withLock(() => {
      const record = this.readRecordUnlocked(recordId);
      if (!record) return;
      record.instanceId = instanceId;
      record.attachedAt = Date.now();
      this.writeRecordUnlocked(record);
    });
  }

  findOpenByInstanceId(instanceId: string, options: RegistrySweepOptions): ManagedInstanceRegistryRecord | undefined {
    return this.withLock(() => {
      this.sweepUnlocked(options);
      return this.readOpenRecordsUnlocked().find((record) => record.instanceId === instanceId);
    });
  }

  findAnyByInstanceId(instanceId: string): ManagedInstanceRegistryRecord | undefined {
    return this.withLock(() =>
      this.readRecordsUnlocked().find((record) => record.instanceId === instanceId),
    );
  }

  findAnyByRecordId(recordId: string, options: RegistrySweepOptions): ManagedInstanceRegistryRecord | undefined {
    return this.withLock(() => {
      this.sweepUnlocked(options);
      return this.readRecordsUnlocked().find((record) => record.recordId === recordId);
    });
  }

  listOpen(options: RegistrySweepOptions): ManagedInstanceRegistryRecord[] {
    return this.withLock(() => {
      this.sweepUnlocked(options);
      return this.readOpenRecordsUnlocked();
    });
  }

  listOpenUnchecked(): ManagedInstanceRegistryRecord[] {
    return this.withLock(() => this.readOpenRecordsUnlocked());
  }

  markClosed(recordId: string, closedAt = Date.now()): void {
    this.withLock(() => {
      const record = this.readRecordUnlocked(recordId);
      if (!record) return;
      record.closedAt = closedAt;
      this.writeRecordUnlocked(record);
    });
  }

  delete(recordId: string): void {
    this.withLock(() => this.deleteRecordUnlocked(recordId));
  }

  sweep(options: RegistrySweepOptions): void {
    this.withLock(() => this.sweepUnlocked(options));
  }

  logEvent(event: RegistryEvent, now = Date.now()): void {
    this.withLock(() => this.appendEventUnlocked(event, now));
  }

  private withLock<T>(fn: () => T): T {
    this.ensureDir();
    const lockDir = path.join(this.dir, '.lock');
    const deadline = Date.now() + LOCK_TIMEOUT_MS;

    while (true) {
      try {
        fs.mkdirSync(lockDir);
        break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'EEXIST') throw error;

        try {
          const stat = fs.statSync(lockDir);
          if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
            fs.rmSync(lockDir, { recursive: true, force: true });
            continue;
          }
        } catch {
          continue;
        }

        if (Date.now() > deadline) {
          throw new Error(`Timed out waiting for managed instance registry lock: ${lockDir}`);
        }
        sleepSync(LOCK_RETRY_MS);
      }
    }

    try {
      return fn();
    } finally {
      fs.rmSync(lockDir, { recursive: true, force: true });
    }
  }

  private ensureDir() {
    fs.mkdirSync(this.dir, { recursive: true });
  }

  private recordPath(recordId: string): string {
    return path.join(this.dir, `${recordId}.json`);
  }

  private recordFilesUnlocked(): string[] {
    return fs.readdirSync(this.dir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => path.join(this.dir, name));
  }

  private readRecordUnlocked(recordId: string): ManagedInstanceRegistryRecord | undefined {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.recordPath(recordId), 'utf8'));
      return isRecord(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  private readOpenRecordsUnlocked(): ManagedInstanceRegistryRecord[] {
    return this.readRecordsUnlocked().filter((record) => record.closedAt === undefined);
  }

  private readRecordsUnlocked(): ManagedInstanceRegistryRecord[] {
    const records: ManagedInstanceRegistryRecord[] = [];
    for (const file of this.recordFilesUnlocked()) {
      try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!isRecord(parsed)) continue;
        records.push(parsed);
      } catch {
        // Malformed records are removed by sweep; reads stay tolerant.
      }
    }
    return records;
  }

  private writeRecordUnlocked(record: ManagedInstanceRegistryRecord): void {
    this.ensureDir();
    const finalPath = this.recordPath(record.recordId);
    const tmpPath = path.join(this.dir, `${record.recordId}.${process.pid}.${Date.now()}.tmp`);
    const fd = fs.openSync(tmpPath, 'w');
    try {
      fs.writeFileSync(fd, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmpPath, finalPath);
  }

  private deleteRecordUnlocked(recordId: string): void {
    fs.rmSync(this.recordPath(recordId), { force: true });
  }

  private appendEventUnlocked(event: RegistryEvent, now: number): void {
    const file = path.join(this.dir, `events-${ymd(now)}.jsonl`);
    fs.appendFileSync(file, `${JSON.stringify({
      ts: new Date(now).toISOString(),
      ...event,
    })}\n`, 'utf8');
  }

  private cleanupOldEventLogsUnlocked(now: number): void {
    const cutoff = ymd(now - EVENT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    for (const name of fs.readdirSync(this.dir)) {
      const date = eventLogDate(name);
      if (!date || date >= cutoff) continue;
      try {
        fs.rmSync(path.join(this.dir, name), { force: true });
      } catch {
        // Event cleanup is best-effort diagnostics hygiene.
      }
    }
  }

  private cleanupRecord(options: RegistrySweepOptions, record: ManagedInstanceRegistryRecord) {
    try {
      options.cleanupRecord?.(record);
    } catch {
      this.appendEventUnlocked({
        event: 'registry_cleanup_failed',
        recordId: record.recordId,
        instanceId: record.instanceId,
        source: record.source,
        reason: 'cleanup_record_error',
      }, options.now ?? Date.now());
    }
  }

  private sweepUnlocked(options: RegistrySweepOptions): void {
    const now = options.now ?? Date.now();
    this.cleanupOldEventLogsUnlocked(now);

    for (const file of this.recordFilesUnlocked()) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {
        fs.rmSync(file, { force: true });
        this.appendEventUnlocked({
          event: 'registry_pruned_malformed_record',
          reason: 'parse_error',
          action: 'deleted_record',
        }, now);
        continue;
      }

      if (!parsed || typeof parsed !== 'object') {
        fs.rmSync(file, { force: true });
        this.appendEventUnlocked({
          event: 'registry_pruned_malformed_record',
          reason: 'invalid_shape',
          action: 'deleted_record',
        }, now);
        continue;
      }

      const version = (parsed as { version?: unknown }).version;
      if (typeof version === 'number' && version > REGISTRY_VERSION) continue;

      if (!isRecord(parsed)) {
        fs.rmSync(file, { force: true });
        this.appendEventUnlocked({
          event: 'registry_pruned_malformed_record',
          reason: 'invalid_shape',
          action: 'deleted_record',
        }, now);
        continue;
      }

      const terminalAt = parsed.closedAt ?? parsed.exitedAt;
      if (terminalAt !== undefined) {
        if (now - terminalAt > TERMINAL_RECORD_RETENTION_MS) {
          fs.rmSync(file, { force: true });
          this.appendEventUnlocked({
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
        this.cleanupRecord(options, parsed);
        parsed.state = parsed.state === 'failed' ? 'failed' : 'exited';
        parsed.exitedAt = now;
        parsed.closedAt = now;
        parsed.failureReason ??= 'Studio process belongs to a previous host boot.';
        this.writeRecordUnlocked(parsed);
        this.appendEventUnlocked({
          event: 'registry_marked_previous_boot_exited',
          recordId: parsed.recordId,
          instanceId: parsed.instanceId,
          source: parsed.source,
          reason: 'boot_id_changed',
          action: 'marked_exited_and_cleaned_baseplate',
        }, now);
        continue;
      }

      if (options.isProcessRunning && (parsed.nativeProcessId || parsed.spawnPid) && !options.isProcessRunning(parsed)) {
        this.cleanupRecord(options, parsed);
        parsed.state = parsed.state === 'failed' ? 'failed' : 'exited';
        parsed.exitedAt = now;
        parsed.closedAt = now;
        parsed.failureReason ??= parsed.instanceId
          ? 'Studio process exited.'
          : 'Studio process exited before the MCP plugin connected.';
        this.writeRecordUnlocked(parsed);
        this.appendEventUnlocked({
          event: 'registry_marked_process_exited',
          recordId: parsed.recordId,
          instanceId: parsed.instanceId,
          source: parsed.source,
          reason: 'pid_not_running',
          action: 'marked_exited_and_cleaned_baseplate',
        }, now);
      }
    }
  }
}
