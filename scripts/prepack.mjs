#!/usr/bin/env node

/**
 * Copies a single built plugin asset from studio-plugin/ into the package
 * directory before npm pack/publish. Run from a publishable package directory
 * via its "prepack" script, passing the asset filename as an argument, e.g.
 * "node ../../scripts/prepack.mjs MCPPlugin.rbxmx".
 */

import { copyFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

const assetName = process.argv[2];
if (!assetName) {
  console.error('Usage: prepack.mjs <asset-filename>');
  process.exit(1);
}

const packageDir = process.cwd();
const rootDir = join(packageDir, '..', '..');
const source = join(rootDir, 'studio-plugin', assetName);
const destDir = join(packageDir, 'studio-plugin');
const dest = join(destDir, assetName);

if (!existsSync(source)) {
  console.error(`${assetName} not found at project root studio-plugin/, skipping copy`);
  process.exit(0);
}

if (existsSync(dest)) {
  console.log(`${assetName} already exists in package, skipping copy`);
  process.exit(0);
}

console.log(`Copying studio-plugin/${assetName} into ${packageDir}`);
mkdirSync(destDir, { recursive: true });
copyFileSync(source, dest);
