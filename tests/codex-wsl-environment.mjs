#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const wrapper = path.join(repoRoot, 'scripts', 'codex-robloxstudio-mcp.sh');
const wrapperSource = await readFile(wrapper, 'utf8');

assert.match(wrapperSource, /ROBLOXSTUDIO_MCP_ENV_FILE/);
assert.match(wrapperSource, /\.codex\/\.env/);
assert.match(wrapperSource, /set -a/);

async function isWslKernel() {
  if (process.platform !== 'linux') return false;
  try {
    return /microsoft|wsl/i.test(await readFile('/proc/version', 'utf8'));
  } catch {
    return false;
  }
}

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Could not reserve a loopback port.');
  }
  await new Promise((resolve) => server.close(resolve));
  return address.port;
}

async function waitForHealth(url, child, stderr) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `Codex wrapper exited before health was ready (${child.exitCode ?? child.signalCode}).\n${stderr()}`,
      );
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(500) });
      if (response.ok) return response.json();
    } catch {
      // Broker is still starting.
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for the Codex-started broker.\n${stderr()}`);
}

async function stopProcessGroup(child) {
  if (!Number.isSafeInteger(child.pid) || child.pid <= 0) return;
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }

  const exited = await Promise.race([
    new Promise((resolve) => child.once('exit', () => resolve(true))),
    delay(3000).then(() => false),
  ]);
  if (exited) return;
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
}

async function envFileDefines(filePath, name) {
  try {
    const source = await readFile(filePath, 'utf8');
    return new RegExp(`^(?:export\\s+)?${name}=`, 'm').test(source);
  } catch {
    return false;
  }
}

async function processHasEnvironmentVariable(pid, name) {
  const environmentBytes = await readFile(`/proc/${pid}/environ`);
  return environmentBytes
    .toString('utf8')
    .split('\0')
    .some((entry) => entry.startsWith(`${name}=`));
}

if (!(await isWslKernel())) {
  console.log('SKIP codex-wsl-environment: host kernel is not WSL');
  process.exit(0);
}

const port = await reservePort();
const canonicalEnvFile = process.env.ROBLOXSTUDIO_MCP_ENV_FILE
  ?? path.join(process.env.HOME ?? '', '.codex', '.env');
const expectsCanonicalOpenCloudKey = await envFileDefines(
  canonicalEnvFile,
  'ROBLOX_OPEN_CLOUD_API_KEY',
);
const environment = {
  ...process.env,
  ROBLOX_STUDIO_PORT: String(port),
  ROBLOX_STUDIO_HOST: '127.0.0.1',
  ROBLOX_STUDIO_NO_AUTH: '1',
  ROBLOXSTUDIO_MCP_SKIP_BUILD: '1',
  ROBLOXSTUDIO_MCP_SKIP_AUTO_INSTALL_PLUGIN: '1',
};
delete environment.WSL_INTEROP;
delete environment.WSL_DISTRO_NAME;
delete environment.ROBLOX_OPEN_CLOUD_API_KEY;

const child = spawn(wrapper, [], {
  cwd: repoRoot,
  env: environment,
  detached: true,
  stdio: ['pipe', 'ignore', 'pipe'],
});
let stderrBuffer = '';
child.stderr.setEncoding('utf8');
child.stderr.on('data', (chunk) => {
  stderrBuffer = `${stderrBuffer}${chunk}`.slice(-12_000);
});

try {
  const health = await waitForHealth(
    `http://127.0.0.1:${port}/health`,
    child,
    () => stderrBuffer,
  );
  assert.equal(health.status, 'ok');
  assert.equal(health.service, 'robloxstudio-mcp');
  assert.deepEqual(
    health.capabilities?.studioLifecycle?.processIdentity,
    {
      supported: true,
      launcher: 'wsl-windows-retained',
    },
  );
  assert.equal(
    health.capabilities?.studioLifecycle?.windowsInteropAvailable,
    true,
  );
  if (expectsCanonicalOpenCloudKey) {
    assert.equal(
      await processHasEnvironmentVariable(
        child.pid,
        'ROBLOX_OPEN_CLOUD_API_KEY',
      ),
      true,
    );
  }
  console.log('PASS codex-wsl-environment');
} finally {
  child.stdin.end();
  await stopProcessGroup(child);
}
