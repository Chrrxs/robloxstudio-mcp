#!/usr/bin/env node
// Issue #169: the Studio plugin connects only to the port owner (the primary),
// which accepts only its own plugin version. A newer session that starts while
// an older one owns the port must leave the plugin alone until it takes the port.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Fixtures stay below the repository so relocated CLIs resolve dependencies.
// All plugin writes are redirected here; no Studio process is launched.
const tempParent = path.join(repoRoot, 'tmp');
mkdirSync(tempParent, { recursive: true });
const fixtureRoot = mkdtempSync(path.join(tempParent, 'port-owner-'));
const OLD_VERSION = '9.8.6-port-owner';
const NEW_VERSION = '9.8.7-port-owner';
const WAIT_MS = 15_000;

const asset = (variant, version) => Buffer.from([
  '<roblox version="4"><Item class="Script"><Properties><string name="Source"><![CDATA[',
  `local CURRENT_VERSION = "${version}";`,
  `local PLUGIN_VARIANT = "${variant}";`,
  'local BASE_PORT = 58741;',
  'local DEFAULT_MCP_URL = "http://localhost:58741";',
  'local GLOBAL_SETTING_KEY = "MCP_LAST_SUCCESSFUL_SERVER_URL_GLOBAL_V1";',
  'local SETTING_KEY_PREFIX = "MCP_LAST_SUCCESSFUL_SERVER_URL_";',
  ']]></string></Properties></Item></roblox>',
].join('\n'));

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function fixturePackage(packageName, variant, assetName, version) {
  const packageRoot = path.join(fixtureRoot, `${packageName}-${version}`);
  mkdirSync(path.join(packageRoot, 'dist'), { recursive: true });
  mkdirSync(path.join(packageRoot, 'studio-plugin'), { recursive: true });
  copyFileSync(
    path.join(repoRoot, 'packages', packageName, 'dist/index.js'),
    path.join(packageRoot, 'dist/index.js'),
  );
  writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ type: 'module', version }));
  writeFileSync(path.join(packageRoot, 'studio-plugin', assetName), asset(variant, version));
  return path.join(packageRoot, 'dist/index.js');
}

function startServer(entry, env) {
  const child = spawn(process.execPath, [entry, '--auto-install-plugin'], {
    cwd: fixtureRoot,
    env,
    stdio: ['pipe', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  return {
    exited,
    stderr: () => stderr,
    async waitForLog(pattern) {
      const deadline = Date.now() + WAIT_MS;
      while (!pattern.test(stderr)) {
        if (child.exitCode !== null) throw new Error(`server exited before ${pattern}:\n${stderr}`);
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${pattern}:\n${stderr}`);
        await delay(50);
      }
    },
    async stop() {
      if (child.exitCode === null) {
        child.stdin.end();
        const timer = setTimeout(() => child.kill('SIGKILL'), 5_000);
        await exited;
        clearTimeout(timer);
      }
    },
  };
}

function installedVersion(destination) {
  if (!existsSync(destination)) return undefined;
  return /CURRENT_VERSION = "([^"]+)"/.exec(readFileSync(destination, 'utf8'))?.[1];
}

async function waitForInstalledVersion(destination, version) {
  const deadline = Date.now() + WAIT_MS;
  while (installedVersion(destination) !== version) {
    if (Date.now() > deadline) {
      throw new Error(`plugin stayed at v${installedVersion(destination)}; expected v${version}`);
    }
    await delay(50);
  }
}

const running = [];
try {
  for (const [packageName, variant, assetName] of [
    ['robloxstudio-mcp', 'main', 'MCPPlugin.rbxmx'],
    ['robloxstudio-mcp-inspector', 'inspector', 'MCPInspectorPlugin.rbxmx'],
  ]) {
    const pluginsDir = path.join(fixtureRoot, `${variant}-plugins`);
    const destination = path.join(pluginsDir, assetName);
    const env = {
      ...process.env,
      MCP_PLUGINS_DIR: pluginsDir,
      ROBLOX_STUDIO_PORT: String(await freePort()),
      ROBLOX_STUDIO_AUTH_TOKEN: randomUUID(),
      ROBLOX_STUDIO_PROXY_PROMOTION_INTERVAL_MS: '100',
    };
    delete env.ROBLOX_STUDIO_NO_AUTH;
    delete env.ROBLOX_STUDIO_REQUIRE_PRIMARY;

    const older = startServer(fixturePackage(packageName, variant, assetName, OLD_VERSION), env);
    running.push(older);
    await older.waitForLog(/primary mode/);
    assert.equal(installedVersion(destination), OLD_VERSION, `${packageName}: the port owner installs its plugin`);

    const newer = startServer(fixturePackage(packageName, variant, assetName, NEW_VERSION), env);
    running.push(newer);
    await newer.waitForLog(/running on stdio/);
    assert.match(newer.stderr(), /proxy mode/, `${packageName}: the second session forwards to the port owner`);
    assert.equal(
      installedVersion(destination),
      OLD_VERSION,
      `${packageName}: a forwarding session leaves the port owner's plugin installed`,
    );
    assert.match(
      newer.stderr(),
      new RegExp(`owned by .*v${OLD_VERSION.replaceAll('.', '\\.')}`),
      `${packageName}: the forwarding session names the older port owner`,
    );
    assert.doesNotMatch(newer.stderr(), /trying next/, `${packageName}: a single-port bind does not claim to try another port`);

    await older.stop();
    await newer.waitForLog(/Promoted from proxy to primary/);
    await waitForInstalledVersion(destination, NEW_VERSION);

    await newer.stop();
    console.log(`${packageName}: plugin install follows the port owner`);
  }
} finally {
  await Promise.all(running.map((server) => server.stop()));
  assert.equal(path.dirname(fixtureRoot), tempParent);
  rmSync(fixtureRoot, { recursive: true, force: true });
}
