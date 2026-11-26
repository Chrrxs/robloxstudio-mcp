// Studio starts each window of a multiplayer playtest as its own Studio
// process. Observed on Windows: the Server is a child of the edit Studio
// (`-task StartServer -localProjectFile <place>`) and each client is a child of
// the Server (`-task StartClient -localProjectFile <place>`), where <place> is
// the file the edit Studio has open. A test window maps to its edit Studio by
// that parent chain, or by the shared place file once a parent has exited.

/** One Studio process with the fields needed to map test windows to their edit Studio. */
export interface StudioProcessNode {
  Id: number;
  ParentId?: number;
  CommandLine?: string;
  /** Creation time as a Windows FILETIME string; with Id, the process identity. */
  StartTimeUtcFileTime?: string;
  MainWindowTitle?: string;
}

export type PlaytestProcessRole = 'server' | 'client';

/** A test window, identified exactly by PID and creation time. */
export interface PlaytestProcess {
  pid: number;
  startedAt: string;
  role: PlaytestProcessRole;
}

const PLAYTEST_TASK = /(?:^|\s)--?task\s+"?Start(Server|Client)\b/iu;
const PLACE_FILE_ARG = /(?:^|\s)--?local(?:Place|Project)File\s+(?:"([^"]+)"|(\S+))/iu;
// Roblox's launcher passes the place inside a JSON launch intent, itself quoted
// on the command line: `-launchIntentString "{\"localplacefile\":\"C:\\\\...\"}"`.
const PLACE_FILE_INTENT = /\\*"localplacefile\\*"\s*:\s*\\*"(.+?)\\*"/iu;
// A parent chain longer than this is not a Studio test (edit → server → client).
const MAX_CHAIN_DEPTH = 8;

/** The test-window role a Studio command line starts, if any. */
export function playtestProcessRole(commandLine: string | undefined): PlaytestProcessRole | undefined {
  const match = commandLine === undefined ? null : PLAYTEST_TASK.exec(commandLine);
  if (!match) return undefined;
  return match[1].toLowerCase() === 'server' ? 'server' : 'client';
}

/** The place file a Studio command line opens, normalized for comparison. */
export function studioPlaceFile(commandLine: string | undefined): string | undefined {
  if (commandLine === undefined) return undefined;
  const arg = PLACE_FILE_ARG.exec(commandLine);
  const raw = arg ? (arg[1] ?? arg[2]) : PLACE_FILE_INTENT.exec(commandLine)?.[1];
  if (raw === undefined) return undefined;
  const normalized = raw.replace(/[\\/]+/gu, '/').replace(/^\/+/u, '').toLowerCase();
  return normalized.length > 0 ? normalized : undefined;
}

function fileTime(node: StudioProcessNode): bigint | undefined {
  const value = node.StartTimeUtcFileTime;
  return value !== undefined && /^[1-9]\d*$/u.test(value) ? BigInt(value) : undefined;
}

/**
 * Every test window that belongs to `edit`: its descendants through other test
 * windows, plus test windows whose parent has exited (or whose parent PID now
 * names a newer process) that name the same place file as `edit` or one of its
 * descendants, when no other edit Studio has that file open.
 */
export function findPlaytestProcesses(edit: StudioProcessNode, processes: StudioProcessNode[]): PlaytestProcess[] {
  const byId = new Map(processes.map((node) => [node.Id, node]));
  const tests = processes.filter((node) =>
    node.Id !== edit.Id && playtestProcessRole(node.CommandLine) !== undefined && fileTime(node) !== undefined,
  );

  // 'edit': reaches `edit`; 'other': reaches another live process; 'broken': its root's parent is gone.
  const ownerOf = (node: StudioProcessNode): 'edit' | 'other' | 'broken' => {
    let current = node;
    for (let depth = 0; depth < MAX_CHAIN_DEPTH; depth += 1) {
      const parent = current.ParentId === undefined ? undefined : byId.get(current.ParentId);
      const parentTime = parent === undefined ? undefined : fileTime(parent);
      const currentTime = fileTime(current);
      // Windows reuses PIDs: a "parent" created after its child is another process.
      if (parent === undefined || (parentTime !== undefined && currentTime !== undefined && parentTime > currentTime)) {
        return 'broken';
      }
      if (parent.Id === edit.Id) return 'edit';
      if (playtestProcessRole(parent.CommandLine) === undefined) return 'other';
      current = parent;
    }
    return 'other';
  };

  const owned = new Set<StudioProcessNode>();
  const orphans: StudioProcessNode[] = [];
  for (const node of tests) {
    const owner = ownerOf(node);
    if (owner === 'edit') owned.add(node);
    else if (owner === 'broken') orphans.push(node);
  }

  if (orphans.length > 0) {
    const editFiles = new Set<string>();
    const ownFile = studioPlaceFile(edit.CommandLine);
    if (ownFile !== undefined) editFiles.add(ownFile);
    for (const node of owned) {
      const file = studioPlaceFile(node.CommandLine);
      if (file !== undefined) editFiles.add(file);
    }
    // A file another edit Studio has open could be that Studio's test.
    for (const node of processes) {
      if (node.Id === edit.Id || playtestProcessRole(node.CommandLine) !== undefined) continue;
      const file = studioPlaceFile(node.CommandLine);
      if (file !== undefined) editFiles.delete(file);
    }
    for (const node of orphans) {
      const file = studioPlaceFile(node.CommandLine);
      if (file !== undefined && editFiles.has(file)) owned.add(node);
    }
  }

  return tests.flatMap((node) => {
    const role = playtestProcessRole(node.CommandLine);
    return owned.has(node) && role !== undefined && node.StartTimeUtcFileTime !== undefined
      ? [{ pid: node.Id, startedAt: node.StartTimeUtcFileTime, role }]
      : [];
  });
}
