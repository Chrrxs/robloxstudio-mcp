#!/usr/bin/env node

/**
 * Removes the copied studio-plugin/ and staged license files from the package directory after npm pack/publish.
 * Run from a publishable package directory via its "postpack" script.
 */

import { rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { PACKAGE_STAGING } from './package-staging.mjs';

const packageDir = process.cwd();
const dest = join(packageDir, 'studio-plugin');

if (existsSync(dest)) {
  console.log(`Cleaning up studio-plugin/ from ${packageDir}`);
  rmSync(dest, { recursive: true, force: true });
}

const packageJson = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
for (const { to } of PACKAGE_STAGING[packageJson.name]?.packageFiles ?? []) {
  const staged = join(packageDir, to);
  if (existsSync(staged)) {
    console.log(`Cleaning up ${to} from ${packageDir}`);
    rmSync(staged, { force: true });
  }
}
