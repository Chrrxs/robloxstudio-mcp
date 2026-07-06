import { execFileSync, spawn } from 'child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from 'fs';
import { randomUUID } from 'crypto';
import * as os from 'os';
import * as path from 'path';
import { ManagedInstanceRegistry, type ManagedInstanceRegistryRecord, type RegistrySweepOptions } from './managed-instance-registry.js';

export type StudioLaunchSource = 'baseplate' | 'local_file' | 'published_place' | 'place_revision';

export interface StudioLaunchOptions {
  source: StudioLaunchSource;
  localPlaceFile?: string;
  placeId?: number;
  universeId?: number;
  placeVersion?: number;
}

export interface ManagedStudioInstance {
  recordId?: string;
  source: StudioLaunchSource;
  instanceId?: string;
  nativeProcessId?: number;
  spawnPid?: number;
  exe: string;
  args: string[];
  placeId?: number;
  universeId?: number;
  placeVersion?: number;
  localPlaceFile?: string;
  launchedAt: number;
  closedAt?: number;
  ownerPid?: number;
  bootId?: string;
  deleteLocalPlaceFileOnClose?: boolean;
}

export interface StudioProcessInfo {
  Id: number;
  Name?: string;
  Path?: string;
  MainWindowTitle?: string;
  CommandLine?: string;
}

const BASEPLATE_TEMP_DIR = path.join(os.tmpdir(), 'robloxstudio-mcp-baseplates');
const BASEPLATE_TEMP_NAME = /^Baseplate-\d+-\d+\.rbxl$/;
const BASEPLATE_TEMPLATE_NAME = 'Baseplate.rbxl';

export interface ConnectedStudioInstance {
  instanceId: string;
  role: string;
  placeId: number;
  placeName: string;
  dataModelName: string;
}

type StudioChildProcess = {
  pid?: number;
  unref: () => void;
};

export interface StudioProcessAdapter {
  listStudioProcesses?: () => StudioProcessInfo[];
  stopProcess?: (processId: number) => void;
  resolveStudioExe?: () => string;
  spawnStudio?: (exe: string, args: string[], options: Parameters<typeof spawn>[2]) => StudioChildProcess;
  currentBootId?: () => string;
}

export interface StudioInstanceManagerOptions {
  registryDir?: string;
  registry?: ManagedInstanceRegistry;
  processAdapter?: StudioProcessAdapter;
}

export type ManagedStudioCloseResult =
  | { status: 'closed'; instanceId?: string }
  | { status: 'already_closed'; instanceId?: string }
  | { status: 'not_found'; instanceId?: string };

function run(command: string, args: string[], options: Record<string, unknown> = {}): string {
  return execFileSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  }).trim();
}

export function isWsl(): boolean {
  if (process.platform !== 'linux') return false;
  try {
    return /microsoft|wsl/i.test(readFileSync('/proc/version', 'utf8'));
  } catch {
    return false;
  }
}

function powershell(script: string): string {
  return run('powershell.exe', ['-NoProfile', '-Command', script], {
    cwd: isWsl() && existsSync('/mnt/c/Windows') ? '/mnt/c/Windows' : process.cwd(),
  });
}

function windowsLocalAppData(): string | undefined {
  if (process.platform === 'win32') return process.env.LOCALAPPDATA;
  if (!isWsl()) return undefined;
  try {
    return run('cmd.exe', ['/c', 'echo %LOCALAPPDATA%'], {
      cwd: existsSync('/mnt/c/Windows') ? '/mnt/c/Windows' : process.cwd(),
    });
  } catch {
    return undefined;
  }
}

function toWslPath(windowsPath: string): string {
  if (!isWsl()) return windowsPath;
  return run('wslpath', ['-u', windowsPath]);
}

function toStudioLaunchArg(arg: string): string {
  if (!isWsl() || !path.isAbsolute(arg) || !existsSync(arg)) return arg;
  return run('wslpath', ['-w', arg]);
}

function resolveEntrypointDir(): string | undefined {
  const entrypoint = process.argv[1];
  if (!entrypoint) return undefined;
  try {
    return path.dirname(realpathSync(entrypoint));
  } catch {
    return path.dirname(path.resolve(entrypoint));
  }
}

