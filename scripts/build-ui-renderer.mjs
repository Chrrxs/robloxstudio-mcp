#!/usr/bin/env node

/**
 * Compiles the pinned story renderer (vendor/ui-renderer, GPL-3.0; attribution
 * in packages/robloxstudio-mcp/NOTICE) together with the maintained MCP preview
 * adapter in an isolated staging directory.
 *
 * The vendor submodule is never modified: its pinned source, patches, configs,
 * and pnpm lockfile are copied into .local/ui-renderer-build, the adapter
 * studio-plugin/ui-renderer/Preview.tsx is copied to src/McpPreview.tsx, then
 * dependencies are installed with `pnpm install --frozen-lockfile` and compiled
 * with `pnpm exec rbxtsc`. build-plugin.mjs packages the result into the main
 * plugin variant as the UIRenderer folder.
 */

import { execFileSync } from 'child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const rootDir = join(__dirname, '..');
export const vendorDir = join(rootDir, 'vendor', 'ui-renderer');
export const stagingDir = join(rootDir, '.local', 'ui-renderer-build');
export const adapterDir = join(rootDir, 'studio-plugin', 'ui-renderer');
export const adapterSource = join(adapterDir, 'Preview.tsx');
// Maintained overlay applied (patch -p1) to the staged upstream root before compiling.
export const upstreamPatch = join(adapterDir, 'upstream.patch');
export const ADAPTER_MODULE = 'McpPreview';

// Upstream inputs copied verbatim into the staging build (and the source archive).
export const UPSTREAM_ENTRIES = [
  'src',
  'patches',
  'package.json',
  'pnpm-lock.yaml',
  '.npmrc', // public-hoist-pattern for @rbxts scopes (bundled node_modules layout)
  'tsconfig.json',
  'default.project.json',
  'aftman.toml',
  'rokit.toml',
  'LICENSE',
  'README.md',
];

// Present in source-archive copies of vendor/ui-renderer, which have no .git.
export const PIN_MARKER = 'UPSTREAM_COMMIT';

function hasGitCheckout() {
  return existsSync(join(vendorDir, '.git'));
}

export function upstreamCommit() {
  if (!hasGitCheckout()) return readFileSync(join(vendorDir, PIN_MARKER), 'utf8').trim();
  return execFileSync('git', ['-C', vendorDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

function assertPinnedCheckout() {
  if (!existsSync(join(vendorDir, 'src')) || !existsSync(join(vendorDir, 'pnpm-lock.yaml'))) {
    throw new Error(
      `Story renderer submodule is not initialized at ${vendorDir}. Run: git submodule update --init vendor/ui-renderer`,
    );
  }
  if (!hasGitCheckout()) {
    if (!existsSync(join(vendorDir, PIN_MARKER))) {
      throw new Error(`${vendorDir} is neither a git checkout nor a source-archive copy with ${PIN_MARKER}`);
    }
    return;
  }
  const dirty = execFileSync('git', ['-C', vendorDir, 'status', '--porcelain'], { encoding: 'utf8' }).trim();
  if (dirty) {
    throw new Error(
      `vendor/ui-renderer has local changes; the renderer must build from the pinned commit.\n${dirty}`,
    );
  }
  if (!existsSync(adapterSource)) {
    throw new Error(`MCP preview adapter not found at ${adapterSource}`);
  }
}

function stageSources() {
  mkdirSync(stagingDir, { recursive: true });
  // Keep node_modules as an install cache; everything else is rebuilt from the pin.
  for (const name of [...UPSTREAM_ENTRIES, 'out', 'include', PIN_MARKER]) {
    rmSync(join(stagingDir, name), { recursive: true, force: true });
  }
  for (const name of UPSTREAM_ENTRIES) {
    const from = join(vendorDir, name);
    if (existsSync(from)) cpSync(from, join(stagingDir, name), { recursive: true });
  }
  // Adapter files: Preview.tsx -> src/McpPreview.tsx, X.ts(x) -> src/McpX.ts(x).
  for (const name of readdirSync(adapterDir)) {
    if (!/\.tsx?$/.test(name)) continue;
    const target = name === 'Preview.tsx' ? `${ADAPTER_MODULE}.tsx` : `Mcp${name}`;
    cpSync(join(adapterDir, name), join(stagingDir, 'src', target));
  }
  if (existsSync(upstreamPatch)) {
    console.log('[build-ui-renderer] applying studio-plugin/ui-renderer/upstream.patch');
    execFileSync('patch', ['-p1', '--forward', '--batch', '-d', stagingDir, '-i', upstreamPatch], {
      stdio: 'inherit',
    });
  }
  writeFileSync(join(stagingDir, PIN_MARKER), `${upstreamCommit()}\n`, 'utf8');
}

function run(args) {
  console.log(`[build-ui-renderer] pnpm ${args.join(' ')}`);
  execFileSync('pnpm', args, { cwd: stagingDir, stdio: 'inherit', shell: process.platform === 'win32' });
}

function main() {
  assertPinnedCheckout();
  stageSources();
  run(['install', '--frozen-lockfile']);
  run(['exec', 'rbxtsc']);
  const adapterOut = join(stagingDir, 'out', `${ADAPTER_MODULE}.luau`);
  if (!existsSync(adapterOut)) {
    throw new Error(`rbxtsc did not produce ${adapterOut}`);
  }
  console.log(`Built story renderer ${upstreamCommit()} with ${ADAPTER_MODULE} in ${stagingDir}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main();
  } catch (error) {
    console.error(`[build-ui-renderer] ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}
