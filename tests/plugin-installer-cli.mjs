#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Keep fixtures below the repository so relocated CLIs can resolve dependencies.
// All plugin writes are redirected here; no Studio process is launched.
const tempParent = path.join(repoRoot, 'tmp');
mkdirSync(tempParent, { recursive: true });
const fixtureRoot = mkdtempSync(path.join(tempParent, 'installer-cli-'));
const version = '9.8.7-cli-fixture';
const asset = (variant, marker = '') => Buffer.from([
  '<roblox version="4"><Item class="Script"><Properties><string name="Source"><![CDATA[',
  `local CURRENT_VERSION = "${version}";`,
  `local PLUGIN_VARIANT = "${variant}";`,
  'local BASE_PORT = 58741;',
  'local DEFAULT_MCP_URL = "http://localhost:58741";',
  'local GLOBAL_SETTING_KEY = "MCP_LAST_SUCCESSFUL_SERVER_URL_GLOBAL_V1";',
  'local SETTING_KEY_PREFIX = "MCP_LAST_SUCCESSFUL_SERVER_URL_";',
  `-- ${marker}`,
  ']]></string></Properties></Item></roblox>',
].join('\n'));

try {
  for (const variant of ['main', 'inspector']) {
    const packageName = variant === 'main' ? 'robloxstudio-mcp' : 'robloxstudio-mcp-inspector';
    const assetName = variant === 'main' ? 'MCPPlugin.rbxmx' : 'MCPInspectorPlugin.rbxmx';
    const packageRoot = path.join(fixtureRoot, `${packageName} space-ü`);
    const dist = path.join(packageRoot, 'dist');
    const pluginDir = path.join(packageRoot, 'studio-plugin');
    const destination = path.join(fixtureRoot, `${variant}-installed`);
    mkdirSync(dist, { recursive: true });
    mkdirSync(pluginDir, { recursive: true });
    copyFileSync(path.join(repoRoot, 'packages', packageName, 'dist/index.js'), path.join(dist, 'index.js'));
    writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ type: 'module', version }));
    writeFileSync(path.join(pluginDir, assetName), asset(variant));

    const run = (args) => spawnSync(process.execPath, [path.join(dist, 'index.js'), ...args], {
      cwd: fixtureRoot,
      encoding: 'utf8',
      timeout: 15_000,
      env: { ...process.env, MCP_PLUGINS_DIR: destination, ROBLOX_STUDIO_PORT: '58741' },
    });
    for (const flag of ['--install-bundled-plugin', '--install-plugin']) {
      const result = run([flag]);
      assert.equal(result.status, 0, `${packageName} ${flag}: ${result.error ?? result.stderr}`);
      assert.deepEqual(readFileSync(path.join(destination, assetName)), asset(variant));

      const explicitPath = path.join(fixtureRoot, `${variant} explicit.rbxmx`);
      writeFileSync(explicitPath, asset(variant, flag));
      const explicit = run([flag, '--plugin-path', explicitPath]);
      assert.equal(explicit.status, 0, `${packageName} explicit path: ${explicit.error ?? explicit.stderr}`);
      assert.deepEqual(readFileSync(path.join(destination, assetName)), asset(variant, flag));

      const missing = run([flag, '--plugin-path', explicitPath + '.missing']);
      assert.equal(missing.status, 1, `${packageName} missing explicit path must fail`);
      assert.match(missing.stderr, /not found/i);
      assert.deepEqual(readFileSync(path.join(destination, assetName)), asset(variant, flag));
    }
    console.log(`${packageName}: relocated CLI installation flags and explicit paths passed`);
  }
} finally {
  assert.equal(path.dirname(fixtureRoot), tempParent);
  rmSync(fixtureRoot, { recursive: true, force: true });
}
