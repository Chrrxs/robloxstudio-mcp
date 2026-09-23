import { fork } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';

test('simultaneous first-run processes share one complete persisted token', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mcp-auth-race-'));
  const modulePath = join(directory, 'auth.cjs');
  const workerPath = join(directory, 'worker.cjs');
  writeFileSync(modulePath, ts.transpileModule(readFileSync(join(__dirname, '../auth.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText);
  writeFileSync(workerPath, `
    require('node:os').homedir = () => process.env.AUTH_TEST_HOME;
    const { resolveAuthToken } = require('./auth.cjs');
    process.once('message', () => {
      process.send(resolveAuthToken(), () => process.disconnect());
    });
    process.send('ready');
  `);
  const children = Array.from({ length: 12 }, () => fork(workerPath, [], {
    env: { ...process.env, AUTH_TEST_HOME: directory, ROBLOX_STUDIO_NO_AUTH: '', ROBLOX_STUDIO_AUTH_TOKEN: '' },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  }));
  try {
    const outcomes = children.map((child) => new Promise<{ token: string; filePath: string }>((resolve, reject) => {
      child.on('error', reject);
      child.on('message', (message) => { if (message !== 'ready') resolve(message as { token: string; filePath: string }); });
      child.on('exit', (code) => { if (code !== 0) reject(new Error(`auth worker exited ${code}`)); });
    }));
    const exits = children.map((child) => new Promise<void>((resolve) => child.once('exit', () => resolve())));
    await Promise.all(children.map((child) => new Promise<void>((resolve) => child.once('message', () => resolve()))));
    children.forEach((child) => child.send('start'));
    const results = await Promise.all(outcomes);
    await Promise.all(exits);
    const tokenFile = join(directory, '.robloxstudio-mcp', 'auth-token');
    const token = readFileSync(tokenFile, 'utf8').trim();
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    expect(results.every((result) => result.token === token && result.filePath === tokenFile)).toBe(true);
    expect(readdirSync(join(directory, '.robloxstudio-mcp'))).toEqual(['auth-token']);
    if (process.platform !== 'win32') expect(statSync(tokenFile).mode & 0o777).toBe(0o600);
  } finally {
    children.forEach((child) => { if (child.exitCode === null) child.kill(); });
    rmSync(directory, { recursive: true, force: true });
  }
});
