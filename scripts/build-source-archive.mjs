#!/usr/bin/env node

/**
 * Builds the corresponding-source archive for the main Studio plugin
 * (MCPPlugin.rbxmx), which bundles the GPL-3.0 story renderer.
 *
 * Output: studio-plugin/MCPPlugin-source.tar.gz containing
 *   - mcp/: this repository's packages (core, server, inspector), Studio plugin
 *     source + adapter + upstream.patch, build scripts, configs, and lockfiles
 *     (git tracked + untracked-not-ignored files, or a bounded directory walk
 *     when no git checkout exists; no binaries or generated output)
 *   - mcp/vendor/ui-renderer/: the clean pinned upstream source, patches, configs,
 *     pnpm lockfile, and UPSTREAM_COMMIT pin marker
 *   - dependencies/: Luau/TypeScript sources, manifests, and licenses of the
 *     @rbxts / @rbxts-js packages bundled into the plugin
 *   - BUILDING.txt: pin, toolchain, and rebuild instructions
 *
 * Requires a completed `node scripts/build-ui-renderer.mjs` run.
 */

import { execFileSync } from 'child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { dirname, extname, join } from 'path';
import {
  ADAPTER_MODULE,
  PIN_MARKER,
  UPSTREAM_ENTRIES,
  rootDir,
  stagingDir,
  vendorDir,
} from './build-ui-renderer.mjs';

export const ARCHIVE_NAME = 'MCPPlugin-source.tar.gz';
const archivePath = join(rootDir, 'studio-plugin', ARCHIVE_NAME);
const { version: VERSION } = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8'));
const topName = `robloxstudio-mcp-plugin-${VERSION}-source`;
const workDir = join(rootDir, '.local', 'source-archive');
const topDir = join(workDir, topName);

// Own sources needed to rebuild the main plugin artifact.
const MCP_PATHSPECS = [
  '.gitmodules',
  'LICENSE',
  'README.md',
  'package.json',
  'package-lock.json',
  'tsconfig.base.json',
  'docs/building-from-source.md',
  'scripts/build-plugin.mjs',
  'scripts/build-ui-renderer.mjs',
  'scripts/build-source-archive.mjs',
  'scripts/prepack.mjs',
  'scripts/postpack.mjs',
  'scripts/package-staging.mjs',
  'studio-plugin',
  'packages/core',
  'packages/robloxstudio-mcp',
  'packages/robloxstudio-mcp-inspector',
];
// Skipped by the non-git walk: generated output, dependencies, VCS, staging.
const WALK_SKIP = new Set(['node_modules', 'dist', 'out', '.git', '.local', 'coverage']);
const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp', '.exe', '.dll', '.zip', '.gz', '.tgz',
  '.rbxm', '.rbxmx', '.rbxl', '.rbxlx',
]);
// Roblox resources that are source inputs of the distributed package
// (tsup copies packages/core/assets into dist/assets).
const SOURCE_RESOURCES = new Set(['packages/core/assets/Baseplate.rbxl']);
const DEPENDENCY_SKIP = new Set(['node_modules', '.git']);

function walkFiles(relPath, files) {
  const full = join(rootDir, relPath);
  if (!existsSync(full)) return;
  if (!statSync(full).isDirectory()) {
    files.push(relPath);
    return;
  }
  for (const entry of readdirSync(full, { withFileTypes: true })) {
    if (WALK_SKIP.has(entry.name) || entry.name.endsWith('.tsbuildinfo')) continue;
    walkFiles(`${relPath}/${entry.name}`, files);
  }
}

