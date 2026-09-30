import { closeSync, lstatSync, openSync, readdirSync, readSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

// Roblox rotates the stored Studio sign-in during automatic sign-in and Studio
// persists the replacement. Terminating Studio between the two leaves an
// invalidated credential and the account signed out (observed: a Studio ended
// ~0.5 s after `login (automatic) [start]`; the next launch logged
// `login [end][failure]`). Mirrors packages/core/src/studio-sign-in.ts for
// harness scripts, which do not depend on the built core package. Only event
// names and timestamps are read; credential values are never inspected.
const STUDIO_SESSION_LOG = /^[\d.]+_\d{8}T\d{6}Z_Studio_[A-Fa-f0-9]+_last\.log$/u;
const LINE_TIME = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z),/u;
const SIGN_IN_START = /\[FLog::StudioKeyEvents\] login \([^)]*\) \[start\]/u;
const SIGN_IN_END = /\[FLog::StudioKeyEvents\] login \[end\]\[(success|failure)\]/u;

/** Sign-in state of Studio sessions whose logs were written at or after `since`. */
export function studioSignInSessions(logsRoot, since) {
  let entries;
  try { entries = readdirSync(logsRoot, { withFileTypes: true }); }
  catch (error) { if (error?.code === 'ENOENT') return []; throw error; }
  const sessions = [];
  for (const entry of entries) {
    if (!entry.isFile() || !STUDIO_SESSION_LOG.test(entry.name)) continue;
    const file = path.join(logsRoot, entry.name);
    const info = lstatSync(file);
    if (info.birthtimeMs < since && info.mtimeMs < since) continue;
    // Studio signs in within its first seconds, so the head of the log suffices.
    const length = Math.min(info.size, 1024 * 1024);
    const buffer = Buffer.alloc(length);
    const fd = openSync(file, 'r');
    let text;
    try { text = buffer.subarray(0, readSync(fd, buffer, 0, length, 0)).toString('utf8'); }
    finally { closeSync(fd); }
    let started = false;
    let outcome = null;
    let endedAt = null;
    for (const line of text.split(/\r?\n/u)) {
      if (SIGN_IN_START.test(line)) { started = true; outcome = null; continue; }
      const end = SIGN_IN_END.exec(line);
      if (!end) continue;
      outcome = end[1];
      const time = LINE_TIME.exec(line)?.[1];
      endedAt = time === undefined ? null : Date.parse(time);
    }
    sessions.push({ name: entry.name, started, outcome, endedAt, createdAt: info.birthtimeMs || info.mtimeMs });
  }
  return sessions;
}

/**
 * Wait until no Studio session logged since `since` is signing in, plus the
 * remainder of a persistence period after the latest sign-in end. Sessions
 * that never sign in (for example play-test children) count as settled once
 * they are older than youngMs. Returns 'success' | 'failure' (any session's
 * last sign-in failed) | 'none' (no sign-in observed, or no session appeared
 * within appearMs) | 'timeout'.
 */
export async function waitForStudioSignIn({
  logsRoot, since, now = Date.now, sleep = delay, appearMs = 30_000, timeoutMs = 120_000, settleMs = 5_000, youngMs = 5_000,
}) {
  const startedAt = now();
  for (;;) {
    const sessions = studioSignInSessions(logsRoot, since);
    const elapsed = now() - startedAt;
    const signingIn = sessions.some(session => session.started && session.outcome === null);
    const undecided = sessions.some(session => !session.started && now() - session.createdAt < youngMs);
    const awaitingSession = !sessions.length && elapsed < appearMs;
    if (!signingIn && !undecided && !awaitingSession) {
      const ends = sessions.flatMap(session => session.endedAt === null ? [] : [session.endedAt]);
      if (!ends.length) return 'none';
      // Clamp: host and log clocks can differ slightly.
      const remaining = Math.min(settleMs, Math.max(0, settleMs - (now() - Math.max(...ends))));
      if (remaining > 0) await sleep(remaining);
      return sessions.some(session => session.outcome === 'failure') ? 'failure' : 'success';
    }
    if (elapsed >= timeoutMs) return 'timeout';
    await sleep(500);
  }
}
