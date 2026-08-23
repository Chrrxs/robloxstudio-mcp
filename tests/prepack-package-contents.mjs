#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const prepackScript = path.join(repoRoot, 'scripts', 'prepack.mjs');
const packages = [
  {
    directory: 'robloxstudio-mcp',
    name: '@chrrxs/robloxstudio-mcp',
    asset: 'MCPPlugin.rbxmx',
  },
  {
    directory: 'robloxstudio-mcp-inspector',
    name: '@chrrxs/robloxstudio-mcp-inspector',
    asset: 'MCPInspectorPlugin.rbxmx',
  },
];

const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), 'robloxstudio-mcp-prepack-'));
const fixtureScriptsDir = path.join(fixtureRoot, 'scripts');
mkdirSync(fixtureScriptsDir, { recursive: true });
copyFileSync(prepackScript, path.join(fixtureScriptsDir, 'prepack.mjs'));

try {
  const sourcePluginDir = path.join(fixtureRoot, 'studio-plugin');
  mkdirSync(path.join(sourcePluginDir, 'src'), { recursive: true });
  mkdirSync(path.join(sourcePluginDir, 'include'), { recursive: true });
  writeFileSync(path.join(sourcePluginDir, 'MCPPlugin.rbxmx'), 'main-built-plugin');
  writeFileSync(path.join(sourcePluginDir, 'MCPInspectorPlugin.rbxmx'), 'inspector-built-plugin');
  writeFileSync(path.join(sourcePluginDir, 'src', 'source.ts'), 'source-only');
  writeFileSync(path.join(sourcePluginDir, 'include', 'LibMP.lua'), 'large-runtime-source');

  for (const packageDefinition of packages) {
    const packageDir = path.join(fixtureRoot, 'packages', packageDefinition.directory);
    const destination = path.join(packageDir, 'studio-plugin');
    mkdirSync(path.join(packageDir, 'dist'), { recursive: true });
    mkdirSync(destination, { recursive: true });
    writeFileSync(path.join(packageDir, 'dist', 'index.js'), 'runtime-server');
    writeFileSync(
      path.join(packageDir, 'package.json'),
      JSON.stringify({
        name: packageDefinition.name,
        version: '1.0.0',
        files: ['dist/**/*', `studio-plugin/${packageDefinition.asset}`],
        scripts: { prepack: 'node ../../scripts/prepack.mjs' },
      }),
    );
    writeFileSync(path.join(destination, 'stale-source.ts'), 'left by an interrupted pack');

    const result = spawnSync(
      process.platform === 'win32' ? 'npm.cmd' : 'npm',
      ['pack', '--dry-run', '--json', '--silent'],
      {
        cwd: packageDir,
        encoding: 'utf8',
      },
    );
    assert.equal(
      result.status,
      0,
      `${packageDefinition.name} npm pack succeeds: ${result.stderr || result.stdout}`,
    );
    const reportJson = result.stdout.match(/^\[[\s\S]*$/m)?.[0];
    assert.ok(reportJson, `npm pack returned a JSON report: ${result.stdout}`);
    const [packReport] = JSON.parse(reportJson);
    assert.deepEqual(
      packReport.files.map((file) => file.path).sort(),
      ['dist/index.js', 'package.json', `studio-plugin/${packageDefinition.asset}`].sort(),
      `${packageDefinition.name} tarball contains only runtime files`,
    );
    assert.deepEqual(
      readdirSync(destination),
      [packageDefinition.asset],
      `${packageDefinition.name} stages only its runtime plugin asset`,
    );
    assert.equal(
      readFileSync(path.join(destination, packageDefinition.asset), 'utf8'),
      packageDefinition.asset === 'MCPPlugin.rbxmx'
        ? 'main-built-plugin'
        : 'inspector-built-plugin',
    );

    const manifest = JSON.parse(
      readFileSync(path.join(repoRoot, 'packages', packageDefinition.directory, 'package.json'), 'utf8'),
    );
    assert.deepEqual(
      manifest.files,
      ['dist/**/*', `studio-plugin/${packageDefinition.asset}`],
      `${packageDefinition.name} publishes only dist and its runtime plugin asset`,
    );
  }

  const missingPackageDir = path.join(fixtureRoot, 'packages', packages[0].directory);
  rmSync(path.join(sourcePluginDir, packages[0].asset));
  const missingResult = spawnSync(
    process.execPath,
    [path.join(fixtureScriptsDir, 'prepack.mjs')],
    { cwd: missingPackageDir, encoding: 'utf8' },
  );
  assert.notEqual(missingResult.status, 0, 'prepack fails when its built plugin is missing');
  assert.match(
    missingResult.stderr + missingResult.stdout,
    /Run npm run build:plugins first/,
    'prepack explains how to produce a missing plugin build',
  );

  console.log('prepack package contents passed');
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true });
}
