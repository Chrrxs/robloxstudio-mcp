import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, lstatSync, openSync, readdirSync, readSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { installerReceiptFacts, parseCompletedInstallerLog } from './studio-install-repair.mjs';
import { windowsPowerShellEnvironment } from './studio-lifecycle.mjs';

export function collectStudioBitsDiagnostics({ platform = process.platform, execute = execFileSync, env = process.env } = {}) {
  if (platform !== 'win32') return { available: false, reason: 'Windows required' };
  // Never enumerate another account's jobs or expose transfer URLs/credentials.
  const script = [
    "$ErrorActionPreference = 'Stop'",
    '$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
    '$jobs = @(Get-BitsTransfer -ErrorAction Stop)',
    '$result = @($jobs | Select-Object -First 25 | ForEach-Object {',
    '  $owner = (New-Object Security.Principal.NTAccount($_.OwnerAccount)).Translate([Security.Principal.SecurityIdentifier]).Value',
    '  if ($owner -ne $sid) { throw "Unexpected BITS owner" }',
    '  [pscustomobject]@{ id = [string]$_.JobId; state = [string]$_.JobState; priority = [string]$_.Priority; bytesTransferred = [string]$_.BytesTransferred; bytesTotal = [string]$_.BytesTotal; filesTransferred = [string]$_.FilesTransferred; filesTotal = [string]$_.FilesTotal; errorCode = [int]$_.InternalErrorCode; modified = $_.ModificationTime.ToUniversalTime().ToString("o") }',
    '})',
    '[pscustomobject]@{ available = $true; totalJobs = $jobs.Count; jobs = $result } | ConvertTo-Json -Compress -Depth 4',
  ].join('\n');
  try {
    return JSON.parse(execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8', env: windowsPowerShellEnvironment(env), timeout: 15_000,
      maxBuffer: 64 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    }));
  } catch {
    return { available: false, reason: 'Current-account BITS query failed' };
  }
}

function entries(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true });
}

function recentText(file) {
  const size = lstatSync(file).size;
  const length = Math.min(size, 512 * 1024);
  const buffer = Buffer.alloc(length);
  const fd = openSync(file, 'r');
  try {
    const bytes = readSync(fd, buffer, 0, length, size - length);
    return buffer.subarray(0, bytes).toString('utf8');
  } finally { closeSync(fd); }
}

// Why an installer log is (not) a completion receipt: counts and timestamps only.
function receiptSummary(text) {
  const facts = installerReceiptFacts(text);
  let completion = null;
  try { completion = parseCompletedInstallerLog(text, Date.now()).version; } catch { /* reported as false */ }
  const iso = time => (Number.isFinite(time) ? new Date(time).toISOString() : null);
  return {
    completedReceipt: completion !== null,
    records: facts.records.length,
    firstRecord: iso(facts.records[0]?.time),
    currentVersionLines: facts.currentVersionLines,
    versionGuids: [...new Set(facts.versions)],
    successes: facts.successes.map(iso),
    completions: facts.completions.map(iso),
    terminalFailure: facts.terminalFailure,
  };
}

