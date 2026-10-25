#!/usr/bin/env node

// Sets one version across the root, workspace packages, and package-lock.json.
// Run and commit this before the release gate; publish.mjs never edits files.
// Usage: node scripts/sync-versions.mjs [version]   (default: root package.json version)

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { VERSIONED_PACKAGE_DIRECTORIES } from './release-record.mjs';

const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;

function readJson(filename) {
  return JSON.parse(readFileSync(filename, 'utf8'));
}

function writeJson(filename, value) {
  writeFileSync(filename, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export function syncVersions({ rootDir, version, log = console.log }) {
  const target = version ?? readJson(path.join(rootDir, 'package.json')).version;
  if (typeof target !== 'string' || !VERSION.test(target)) throw new Error(`Invalid version ${JSON.stringify(target)}.`);
  log(`Syncing version ${target}...`);
  for (const directory of VERSIONED_PACKAGE_DIRECTORIES) {
    const filename = path.join(rootDir, directory, 'package.json');
    const pkg = readJson(filename);
    if (pkg.version === target) {
      log(`  ${pkg.name}: ${target} (already synced)`);
      continue;
    }
    log(`  ${pkg.name}: ${pkg.version} -> ${target}`);
    pkg.version = target;
    writeJson(filename, pkg);
  }
  const lockPath = path.join(rootDir, 'package-lock.json');
  if (existsSync(lockPath)) {
    const lock = readJson(lockPath);
    lock.version = target;
    for (const directory of VERSIONED_PACKAGE_DIRECTORIES) {
      const entry = lock.packages?.[directory === '.' ? '' : directory];
      if (entry) entry.version = target;
    }
    writeJson(lockPath, lock);
  }
  return target;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
    const version = syncVersions({ rootDir, version: process.argv[2] });
    console.log(`\nCommit the version change, then run npm run test:e2e:full and npm run publish:all for v${version}.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
