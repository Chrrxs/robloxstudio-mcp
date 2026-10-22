// snapshot / diff_state: snapshots live in this server process (newest 20)
// and diffs report only what changed.

export interface InstanceState {
  path: string;
  found: boolean;
  values?: Record<string, string>;
  attributes?: Record<string, string>;
}

export interface Snapshot {
  id: string;
  /** Peer role the state was read from; diff_state reads the same peer. */
  role: string;
  instance_id?: string;
  paths: string[];
  fields: string[];
  state: InstanceState[];
}

const MAX_SNAPSHOTS = 20;
const MAX_DIFF_LINES = 40;

export class SnapshotStore {
  private readonly snapshots = new Map<string, Snapshot>();
  private next = 1;

  add(snapshot: Omit<Snapshot, 'id'>): Snapshot {
    const stored = { ...snapshot, id: `s${this.next++}` };
    this.snapshots.set(stored.id, stored);
    while (this.snapshots.size > MAX_SNAPSHOTS) this.snapshots.delete(this.snapshots.keys().next().value!);
    return stored;
  }

  get(id: string): Snapshot | undefined {
    return this.snapshots.get(id);
  }
}

export function summarizeSnapshot(snapshot: Snapshot): string[] {
  const found = snapshot.state.filter((item) => item.found);
  const values = found.reduce((sum, item) => sum + Object.keys(item.values ?? {}).length + Object.keys(item.attributes ?? {}).length, 0);
  return [
    `snapshot ${snapshot.id}: ${values} values, ${found.length} instance${found.length === 1 ? '' : 's'}`,
    ...snapshot.state.filter((item) => !item.found).map((item) => `! missing ${item.path}`),
  ];
}

export function diffStates(before: readonly InstanceState[], after: readonly InstanceState[]): string[] {
  const lines: string[] = [];
  const now = new Map(after.map((item) => [item.path, item]));
  for (const old of before) {
    const current = now.get(old.path);
    if (!current?.found) {
      if (old.found) lines.push(`! missing ${old.path}`);
      continue;
    }
    if (!old.found) {
      lines.push(`+ ${old.path} appeared`);
      continue;
    }
    for (const key of new Set([...Object.keys(old.values ?? {}), ...Object.keys(current.values ?? {})])) {
      const a = old.values?.[key];
      const b = current.values?.[key];
      if (a !== b) lines.push(`${old.path}.${key}: ${a ?? 'nil'} → ${b ?? 'nil'}`);
    }
    for (const key of new Set([...Object.keys(old.attributes ?? {}), ...Object.keys(current.attributes ?? {})])) {
      const a = old.attributes?.[key];
      const b = current.attributes?.[key];
      if (a === b) continue;
      if (a === undefined) lines.push(`+${old.path}@${key}=${b}`);
      else if (b === undefined) lines.push(`-${old.path}@${key}`);
      else lines.push(`${old.path}@${key}: ${a} → ${b}`);
    }
  }
  if (lines.length === 0) return ['no changes'];
  if (lines.length <= MAX_DIFF_LINES) return lines;
  return [...lines.slice(0, MAX_DIFF_LINES), `… ${lines.length - MAX_DIFF_LINES} more changes`];
}