export function collectStudioInstallDiagnostics(localAppData) {
  if (typeof localAppData !== 'string' || !path.isAbsolute(localAppData)) {
    throw new Error('Diagnostics require the verified test account LocalAppData directory.');
  }
  const roblox = path.join(localAppData, 'Roblox');
  const versionsRoot = path.join(roblox, 'Versions');
  const versions = entries(versionsRoot).filter(entry => entry.isDirectory() && /^version-[a-f0-9]+$/i.test(entry.name))
    .map(entry => {
      const directory = path.join(versionsRoot, entry.name);
      const executable = path.join(directory, 'RobloxStudioBeta.exe');
      const files = entries(directory);
      const markers = files.filter(file => /\.crdownload$/i.test(file.name) || file.name === 'AppSettings.xml')
        .sort((a, b) => a.name.localeCompare(b.name)).slice(0, 16)
        .map(file => {
          const info = lstatSync(path.join(directory, file.name));
          return { name: file.name, size: info.size, modified: info.mtime.toISOString(), regularFile: info.isFile() };
        });
      return {
        directory,
        modified: lstatSync(directory).mtime.toISOString(),
        executable: existsSync(executable) ? { size: lstatSync(executable).size, modified: lstatSync(executable).mtime.toISOString() } : null,
        markers,
        entries: files.map(file => file.name + (file.isDirectory() ? '/' : '')).sort(),
      };
    }).filter(version => version.executable).sort((a, b) => b.executable.modified.localeCompare(a.executable.modified)).slice(0, 8);
  const logsRoot = path.join(roblox, 'logs');
  const logFiles = entries(logsRoot).filter(entry => entry.isFile() && /\.log$/i.test(entry.name))
    .map(entry => ({ name: entry.name, modified: lstatSync(path.join(logsRoot, entry.name)).mtimeMs }))
    .sort((a, b) => b.modified - a.modified);
  // Studio startup can generate many newer files while an installer is active.
  // Retain the latest installer evidence even when it falls outside that tail.
  const installerLogs = new Set(logFiles.filter(file => /^RobloxStudioInstaller.*\.log$/i.test(file.name)).slice(0, 4));
  const selectedLogs = logFiles.filter((file, index) => index < 8 || installerLogs.has(file));
  const logs = selectedLogs.map(file => {
    const text = recentText(path.join(logsRoot, file.name));
    const lines = text.split(/\r?\n/);
    const installer = /^RobloxStudioInstaller.*\.log$/i.test(file.name);
    return {
      name: file.name,
      modified: new Date(file.modified).toISOString(),
      sensitiveLinesOmitted: lines.filter(line => /auth|cookie|token|password|ticket|secret|credential|api.?key/i.test(line)).length,
      ...(installer ? { receipt: receiptSummary(text) } : {}),
      // Sign-in outcomes are otherwise lost behind plugin-loading noise. Only
      // the event names and storage status messages are kept, never values.
      ...(installer ? {} : {
        signInEvents: lines.filter(line => /\[FLog::StudioKeyEvents\] login |\[FLog::KeyValueStorage\] Secure Storage /u.test(line))
          .filter(line => !/auth|cookie|token|password|ticket|secret|credential|api.?key/i.test(line))
          .slice(-10).map(line => line.replace(/https?:\/\/\S+/gi, '<URL>').replace(/[A-Za-z0-9_+\/=\-]{80,}/g, '<REDACTED>').slice(0, 300)),
        // When credential activity happened and which subsystem logged it:
        // timestamp and FLog channel only; the line content is never kept.
        sensitiveEvents: lines.filter(line => /auth|cookie|token|password|ticket|secret|credential|api.?key/i.test(line))
          .map(line => {
            const time = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z),/u.exec(line)?.[1] ?? null;
            const channel = /\[(D?FLog::[A-Za-z0-9_]{1,64})\]/u.exec(line)?.[1] ?? null;
            return { time, channel };
          }).slice(-20),
      }),
      indicators: lines.filter(line => /error|exception|fail|missing|corrupt|appsettings|executable|contentprovider|version|channel|installer.*success|completed successfully/i.test(line) ||
          (installer && /\[FLog::DesktopInstaller\]/u.test(line)))
        .filter(line => !/auth|cookie|token|password|ticket|secret|credential|api.?key/i.test(line))
        .slice(-35).map(line => line.replace(/https?:\/\/\S+/gi, '<URL>').replace(/[A-Za-z0-9_+\/=\-]{80,}/g, '<REDACTED>').slice(0, 500)),
    };
  });
  return { readOnly: true, versionsRoot, versions, logs };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 2) throw new Error('Installation diagnostics accept no commands or mutation options.');
  console.log(JSON.stringify({
    ...collectStudioInstallDiagnostics(process.env.LOCALAPPDATA),
    backgroundTransfers: collectStudioBitsDiagnostics(),
  }, null, 2));
}