function resolveBaseplateTemplatePath(): string {
  const entrypointDir = resolveEntrypointDir();
  const candidates = [
    ...(entrypointDir ? [
      path.join(entrypointDir, 'assets', BASEPLATE_TEMPLATE_NAME),
      path.join(entrypointDir, '..', 'assets', BASEPLATE_TEMPLATE_NAME),
    ] : []),
    path.join(process.cwd(), 'packages', 'core', 'assets', BASEPLATE_TEMPLATE_NAME),
    path.join(process.cwd(), 'packages', 'robloxstudio-mcp', 'dist', 'assets', BASEPLATE_TEMPLATE_NAME),
    path.join(process.cwd(), 'assets', BASEPLATE_TEMPLATE_NAME),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`Baseplate template not found. Expected ${BASEPLATE_TEMPLATE_NAME} in one of: ${candidates.join(', ')}`);
}

const STALE_BASEPLATE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const BASEPLATE_TEMP_SWEEP_NAME = /^Baseplate-(\d+)-\d+\.rbxl(\.lock)?$/;

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// Close-time deletion is best-effort (Windows can hold the place/.lock handle
// briefly after Studio exits) and never happens if the server dies, so old
// files accumulate — Windows never cleans %TEMP% on its own. Sweep anything
// matching our naming pattern that is older than a day.
export function sweepStaleBaseplateFiles(): void {
  let entries: string[];
  try {
    entries = readdirSync(BASEPLATE_TEMP_DIR);
  } catch {
    return;
  }
  const cutoff = Date.now() - STALE_BASEPLATE_MAX_AGE_MS;
  for (const entry of entries) {
    const match = BASEPLATE_TEMP_SWEEP_NAME.exec(entry);
    if (!match) continue;
    // Owner server still running → its instance may still have the file open
    // (a WSL server can unlink a file Studio holds open across \\wsl.localhost).
    if (Number(match[1]) !== process.pid && isProcessAlive(Number(match[1]))) continue;
    const file = path.join(BASEPLATE_TEMP_DIR, entry);
    try {
      if (statSync(file).mtimeMs < cutoff) rmSync(file, { force: true });
    } catch {
      // Still locked or already gone; retry on a future sweep.
    }
  }
}

function createBaseplatePlaceFile(): string {
  mkdirSync(BASEPLATE_TEMP_DIR, { recursive: true });
  sweepStaleBaseplateFiles();
  const file = path.join(BASEPLATE_TEMP_DIR, `Baseplate-${process.pid}-${Date.now()}.rbxl`);
  copyFileSync(resolveBaseplateTemplatePath(), file);
  return file;
}

function isGeneratedBaseplatePlaceFile(file: string): boolean {
  const resolvedFile = path.resolve(file);
  return path.dirname(resolvedFile) === path.resolve(BASEPLATE_TEMP_DIR) &&
    BASEPLATE_TEMP_NAME.test(path.basename(resolvedFile));
}

export function cleanupManagedBaseplateFiles(record: Pick<ManagedStudioInstance, 'source' | 'localPlaceFile'>): void {
  if (record.source !== 'baseplate' || !record.localPlaceFile) return;
  if (!isGeneratedBaseplatePlaceFile(record.localPlaceFile)) return;

  // Best effort: on Windows, Studio can hold the place/.lock handle for a
  // moment after close, so rmSync may throw EPERM/EBUSY. A leftover file in
  // the dedicated temp dir is harmless and must not fail the close itself.
  for (const file of [record.localPlaceFile, `${record.localPlaceFile}.lock`]) {
    try {
      rmSync(file, { force: true });
    } catch {
      // Locked by a lingering Studio handle; leave it for the OS temp cleanup.
    }
  }
}

function prepareStudioLaunchOptions(options: StudioLaunchOptions): StudioLaunchOptions {
  if (options.source !== 'baseplate' || options.localPlaceFile) return options;
  return {
    ...options,
    localPlaceFile: createBaseplatePlaceFile(),
  };
}