function listMcpFiles() {
  if (existsSync(join(rootDir, '.git'))) {
    const listed = execFileSync(
      'git',
      ['-C', rootDir, 'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...MCP_PATHSPECS],
      { encoding: 'utf8' },
    );
    return listed.split('\0').filter(Boolean);
  }
  // Rebuilding from an extracted source archive: no git available.
  const files = [];
  for (const spec of MCP_PATHSPECS) walkFiles(spec, files);
  return files;
}

function copyMcpSources() {
  const files = [...new Set(listMcpFiles())];
  for (const file of files) {
    if (BINARY_EXTENSIONS.has(extname(file).toLowerCase()) && !SOURCE_RESOURCES.has(file)) continue;
    const from = join(rootDir, file);
    if (!existsSync(from)) continue; // deleted in the worktree
    const to = join(topDir, 'mcp', file);
    mkdirSync(dirname(to), { recursive: true });
    cpSync(from, to);
  }
}

// Clean pinned upstream at mcp/vendor/ui-renderer with a pin marker instead of .git,
// so the archive rebuilds in place with no clone and no git.
function copyUpstreamSources(commit) {
  const dest = join(topDir, 'mcp', 'vendor', 'ui-renderer');
  for (const name of UPSTREAM_ENTRIES) {
    const from = join(vendorDir, name);
    if (existsSync(from)) cpSync(from, join(dest, name), { recursive: true });
  }
  writeFileSync(join(dest, PIN_MARKER), `${commit}\n`, 'utf8');
}

function copyDependencySources(scopeDir, destScopeDir) {
  if (!existsSync(scopeDir)) return [];
  const copied = [];
  for (const name of readdirSync(scopeDir).sort()) {
    const real = realpathSync(join(scopeDir, name));
    cpSync(real, join(destScopeDir, name), {
      recursive: true,
      dereference: true,
      filter: (src) => !DEPENDENCY_SKIP.has(src.slice(real.length + 1).split(/[\\/]/)[0]),
    });
    const manifest = JSON.parse(readFileSync(join(real, 'package.json'), 'utf8'));
    copied.push(`${manifest.name}@${manifest.version} (${manifest.license ?? 'see package'})`);
  }
  return copied;
}

function writeBuildingNotes(commit, dependencies) {
  const text = `Corresponding source for MCPPlugin.rbxmx (@chrrxs/robloxstudio-mcp ${VERSION})

MCPPlugin.rbxmx is a combined work distributed under GPL-3.0-only (see
mcp/vendor/ui-renderer/LICENSE). It bundles a GPL-3.0 story renderer
(commit ${commit}; attribution in mcp/packages/robloxstudio-mcp/NOTICE)
together with the Roblox Studio MCP plugin. The original MCP server and plugin
source is MIT (mcp/LICENSE); the renderer source, the preview adapter
(mcp/studio-plugin/ui-renderer/*.ts(x)), and its upstream.patch overlay are
GPL-3.0.

Layout
  mcp/                   MCP server package + Studio plugin source, build scripts,
                         configs, and lockfiles (package-lock.json,
                         studio-plugin/package-lock.json)
  mcp/vendor/ui-renderer/
                         Pinned upstream renderer source, patches, configs, and
                         pnpm-lock.yaml; ${PIN_MARKER} records the commit
  mcp/studio-plugin/ui-renderer/
                         MCP adapter (Preview.tsx -> src/${ADAPTER_MODULE}.tsx,
                         other X.ts(x) -> src/McpX.ts(x)) and the maintained
                         upstream.patch overlay applied at build time
  dependencies/          Sources, manifests, and licenses of bundled Luau packages

Toolchain: Node.js 22+, npm, pnpm 10 (lockfile v9; built with pnpm 10.24.0),
patch(1). Compiler versions are pinned by the included lockfiles
(roblox-ts via mcp/vendor/ui-renderer/pnpm-lock.yaml and
mcp/studio-plugin/package-lock.json).

Rebuild (no git or clone needed)
  1. cd mcp && npm install && npm --prefix studio-plugin install
  2. npm run build:plugin:artifact
     (compiles the plugin; scripts/build-ui-renderer.mjs stages vendor/ui-renderer
     into .local/ui-renderer-build, copies the adapter, applies upstream.patch, runs
     pnpm install --frozen-lockfile and pnpm exec rbxtsc; then writes
     studio-plugin/MCPPlugin.rbxmx and this archive)

Bundled packages
${dependencies.map((d) => `  ${d}`).join('\n')}
`;
  writeFileSync(join(topDir, 'BUILDING.txt'), text, 'utf8');
}

function main() {
  const commitFile = join(stagingDir, PIN_MARKER);
  if (!existsSync(join(stagingDir, 'out', `${ADAPTER_MODULE}.luau`)) || !existsSync(commitFile)) {
    throw new Error('Story renderer staging build missing. Run "node scripts/build-ui-renderer.mjs" first.');
  }
  const commit = readFileSync(commitFile, 'utf8').trim();

  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(topDir, { recursive: true });
  copyMcpSources();
  copyUpstreamSources(commit);
  const dependencies = [];
  for (const [base, label] of [
    [join(stagingDir, 'node_modules'), 'ui-renderer'],
    [join(rootDir, 'studio-plugin', 'node_modules'), 'mcp-plugin'],
  ]) {
    for (const scope of ['@rbxts', '@rbxts-js']) {
      dependencies.push(
        ...copyDependencySources(join(base, scope), join(topDir, 'dependencies', label, scope)),
      );
    }
  }
  writeBuildingNotes(commit, dependencies);

  rmSync(archivePath, { force: true });
  execFileSync('tar', ['-czf', archivePath, '-C', workDir, topName], { stdio: 'inherit' });
  rmSync(workDir, { recursive: true, force: true });
  console.log(`Built studio-plugin/${ARCHIVE_NAME} (story renderer ${commit})`);
}

try {
  main();
} catch (error) {
  console.error(`[build-source-archive] ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}
