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

import { PACKAGE_STAGING } from './package-staging.mjs';

const packageDir = process.cwd();
const rootDir = join(packageDir, '..', '..');
const packageJson = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
const staging = PACKAGE_STAGING[packageJson.name];

if (!staging) {
  console.error(`No Studio plugin artifact is configured for package ${packageJson.name ?? '<unknown>'}`);
  process.exit(1);
}

const dest = join(packageDir, 'studio-plugin');

for (const assetName of staging.pluginAssets) {
  const source = join(rootDir, 'studio-plugin', assetName);
  if (!existsSync(source)) {
    console.error(`Built Studio plugin file not found at ${source}. Run npm run build:plugins first.`);
    process.exit(1);
  }
}
for (const { from } of staging.packageFiles) {
  if (!existsSync(join(rootDir, from))) {
    console.error(`Package file not found at ${join(rootDir, from)}. Run git submodule update --init vendor/ui-renderer.`);
    process.exit(1);
  }
}

rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
for (const assetName of staging.pluginAssets) {
  copyFileSync(join(rootDir, 'studio-plugin', assetName), join(dest, assetName));
  console.log(`Staged studio-plugin/${assetName} for ${packageJson.name}`);
}
for (const { from, to } of staging.packageFiles) {
  copyFileSync(join(rootDir, from), join(packageDir, to));
  console.log(`Staged ${to} for ${packageJson.name}`);
}
