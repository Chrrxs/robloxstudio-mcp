import { randomBytes, createHash, timingSafeEqual } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'fs';
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
    if (existsSync(filePath)) {
      const existing = readFileSync(filePath, 'utf8').trim();
      if (existing) {
        return { token: existing, source: 'file', filePath };
      }
    }
    const fresh = randomBytes(32).toString('hex');
    mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
    writeFileSync(filePath, fresh + '\n', { encoding: 'utf8', mode: 0o600 });
    try {
      chmodSync(filePath, 0o600); // writeFileSync mode is ignored if the file pre-existed
    } catch {
      // Best-effort on platforms without POSIX permissions (Windows)
    }
    return { token: fresh, source: 'file', filePath };
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
