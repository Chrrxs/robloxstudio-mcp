#!/usr/bin/env node

/**
 * Stages the package-specific built Studio plugin before npm pack/publish.
 * Run from a publishable package directory via its "prepack" script.
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from 'fs';
import { join } from 'path';

const PLUGIN_ASSET_BY_PACKAGE = {
  '@chrrxs/robloxstudio-mcp': 'MCPPlugin.rbxmx',
  '@chrrxs/robloxstudio-mcp-inspector': 'MCPInspectorPlugin.rbxmx',
};

const packageDir = process.cwd();
const rootDir = join(packageDir, '..', '..');
const packageJson = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
const assetName = PLUGIN_ASSET_BY_PACKAGE[packageJson.name];

if (!assetName) {
  console.error(`No Studio plugin artifact is configured for package ${packageJson.name ?? '<unknown>'}`);
  process.exit(1);
}

const source = join(rootDir, 'studio-plugin', assetName);
const dest = join(packageDir, 'studio-plugin');

if (!existsSync(source)) {
  console.error(`Built Studio plugin not found at ${source}. Run npm run build:plugins first.`);
  process.exit(1);
}

rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
copyFileSync(source, join(dest, assetName));
console.log(`Staged studio-plugin/${assetName} for ${packageJson.name}`);
