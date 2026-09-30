import { open, readdir } from 'node:fs/promises';
import * as path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

// Roblox rotates the stored sign-in credential while Studio signs in: the
// server can replace it in the sign-in response, and Studio then persists the
// replacement. Terminating Studio after the server rotated the credential but
// before Studio stored it leaves an invalidated credential behind, and the
// next launch comes up signed out. Only event names and timestamps from
// Studio's own log are read here; credential values are never inspected.
const SESSION_LOG = /^[\d.]+_(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z_Studio_[A-Fa-f0-9]+_last\.log$/u;
const LINE_TIME = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z),/u;
const SIGN_IN_START = /\[FLog::StudioKeyEvents\] login \([^)]*\) \[start\]/u;
const SIGN_IN_END = /\[FLog::StudioKeyEvents\] login \[end\]\[(success|failure)\]/u;
const HEAD_BYTES = 1024 * 1024;
const FILETIME_UNIX_EPOCH = 116444736000000000n;

export interface StudioSignInSession {
  name: string;
  signingIn: boolean;
  outcome?: 'success' | 'failure';
  lastEndMs?: number;
}

export type StudioSignInSettleResult = 'idle' | 'settled' | 'timeout';

export function fileTimeToUnixMs(fileTime: string): number {
  return Number((BigInt(fileTime) - FILETIME_UNIX_EPOCH) / 10000n);
}

/** Session start encoded in a Studio log name (whole seconds, UTC). */
export function studioSessionLogStartMs(name: string): number | undefined {
  const match = SESSION_LOG.exec(name);
  if (!match) return undefined;
  const [, year, month, day, hour, minute, second] = match.map(Number);
  return Date.UTC(year, month - 1, day, hour, minute, second);
}

export function parseStudioSignIn(name: string, text: string): StudioSignInSession {
  const session: StudioSignInSession = { name, signingIn: false };
  for (const line of text.split(/\r?\n/u)) {
    if (SIGN_IN_START.test(line)) {
      session.signingIn = true;
      continue;
    }
    const end = SIGN_IN_END.exec(line);
    if (!end) continue;
    session.signingIn = false;
    session.outcome = end[1] as 'success' | 'failure';
    const time = LINE_TIME.exec(line)?.[1];
    if (time !== undefined) session.lastEndMs = Date.parse(time);
  }
  return session;
}

/** Sign-in state of Studio sessions whose logs began within [fromMs, toMs]. */
export async function readStudioSignInSessions(logsRoot: string, fromMs: number, toMs: number): Promise<StudioSignInSession[]> {
  let names: string[];
  try {
    names = await readdir(logsRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const sessions: StudioSignInSession[] = [];
  for (const name of names) {
    const startedAt = studioSessionLogStartMs(name);
    if (startedAt === undefined || startedAt < fromMs || startedAt > toMs) continue;
    // Sign-in happens within Studio's first seconds; the head of the log suffices.
    const file = await open(path.join(logsRoot, name), 'r');
    try {
      const buffer = Buffer.alloc(HEAD_BYTES);
      const { bytesRead } = await file.read(buffer, 0, HEAD_BYTES, 0);
      sessions.push(parseStudioSignIn(name, buffer.subarray(0, bytesRead).toString('utf8')));
    } finally {
      await file.close();
    }
  }
  return sessions;
}

export interface StudioSignInSettleOptions {
  logsRoot: string;
  processStartedAtMs: number;
  timeoutMs?: number;
  settleMs?: number;
  /** A younger Studio may not have logged the start of its sign-in yet. */
  youngMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<unknown>;
}

/**
 * Wait (bounded) until the Studio started at processStartedAtMs is not in the
 * middle of signing in, plus a short period for it to persist a rotated
 * credential. 'idle' means no sign-in activity was observed.
 */
export async function waitForStudioSignInToSettle({
  logsRoot, processStartedAtMs, timeoutMs = 15_000, settleMs = 1_500, youngMs = 5_000,
  now = Date.now, sleep = delay,
}: StudioSignInSettleOptions): Promise<StudioSignInSettleResult> {
  const begin = now();
  for (;;) {
    // Log names carry the session start rounded to the second.
    const sessions = await readStudioSignInSessions(logsRoot, processStartedAtMs - 2_000, processStartedAtMs + 30_000);
    const signingIn = sessions.some((session) => session.signingIn);
    const concluded = sessions.some((session) => session.outcome !== undefined);
    const undecided = !signingIn && !concluded && now() - processStartedAtMs < youngMs;
    if (!signingIn && !undecided) {
      const ends = sessions.flatMap((session) => session.lastEndMs === undefined ? [] : [session.lastEndMs]);
      if (!ends.length) return 'idle';
      const sinceEnd = now() - Math.max(...ends);
      // Clamp: host and log clocks can differ slightly (for example under WSL).
      const remaining = Math.min(settleMs, Math.max(0, settleMs - sinceEnd));
      if (remaining > 0) await sleep(remaining);
      return 'settled';
    }
    if (now() - begin >= timeoutMs) return 'timeout';
    await sleep(250);
  }
}
