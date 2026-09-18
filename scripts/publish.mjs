#!/usr/bin/env node

import { execSync } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');

const run = (cmd) => {
  console.log(`> ${cmd}`);
  execSync(cmd, { stdio: 'inherit', cwd: rootDir });
};

// Read version from root package.json
const rootPkg = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8'));
const version = rootPkg.version;

// Sync version across all packages
const packageDirs = [
  'packages/core',
  'packages/robloxstudio-mcp',
  'packages/robloxstudio-mcp-inspector',
];

console.log(`Syncing version ${version} across all packages...`);
for (const dir of packageDirs) {
  const pkgPath = join(rootDir, dir, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  if (pkg.version !== version) {
    console.log(`  ${pkg.name}: ${pkg.version} -> ${version}`);
    pkg.version = version;
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
  } else {
    console.log(`  ${pkg.name}: ${version} (already synced)`);
  }
}

console.log('\nBuilding all packages...');
run('npm run build:all');

console.log('\nPublishing robloxstudio-mcp...');
run('npm publish -w packages/robloxstudio-mcp');

console.log('\nPublishing robloxstudio-mcp-inspector...');
run('npm publish -w packages/robloxstudio-mcp-inspector');

console.log('\nAll packages published successfully!');
