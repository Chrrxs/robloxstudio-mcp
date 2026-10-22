// Pure helpers for logs_since: level filter, repeat collapse, compact lines.

export const LOG_LEVELS = ['out', 'info', 'warn', 'error'] as const;
export type LogLevelName = typeof LOG_LEVELS[number];

/** Plugin level tags, lowest to highest. */
const RANK: Record<string, number> = { OUT: 0, INFO: 1, WARN: 2, ERR: 3 };
const LEVEL_TAG: Record<LogLevelName, string> = { out: 'OUT', info: 'INFO', warn: 'WARN', error: 'ERR' };

export const MAX_LOG_LINES = 50;
const MAX_MESSAGE_CHARS = 300;

export interface LogEntry {
  ts?: number;
  level?: string;
  message?: string;
  role?: string;
}

/** Adds the peer role to a merged runtime log entry (entries carry no role of their own). */
export function tagRole(entry: unknown, role: string): unknown {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return entry;
  return { ...entry, role };
}

export function minRank(level: LogLevelName): number {
  return RANK[LEVEL_TAG[level]];
}

function clock(ts: number | undefined): string {
  if (ts === undefined || !Number.isFinite(ts)) return '--:--:--.-';
  const date = new Date(ts * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}.${Math.floor(date.getUTCMilliseconds() / 100)}`;
}

function oneLine(message: string): string {
  const flat = message.replace(/\s*\r?\n\s*/g, ' | ').trim();
  return flat.length > MAX_MESSAGE_CHARS ? `${flat.slice(0, MAX_MESSAGE_CHARS - 1)}…` : flat;
}

/**
 * Filters entries by level and role, collapses identical (role, level,
 * message) repeats in first-seen order, and keeps the newest MAX_LOG_LINES.
 */
export function formatLogLines(entries: readonly LogEntry[], options: { minLevel: LogLevelName; role?: string }): string[] {
  const floor = minRank(options.minLevel);
  const groups = new Map<string, { first: LogEntry; count: number }>();
  for (const entry of entries) {
    if ((RANK[entry.level ?? 'OUT'] ?? 0) < floor) continue;
    if (options.role !== undefined && entry.role !== options.role) continue;
    const key = `${entry.role}\u0000${entry.level}\u0000${entry.message}`;
    const group = groups.get(key);
    if (group) group.count++;
    else groups.set(key, { first: entry, count: 1 });
  }
  const lines = [...groups.values()].map(({ first, count }) =>
    `${clock(first.ts)} ${first.role ?? '?'} ${first.level ?? 'OUT'} ${oneLine(first.message ?? '')}${count > 1 ? ` (x${count})` : ''}`);
  if (lines.length <= MAX_LOG_LINES) return lines;
  return [`… ${lines.length - MAX_LOG_LINES} earlier lines omitted`, ...lines.slice(-MAX_LOG_LINES)];
}
