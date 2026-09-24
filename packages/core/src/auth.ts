import { randomBytes, createHash, timingSafeEqual } from 'crypto';
import { mkdirSync, readFileSync, writeFileSync, linkSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';

// Shared-secret auth for the local HTTP surface. The token gates the
// tool-invoking endpoints (/mcp, /mcp/*, /proxy, /topology,
// /unregister-instance-id) so that localhost malware and cross-origin web
// pages can't drive Studio blind. Plugin-facing endpoints (/ready, /events,
// /response, /disconnect) stay tokenless because Studio plugins cannot read
// local files; they only register or exchange queued bridge messages and cannot
// invoke tools directly.
//
// Resolution order:
//   1. ROBLOX_STUDIO_NO_AUTH=1|true  -> auth disabled (explicit opt-out)
//   2. ROBLOX_STUDIO_AUTH_TOKEN      -> use that value
//   3. ~/.robloxstudio-mcp/auth-token (created on first run, mode 0600)
//
// Every MCP subprocess on the machine resolves the same token, so proxy-mode
// sessions authenticate to the primary automatically.

export interface ResolvedAuthToken {
  token?: string;
  source: 'env' | 'file' | 'disabled';
  filePath?: string;
}

export function authTokenFilePath(): string {
  return join(homedir(), '.robloxstudio-mcp', 'auth-token');
}

export function resolveAuthToken(): ResolvedAuthToken {
  const noAuth = (process.env.ROBLOX_STUDIO_NO_AUTH || '').toLowerCase();
  if (noAuth === '1' || noAuth === 'true') {
    return { source: 'disabled' };
  }

  const envToken = process.env.ROBLOX_STUDIO_AUTH_TOKEN?.trim();
  if (envToken) {
    return { token: envToken, source: 'env' };
  }

  const filePath = authTokenFilePath();
  try {
    try {
      const existing = readFileSync(filePath, 'utf8').trim();
      if (!existing) throw new Error('Auth token file is empty; remove it while all MCP servers are stopped to reinitialize it.');
      return { token: existing, source: 'file', filePath };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const fresh = randomBytes(32).toString('hex');
    mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
    const stagingPath = `${filePath}.${process.pid}.${randomBytes(16).toString('hex')}.tmp`;
    writeFileSync(stagingPath, fresh + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    try {
      // Publish a complete file without replacing another process's winner.
      // Exclusive creation of the final file alone exposes an empty file until
      // its first write; a hard link makes both existence and contents atomic.
      try {
        linkSync(stagingPath, filePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      const token = readFileSync(filePath, 'utf8').trim();
      if (!token) throw new Error('Auth token file is empty.');
      return { token, source: 'file', filePath };
    } finally {
      try { unlinkSync(stagingPath); } catch { /* Best-effort staging cleanup. */ }
    }
  } catch (err) {
    // Could not persist a token (read-only home, etc). Fall back to an
    // in-memory token: this process stays protected, but proxy subprocesses
    // won't be able to authenticate until ROBLOX_STUDIO_AUTH_TOKEN is set.
    console.error(
      `[auth] Could not read/create ${filePath} (${err instanceof Error ? err.message : err}). ` +
      'Using an in-memory token for this process; set ROBLOX_STUDIO_AUTH_TOKEN to share one across sessions.',
    );
    return { token: randomBytes(32).toString('hex'), source: 'file' };
  }
}

/** Constant-time token comparison (hashes both sides to hide length). */
export function tokensMatch(provided: string, expected: string): boolean {
  const a = createHash('sha256').update(provided).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}