export function resolveStudioExe(): string {
  if (process.env.ROBLOX_STUDIO_EXE) return process.env.ROBLOX_STUDIO_EXE;

  if (process.platform === 'darwin') {
    return '/Applications/RobloxStudio.app/Contents/MacOS/RobloxStudio';
  }

  if (process.platform !== 'win32' && !isWsl()) {
    throw new Error('Roblox Studio executable auto-discovery is only supported on Windows, WSL, and macOS. Set ROBLOX_STUDIO_EXE.');
  }

  const localAppData = windowsLocalAppData();
  const root = localAppData
    ? path.join(toWslPath(localAppData), 'Roblox', 'Versions')
    : path.join(os.homedir(), 'AppData', 'Local', 'Roblox', 'Versions');

  if (!existsSync(root)) {
    throw new Error(`Roblox Studio Versions folder not found: ${root}. Set ROBLOX_STUDIO_EXE.`);
  }

  const candidates = readdirSync(root)
    .filter((name) => name.startsWith('version-'))
    .map((name) => path.join(root, name, 'RobloxStudioBeta.exe'))
    .filter((candidate) => existsSync(candidate))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);

  if (candidates.length === 0) {
    throw new Error(`RobloxStudioBeta.exe not found under ${root}. Set ROBLOX_STUDIO_EXE.`);
  }

  return candidates[0];
}

export function listStudioProcesses(): StudioProcessInfo[] {
  if (process.platform === 'darwin') {
    let out = '';
    try {
      out = run('pgrep', ['-fl', 'RobloxStudio']);
    } catch {
      return [];
    }
    return out
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [pid, ...rest] = line.trim().split(/\s+/);
        return { Id: Number(pid), Name: 'RobloxStudio', Path: rest.join(' '), MainWindowTitle: '' };
      })
      .filter((proc) => Number.isFinite(proc.Id));
  }

  if (process.platform !== 'win32' && !isWsl()) return [];

  let out = '';
  try {
    out = powershell(
      'Get-Process RobloxStudioBeta -ErrorAction SilentlyContinue | ' +
      'Select-Object Id,Name,Path,MainWindowTitle | ConvertTo-Json -Compress',
    );
  } catch {
    return [];
  }
  if (!out) return [];
  const parsed = JSON.parse(out);
  return Array.isArray(parsed) ? parsed : [parsed];
}

export function currentBootId(): string {
  if (process.platform === 'linux') {
    try {
      return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    } catch {
      // Fall through to a stable best-effort value.
    }
  }

  if (process.platform === 'win32' || isWsl()) {
    try {
      return powershell('(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString("o")');
    } catch {
      // Fall through to a stable best-effort value.
    }
  }

  if (process.platform === 'darwin') {
    try {
      return run('sysctl', ['-n', 'kern.boottime']);
    } catch {
      // Fall through to a stable best-effort value.
    }
  }

  return `${process.platform}:${os.hostname()}:unknown-boot`;
}

