#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync,
  symlinkSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prepareStudioTestSnapshot } from '../scripts/studio-test-snapshot.mjs';

const directory = mkdtempSync(path.join(os.tmpdir(), 'rsmcp-snapshot-tests-'));
const sourceDirectory = path.join(directory, 'working tree ü');
const destinationParent = path.join(directory, 'exports');

function put(relative, content, root = sourceDirectory) {
  const filename = path.join(root, relative);
  mkdirSync(path.dirname(filename), { recursive: true });
  writeFileSync(filename, content);
}

function git(...args) {
  return execFileSync('git', args, { cwd: sourceDirectory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function files(root, prefix = '') {
  return readdirSync(path.join(root, prefix), { withFileTypes: true })
    .flatMap((entry) => {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      return entry.isDirectory() ? files(root, relative) : [relative];
    }).sort();
}

try {
  mkdirSync(sourceDirectory);
  git('init', '--quiet');
  put('.gitignore', 'node_modules/\ndist/\nignored/\n.env*\n');
  put('package.json', '{"name":"snapshot-fixture","private":true}\n');
  put('package-lock.json', '{"lockfileVersion":3}\n');
  put('src/current file ü.ts', 'export const value = "indexed";\n');
  put('src/deleted.ts', 'deleted after staging\n');
  put('assets/plugin.rbxm', Buffer.from([0, 1, 255, 128]));
  put('docs/source.md', 'Tracked source documentation\n');
  put('scripts/helper.mjs', 'export const helper = true;\n');
  put('.studio-test-snapshot.json', '{"version":99,"sourceFiles":["../outside.ts"]}\n');
  git('add', '.');

  // Even a mistakenly tracked credential or platform dependency is not exported.
  const privateFiles = [
    '.env', '.env.production', '.envrc', '.npmrc', '.npmrc.backup', '.yarnrc.yml',
    'config/local.env', 'config/private.key', 'config/certificate.pem',
    'config/credentials.json', 'config/.credentials', 'config/secrets.production.json',
    'config/token.json', '.git-credentials', '.netrc', '.aws/credentials',
    '.ssh/id_ed25519', '.claude.json', '.codex/auth.json', 'mcp.json',
    'node_modules/native.node', 'dist/compiled.js', 'studio-plugin/out/main.lua',
  ];
  for (const filename of privateFiles) put(filename, 'must never leave source\n');
  git('add', '--force', '--', ...privateFiles);
  put('src/current file ü.ts', 'export const value = "uncommitted";\n');
  rmSync(path.join(sourceDirectory, 'src/deleted.ts'));
  put('src/untracked source.ts', 'export const untracked = true;\n');
  put('ignored/not-source.ts', 'ignored content\n');
  put('node_modules/untracked.node', 'platform-specific dependency\n');
  put('config/secrets.yaml', 'untracked credential\n');

  const expected = [
    '.studio-test-snapshot.json',
    '.gitignore', 'assets/plugin.rbxm', 'docs/source.md', 'package-lock.json',
    'package.json', 'scripts/helper.mjs', 'src/current file ü.ts', 'src/untracked source.ts',
  ].sort();
  const snapshots = await Promise.all(Array.from({ length: 3 }, () => prepareStudioTestSnapshot({
    sourceDirectory,
    destinationParent,
  })));
  assert.equal(new Set(snapshots.map(({ workingDirectory }) => workingDirectory)).size, 3,
    'concurrent exports own different directories');
  for (const snapshot of snapshots) {
    // Windows TEMP may contain an 8.3 alias; snapshots return canonical paths.
    assert.equal(path.dirname(snapshot.workingDirectory), realpathSync.native(destinationParent));
    assert.match(path.basename(snapshot.workingDirectory), /^snapshot-[A-Za-z0-9]+$/,
      'exports satisfy the Windows managed-snapshot permission boundary');
    assert.deepEqual(files(snapshot.workingDirectory), expected,
      'exports current source and tracked assets, not Git metadata, credentials or dependencies');
    assert.equal(readFileSync(path.join(snapshot.workingDirectory, 'src/current file ü.ts'), 'utf8'),
      'export const value = "uncommitted";\n');
    assert.deepEqual(readFileSync(path.join(snapshot.workingDirectory, 'assets/plugin.rbxm')),
      Buffer.from([0, 1, 255, 128]));
  }
  put('src/current file ü.ts', 'worker-local edit\n', snapshots[0].workingDirectory);
  assert.equal(readFileSync(path.join(sourceDirectory, 'src/current file ü.ts'), 'utf8'),
    'export const value = "uncommitted";\n', 'snapshot writes cannot mutate source');
  assert.equal(readFileSync(path.join(snapshots[1].workingDirectory, 'src/current file ü.ts'), 'utf8'),
    'export const value = "uncommitted";\n', 'snapshot writes cannot mutate another worker');
  await snapshots[0].cleanup();
  await snapshots[0].cleanup();
  assert.equal(existsSync(snapshots[0].workingDirectory), false);
  assert.deepEqual(files(snapshots[1].workingDirectory), expected, 'cleanup leaves other workers intact');

  const exportedSource = snapshots[1].workingDirectory;
  put('src/current file ü.ts', 'edited exported source\n', exportedSource);
  put('src/not-in-manifest.ts', 'not approved source\n', exportedSource);
  put('.env', 'private runtime value\n', exportedSource);
  put('node_modules/runtime.node', 'installed dependency\n', exportedSource);
  rmSync(path.join(exportedSource, 'docs/source.md'));
  const reexported = await prepareStudioTestSnapshot({ sourceDirectory: exportedSource, destinationParent });
  assert.notEqual(reexported.workingDirectory, exportedSource);
  assert.deepEqual(files(reexported.workingDirectory), expected.filter((filename) => filename !== 'docs/source.md'),
    'manifest re-export copies only approved source, omits deleted files and regenerates metadata');
  assert.equal(readFileSync(path.join(reexported.workingDirectory, 'src/current file ü.ts'), 'utf8'),
    'edited exported source\n', 'manifest export reads current contents instead of stale source copies');
  const generatedManifest = JSON.parse(readFileSync(path.join(reexported.workingDirectory, '.studio-test-snapshot.json'), 'utf8'));
  assert.equal(generatedManifest.version, 1);
  assert.deepEqual([...generatedManifest.sourceFiles].sort(),
    expected.filter((filename) => !['docs/source.md', '.studio-test-snapshot.json'].includes(filename)));
  assert.deepEqual([...reexported.sourceFiles].sort(), [...generatedManifest.sourceFiles].sort());
  await reexported.cleanup();

  for (const destination of [sourceDirectory, path.join(sourceDirectory, 'new', 'exports')]) {
    await assert.rejects(prepareStudioTestSnapshot({ sourceDirectory, destinationParent: destination }), /outside the source/);
  }
  assert.equal(existsSync(path.join(sourceDirectory, 'new')), false,
    'invalid destination is rejected before creating directories inside source');
  const alias = path.join(directory, 'source-alias');
  symlinkSync(sourceDirectory, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(prepareStudioTestSnapshot({ sourceDirectory, destinationParent: path.join(alias, 'exports') }),
    /outside the source/, 'destination aliases cannot place exports inside source');
  await assert.rejects(prepareStudioTestSnapshot({ sourceDirectory: alias, destinationParent }), /symlink/);
  await assert.rejects(prepareStudioTestSnapshot({ sourceDirectory: path.join(sourceDirectory, 'src'), destinationParent }),
    /root of a Git working tree/);

  const existingWorkers = readdirSync(destinationParent).sort();
  const outside = path.join(directory, 'outside');
  mkdirSync(outside);
  put('sensitive.ts', 'outside content\n', outside);
  const link = path.join(sourceDirectory, 'src/untracked-link.ts');
  let fileSymlinkCreated = false;
  try {
    symlinkSync(path.join(outside, 'sensitive.ts'), link, 'file');
    fileSymlinkCreated = true;
  } catch (error) {
    if (process.platform !== 'win32' || !['EPERM', 'EACCES'].includes(error.code)) throw error;
    console.log(`Skipping file-symlink rejection fixture: Windows symlink privilege unavailable (${error.code}); directory junction security fixtures still run`);
  }
  if (fileSymlinkCreated) {
    await assert.rejects(prepareStudioTestSnapshot({ sourceDirectory, destinationParent }), /symlink/);
    assert.deepEqual(readdirSync(destinationParent).sort(), existingWorkers,
      'partial failed snapshots are removed without deleting other workers');
    rmSync(link);
  }

  // A tracked parent replaced by a directory symlink must not be traversed.
  rmSync(path.join(sourceDirectory, 'src'), { recursive: true });
  put('current file ü.ts', 'outside replacement\n', outside);
  symlinkSync(outside, path.join(sourceDirectory, 'src'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(prepareStudioTestSnapshot({ sourceDirectory, destinationParent }), /symlink/);
  assert.deepEqual(readdirSync(destinationParent).sort(), existingWorkers);
  assert.equal(readFileSync(path.join(outside, 'current file ü.ts'), 'utf8'), 'outside replacement\n');
  rmSync(path.join(sourceDirectory, 'src'));
  put('src/current file ü.ts', 'restored source\n');

  // Backslashes are legal on Linux but traversal separators on the target host.
  if (process.platform !== 'win32') {
    put('..\\escaped.ts', 'must not escape\n');
    await assert.rejects(prepareStudioTestSnapshot({ sourceDirectory, destinationParent }), /Unsafe snapshot source path/);
    assert.equal(existsSync(path.join(destinationParent, 'escaped.ts')), false);
    assert.deepEqual(readdirSync(destinationParent).sort(), existingWorkers);
    rmSync(path.join(sourceDirectory, '..\\escaped.ts'));
    put('Case/one.ts', 'one\n');
    put('case/two.ts', 'two\n');
    await assert.rejects(prepareStudioTestSnapshot({ sourceDirectory, destinationParent }), /case-colliding/);
    assert.deepEqual(readdirSync(destinationParent).sort(), existingWorkers);
    rmSync(path.join(sourceDirectory, 'Case'), { recursive: true });
    rmSync(path.join(sourceDirectory, 'case'), { recursive: true });
  }

  // Linked worktrees use a .git file instead of a directory; no history is copied.
  const gitDirectory = path.join(directory, 'separate-git');
  const linkedSource = path.join(directory, 'gitfile-source');
  mkdirSync(linkedSource);
  execFileSync('git', ['init', '--quiet', '--separate-git-dir', gitDirectory, linkedSource], { stdio: 'pipe' });
  put('source.ts', 'export const linked = true;\n', linkedSource);
  const linkedSnapshot = await prepareStudioTestSnapshot({ sourceDirectory: linkedSource, destinationParent });
  assert.deepEqual(files(linkedSnapshot.workingDirectory), ['.studio-test-snapshot.json', 'source.ts']);
  await linkedSnapshot.cleanup();

  const manifestSource = path.join(directory, 'manifest-source');
  mkdirSync(manifestSource);
  put('source.ts', 'manifest source\n', manifestSource);
  await assert.rejects(prepareStudioTestSnapshot({ sourceDirectory: manifestSource, destinationParent }),
    /requires a Git working tree or/);
  for (const unsafe of ['../outside/sensitive.ts', '..\\outside\\sensitive.ts', '/outside/sensitive.ts']) {
    put('.studio-test-snapshot.json', JSON.stringify({ version: 1, sourceFiles: [unsafe] }), manifestSource);
    await assert.rejects(prepareStudioTestSnapshot({ sourceDirectory: manifestSource, destinationParent }),
      /Unsafe snapshot source path/);
    assert.deepEqual(readdirSync(destinationParent).sort(), existingWorkers);
  }
  put('.studio-test-snapshot.json', '{"version":2,"sourceFiles":["source.ts"]}', manifestSource);
  await assert.rejects(prepareStudioTestSnapshot({ sourceDirectory: manifestSource, destinationParent }),
    /Invalid snapshot manifest/);
  symlinkSync(outside, path.join(manifestSource, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  put('.studio-test-snapshot.json', '{"version":1,"sourceFiles":["escape/sensitive.ts"]}', manifestSource);
  await assert.rejects(prepareStudioTestSnapshot({ sourceDirectory: manifestSource, destinationParent }), /symlink/);
  put('.env', 'must remain private\n', manifestSource);
  put('.npmrc', 'must remain private\n', manifestSource);
  put('.studio-test-snapshot.json',
    '{"version":1,"sourceFiles":["source.ts",".env",".npmrc",".studio-test-snapshot.json"]}', manifestSource);
  const filteredManifest = await prepareStudioTestSnapshot({ sourceDirectory: manifestSource, destinationParent });
  assert.deepEqual(files(filteredManifest.workingDirectory), ['.studio-test-snapshot.json', 'source.ts'],
    'manifest entries cannot override credential exclusion or supply generated metadata');
  assert.deepEqual(filteredManifest.sourceFiles, ['source.ts']);
  await filteredManifest.cleanup();
  put('.git', 'gitdir: missing-git-directory\n', manifestSource);
  await assert.rejects(prepareStudioTestSnapshot({ sourceDirectory: manifestSource, destinationParent }), /git/i,
    'a broken Git repository must not silently fall back to its manifest');
  await Promise.all(snapshots.slice(1).map((snapshot) => snapshot.cleanup()));
  assert.deepEqual(readdirSync(destinationParent), [], 'successful cleanup removes only owned exports');
} finally {
  rmSync(directory, { recursive: true, force: true });
}

console.log('Studio test snapshot tests passed');
