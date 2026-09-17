import { closeSync, existsSync, lstatSync, openSync, readdirSync, readSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

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
    return {
      name: file.name,
      modified: new Date(file.modified).toISOString(),
      sensitiveLinesOmitted: lines.filter(line => /auth|cookie|token|password|ticket|secret|credential|api.?key/i.test(line)).length,
      indicators: lines.filter(line => /error|exception|fail|missing|corrupt|appsettings|executable|contentprovider|version|channel|installer.*success|completed successfully/i.test(line))
        .filter(line => !/auth|cookie|token|password|ticket|secret|credential|api.?key/i.test(line))
        .slice(-35).map(line => line.replace(/https?:\/\/\S+/gi, '<URL>').replace(/[A-Za-z0-9_+\/=\-]{80,}/g, '<REDACTED>').slice(0, 500)),
    };
  });
  return { readOnly: true, versionsRoot, versions, logs };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 2) throw new Error('Installation diagnostics accept no commands or mutation options.');
  console.log(JSON.stringify(collectStudioInstallDiagnostics(process.env.LOCALAPPDATA), null, 2));
}