export function buildStudioLaunchArgs(options: StudioLaunchOptions): string[] {
  switch (options.source) {
    case 'baseplate':
      return ['--task', 'EditFile', '--localPlaceFile', options.localPlaceFile ?? createBaseplatePlaceFile()];
    case 'local_file':
      if (!options.localPlaceFile) throw new Error('local_place_file is required when source="local_file".');
      return ['--task', 'EditFile', '--localPlaceFile', options.localPlaceFile];
    case 'published_place':
      if (!options.placeId) throw new Error('place_id is required when source="published_place".');
      if (!options.universeId) throw new Error('Derived universe id is required when source="published_place".');
      return ['--task', 'EditPlace', '--placeId', String(options.placeId), '--universeId', String(options.universeId)];
    case 'place_revision':
      if (!options.placeId) throw new Error('place_id is required when source="place_revision".');
      if (!options.universeId) throw new Error('Derived universe id is required when source="place_revision".');
      if (!options.placeVersion) throw new Error('place_version is required when launching source="place_revision".');
      return [
        '--task', 'EditPlaceRevision',
        '--placeId', String(options.placeId),
        '--universeId', String(options.universeId),
        '--placeVersion', String(options.placeVersion),
      ];
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function basenameAny(filePath: string): string {
  return path.basename(filePath.replace(/\\/g, '/'));
}

export class StudioInstanceManager {
  private managedByInstanceId = new Map<string, ManagedStudioInstance>();
  private pending = new Set<ManagedStudioInstance>();
  private readonly registry: ManagedInstanceRegistry;
  private readonly processAdapter: StudioProcessAdapter;

  constructor(options: StudioInstanceManagerOptions = {}) {
    this.registry = options.registry ?? new ManagedInstanceRegistry(options.registryDir);
    this.processAdapter = options.processAdapter ?? {};
  }

  list(): ManagedStudioInstance[] {
    this.sweepRegistry();
    const records = [...this.managedByInstanceId.values(), ...this.pending];
    for (const registryRecord of this.registry.listOpen(this.registrySweepOptions())) {
      const record = this.fromRegistryRecord(registryRecord);
      if (records.some((existing) =>
        (record.recordId && existing.recordId === record.recordId) ||
        (record.instanceId && existing.instanceId === record.instanceId)
      )) {
        continue;
      }
      records.push(record);
    }
    return records.filter((instance, index, all) => all.indexOf(instance) === index);
  }

  get(instanceId: string): ManagedStudioInstance | undefined {
    this.sweepRegistry();
    const memoryRecord = this.managedByInstanceId.get(instanceId);
    if (memoryRecord) return memoryRecord;
    const registryRecord = this.registry.findOpenByInstanceId(instanceId, this.registrySweepOptions());
    return registryRecord ? this.fromRegistryRecord(registryRecord) : undefined;
  }

  attachInstanceId(record: ManagedStudioInstance, instanceId: string) {
    record.instanceId = instanceId;
    this.pending.delete(record);
    this.managedByInstanceId.set(instanceId, record);
    if (record.recordId) {
      this.registry.attachInstanceId(record.recordId, instanceId);
    }
  }

  async launch(options: StudioLaunchOptions): Promise<ManagedStudioInstance> {
    this.sweepRegistry();
    const preparedOptions = prepareStudioLaunchOptions(options);
    const before = new Set(this.listStudioProcesses().map((proc) => proc.Id));
    const exe = this.processAdapter.resolveStudioExe?.() ?? resolveStudioExe();
    const args = buildStudioLaunchArgs(preparedOptions).map(toStudioLaunchArg);
    const spawnOptions: Parameters<typeof spawn>[2] = {
      cwd: isWsl() && existsSync('/mnt/c/Windows') ? '/mnt/c/Windows' : process.cwd(),
      detached: true,
      stdio: 'ignore',
    };
    const proc = this.processAdapter.spawnStudio
      ? this.processAdapter.spawnStudio(exe, args, spawnOptions)
      : spawn(exe, args, spawnOptions);
    proc.unref();

    const record: ManagedStudioInstance = {
      recordId: randomUUID(),
      source: options.source,
      spawnPid: proc.pid,
      exe,
      args,
      placeId: preparedOptions.placeId,
      universeId: preparedOptions.universeId,
      placeVersion: preparedOptions.placeVersion,
      localPlaceFile: preparedOptions.localPlaceFile,
      launchedAt: Date.now(),
      ownerPid: process.pid,
      bootId: this.getCurrentBootId(),
      deleteLocalPlaceFileOnClose: options.source === 'baseplate',
    };
    this.pending.add(record);
    this.registry.upsert(this.toRegistryRecord(record));

    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && record.nativeProcessId === undefined) {
      const created = this.listStudioProcesses().find((candidate) => !before.has(candidate.Id));
      if (created) {
        record.nativeProcessId = created.Id;
        this.registry.upsert(this.toRegistryRecord(record));
        break;
      }
      await delay(250);
    }

    if (record.nativeProcessId === undefined && process.platform !== 'win32' && !isWsl()) {
      record.nativeProcessId = proc.pid;
      this.registry.upsert(this.toRegistryRecord(record));
    }

    return record;
  }

  closeByInstanceId(instanceId: string): ManagedStudioCloseResult {
    const memoryRecord = this.managedByInstanceId.get(instanceId);
    if (memoryRecord) return this.close(memoryRecord);

    const registryRecord = this.registry.findAnyByInstanceId(instanceId);
    if (!registryRecord) {
      this.sweepRegistry();
      return { status: 'not_found', instanceId };
    }

    if (registryRecord.closedAt !== undefined) {
      this.cleanupManagedRecord(registryRecord);
      this.registry.delete(registryRecord.recordId);
      this.registry.logEvent({
        event: 'registry_close_already_stopped',
        recordId: registryRecord.recordId,
        instanceId: registryRecord.instanceId,
        source: registryRecord.source,
        reason: 'closed_at_present',
        action: 'deleted_record_and_cleaned_baseplate',
      });
      return { status: 'already_closed', instanceId };
    }

    if (registryRecord.bootId !== this.getCurrentBootId()) {
      this.cleanupManagedRecord(registryRecord);
      this.registry.delete(registryRecord.recordId);
      this.registry.logEvent({
        event: 'registry_pruned_previous_boot',
        recordId: registryRecord.recordId,
        instanceId: registryRecord.instanceId,
        source: registryRecord.source,
        reason: 'boot_id_changed',
        action: 'deleted_record_and_cleaned_baseplate',
      });
      return { status: 'already_closed', instanceId };
    }

    return this.close(this.fromRegistryRecord(registryRecord));
  }

  close(record: ManagedStudioInstance): ManagedStudioCloseResult {
    const processId = record.nativeProcessId ?? record.spawnPid;
    if (!processId) {
      throw new Error(`Cannot close ${record.instanceId ?? 'Studio launch'} because its process id was not detected.`);
    }

    const studioProcess = this.findProcessById(processId);
    if (!studioProcess) {
      this.cleanupManagedRecord(record);
      this.markClosedInMemory(record);
      this.markClosedInRegistry(record);
      this.registry.logEvent({
        event: 'registry_close_already_stopped',
        recordId: record.recordId,
        instanceId: record.instanceId,
        source: record.source,
        reason: 'pid_not_running',
        action: 'marked_closed_and_cleaned_baseplate',
      });
      return { status: 'already_closed', instanceId: record.instanceId };
    }

    if (!this.verifyProcessForRecord(record, studioProcess)) {
      this.registry.logEvent({
        event: 'registry_process_verification_failed',
        recordId: record.recordId,
        instanceId: record.instanceId,
        source: record.source,
        reason: 'identity_mismatch',
      });
      throw new Error('Managed Studio process identity could not be verified.');
    }

    try {
      this.closeProcess(processId);
    } catch (error) {
      if (this.findProcessById(processId)) throw error;
      this.registry.logEvent({
        event: 'registry_close_already_stopped',
        recordId: record.recordId,
        instanceId: record.instanceId,
        source: record.source,
        reason: 'stop_raced_with_exit',
        action: 'marked_closed_and_cleaned_baseplate',
      });
      this.cleanupManagedRecord(record);
      this.markClosedInMemory(record);
      this.markClosedInRegistry(record);
      return { status: 'already_closed', instanceId: record.instanceId };
    }

    record.closedAt = Date.now();
    this.cleanupManagedRecord(record);
    this.markClosedInMemory(record);
    this.markClosedInRegistry(record);
    return { status: 'closed', instanceId: record.instanceId };
  }

  closeConnectedInstance(instance: ConnectedStudioInstance) {
    const process = this.findProcessForConnectedInstance(instance);
    if (!process) {
      throw new Error(`Could not find a Studio process for connected instance "${instance.instanceId}".`);
    }
    this.closeProcess(process.Id);
  }

  private closeProcess(processId: number) {
    if (this.processAdapter.stopProcess) {
      this.processAdapter.stopProcess(processId);
      return;
    }

    if (process.platform === 'win32' || isWsl()) {
      powershell(`Stop-Process -Id ${Math.trunc(processId)} -Force -ErrorAction Stop`);
    } else {
      try {
        process.kill(processId, 'SIGTERM');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    }
  }

  private findProcessForConnectedInstance(instance: ConnectedStudioInstance): StudioProcessInfo | undefined {
    const processes = this.listStudioProcesses();
    if (processes.length === 0) return undefined;
    if (processes.length === 1) return processes[0];

    const names = [instance.dataModelName, instance.placeName]
      .map((name) => name.trim())
      .filter((name, index, all) => name.length > 0 && all.indexOf(name) === index);

    const candidates = processes.filter((proc) => {
      const title = (proc.MainWindowTitle ?? '').trim();
      if (!title) return false;
      return names.some((name) =>
        title === `${name} - Roblox Studio` ||
        title.startsWith(`${name} - `) ||
        title.startsWith(`${name} (`),
      );
    });

    if (candidates.length === 1) return candidates[0];
    if (candidates.length > 1) {
      throw new Error(`Multiple Studio processes matched connected instance "${instance.instanceId}".`);
    }
    return undefined;
  }

  private listStudioProcesses(): StudioProcessInfo[] {
    return this.processAdapter.listStudioProcesses?.() ?? listStudioProcesses();
  }

  private getCurrentBootId(): string {
    return this.processAdapter.currentBootId?.() ?? currentBootId();
  }

  private registrySweepOptions(): RegistrySweepOptions {
    return {
      currentBootId: this.getCurrentBootId(),
      isProcessRunning: (record) => this.isRegistryProcessRunning(record),
      cleanupRecord: (record) => this.cleanupManagedRecord(record),
    };
  }

  private sweepRegistry() {
    this.registry.sweep(this.registrySweepOptions());
  }

  private findProcessById(processId: number): StudioProcessInfo | undefined {
    return this.listStudioProcesses().find((proc) => proc.Id === processId);
  }

  private isRegistryProcessRunning(record: ManagedInstanceRegistryRecord): boolean {
    const processId = record.nativeProcessId ?? record.spawnPid;
    if (!processId) return true;
    const studioProcess = this.findProcessById(processId);
    return !!studioProcess && this.verifyProcessForRecord(this.fromRegistryRecord(record), studioProcess);
  }

  private verifyProcessForRecord(record: ManagedStudioInstance, studioProcess: StudioProcessInfo): boolean {
    const processName = `${studioProcess.Name ?? ''} ${studioProcess.Path ?? ''}`.toLowerCase();
    if (!processName.includes('robloxstudio')) return false;

    const processId = record.nativeProcessId ?? record.spawnPid;
    if (record.spawnPid && record.spawnPid === processId && studioProcess.Id === processId) return true;

    const processPath = studioProcess.Path ? path.normalize(studioProcess.Path).toLowerCase() : '';
    const exePath = record.exe ? path.normalize(record.exe).toLowerCase() : '';
    if (processPath && exePath && (processPath === exePath || basenameAny(processPath) === basenameAny(exePath))) {
      return true;
    }

    const commandLine = studioProcess.CommandLine ?? '';
    if (record.localPlaceFile && commandLine.includes(path.basename(record.localPlaceFile))) return true;
    if (record.placeId !== undefined && commandLine.includes(String(record.placeId))) return true;

    return false;
  }

  private cleanupManagedRecord(record: { source: string; localPlaceFile?: string }) {
    if (record.source !== 'baseplate') return;
    cleanupManagedBaseplateFiles({ source: 'baseplate', localPlaceFile: record.localPlaceFile });
  }

  private markClosedInMemory(record: ManagedStudioInstance) {
    record.closedAt = record.closedAt ?? Date.now();
    if (record.instanceId) this.managedByInstanceId.delete(record.instanceId);
    this.pending.delete(record);
  }

  private markClosedInRegistry(record: ManagedStudioInstance) {
    if (record.recordId) this.registry.markClosed(record.recordId, record.closedAt ?? Date.now());
  }

  private toRegistryRecord(record: ManagedStudioInstance): ManagedInstanceRegistryRecord {
    if (!record.recordId) throw new Error('Managed Studio record is missing recordId.');
    if (!record.bootId) throw new Error('Managed Studio record is missing bootId.');
    return {
      version: 1,
      recordId: record.recordId,
      instanceId: record.instanceId,
      source: record.source,
      nativeProcessId: record.nativeProcessId,
      spawnPid: record.spawnPid,
      exe: record.exe,
      args: record.args,
      placeId: record.placeId,
      universeId: record.universeId,
      placeVersion: record.placeVersion,
      localPlaceFile: record.localPlaceFile,
      deleteLocalPlaceFileOnClose: record.deleteLocalPlaceFileOnClose,
      launchedAt: record.launchedAt,
      attachedAt: record.instanceId ? Date.now() : undefined,
      closedAt: record.closedAt,
      ownerPid: record.ownerPid,
      bootId: record.bootId,
    };
  }

  private fromRegistryRecord(record: ManagedInstanceRegistryRecord): ManagedStudioInstance {
    return {
      recordId: record.recordId,
      source: record.source as StudioLaunchSource,
      instanceId: record.instanceId,
      nativeProcessId: record.nativeProcessId,
      spawnPid: record.spawnPid,
      exe: record.exe,
      args: record.args,
      placeId: record.placeId,
      universeId: record.universeId,
      placeVersion: record.placeVersion,
      localPlaceFile: record.localPlaceFile,
      launchedAt: record.launchedAt,
      closedAt: record.closedAt,
      ownerPid: record.ownerPid,
      bootId: record.bootId,
      deleteLocalPlaceFileOnClose: record.deleteLocalPlaceFileOnClose,
    };
  }
}
