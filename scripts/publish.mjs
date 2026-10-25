#!/usr/bin/env node

// Publishes the exact tarballs the live release gate tested. It never edits
// package.json or rebuilds: run `npm run release:sync-versions`, commit, run
// `npm run test:e2e:full`, then `npm run publish:all`.

import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  createOverrideEntry,
  describeTarball,
  loadReleaseEvidence,
  PUBLISHED_PACKAGE_DIRECTORIES,
  RELEASE_DIRECTORY,
  RELEASE_OVERRIDE_LOG,
  RELEASE_RECORD_MAX_AGE_MS,
  verifyReleaseEvidence,
} from './release-record.mjs';

const USAGE = [
  'Usage: npm run publish:all [-- --dry-run]',
  '       npm run publish:all -- --emergency-override --reason "why the release gate is bypassed" [--dry-run]',
].join('\n');

export function parsePublishArguments(argv) {
  const options = { dryRun: false, override: false, reason: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run' || arg === '--verify-only') {
      options.dryRun = true;
    } else if (arg === '--emergency-override') {
      options.override = true;
    } else if (arg === '--reason') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`--reason needs a value.\n${USAGE}`);
      options.reason = value;
      index += 1;
    } else if (arg.startsWith('--reason=')) {
      options.reason = arg.slice('--reason='.length);
    } else {
      throw new Error(`Unknown option ${arg}.\n${USAGE}`);
    }
  }
  if (options.reason !== undefined && !options.override) throw new Error(`--reason is only valid with --emergency-override.\n${USAGE}`);
  if (options.override && !options.reason?.trim()) {
    throw new Error(`--emergency-override requires --reason "<why the release gate is bypassed>".\n${USAGE}`);
  }
  return options;
}

function packedTarball(stdout, directory) {
  const packed = stdout.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line.endsWith('.tgz')).pop();
  if (!packed) throw new Error(`npm pack output did not include a tgz name:\n${stdout}`);
  return path.isAbsolute(packed) ? packed : path.join(directory, packed);
}

// Only an override without usable recorded tarballs builds anything. It uses
// artifact-only plugin builds, so no plugin is installed into Studio.
function buildOverrideTarballs({ rootDir, run, timestamp }) {
  const directory = path.join(rootDir, RELEASE_DIRECTORY, `override-${timestamp.replace(/[^0-9A-Za-z]/gu, '')}`);
  mkdirSync(directory, { recursive: true });
  run('npm', ['run', 'build']);
  run('npm', ['run', 'build:plugin:artifact']);
  run(process.execPath, ['scripts/build-plugin.mjs', '--variant', 'inspector', '--build-only']);
  const artifacts = PUBLISHED_PACKAGE_DIRECTORIES.map((workspace) => {
    const tarball = packedTarball(run('npm', ['pack', '-w', workspace, '--pack-destination', directory], { capture: true }), directory);
    return { ...describeTarball(path.basename(tarball), readFileSync(tarball)), path: tarball };
  });
  return artifacts;
}

function publishTarballs(artifacts, { run, log, dryRun }) {
  if (dryRun) {
    log('\nDry run: would publish');
    for (const artifact of artifacts) log(`  npm publish ${artifact.path}`);
    return 0;
  }
  for (const artifact of artifacts) {
    log(`\nPublishing ${artifact.name}@${artifact.version} from ${artifact.file}...`);
    run('npm', ['publish', artifact.path]);
  }
  log('\nAll packages published successfully!');
  return 0;
}

/**
 * `git(args, cwd)` returns stdout; `run(command, args, { capture })` runs a
 * command in rootDir, throws on failure, and returns stdout when captured.
 */
export function runPublish({
  argv,
  rootDir,
  git,
  run,
  log = console.log,
  warn = console.error,
  now = () => new Date(),
  user = currentUser,
  maxAgeMs = RELEASE_RECORD_MAX_AGE_MS,
}) {
  const options = parsePublishArguments(argv);
  const evidence = loadReleaseEvidence({ rootDir, git });
  const verification = verifyReleaseEvidence({ ...evidence, now: now().getTime(), maxAgeMs });
  const withPaths = (artifacts) => artifacts.map((artifact) => ({ ...artifact, path: path.join(evidence.artifactsDirectory, artifact.file) }));

  if (verification.ok) {
    const { record } = evidence;
    log(`Release evidence verified for ${evidence.source.commit}:`);
    log(`  gate passed ${record.createdAt} on ${record.environment?.os?.platform ?? 'unknown'} ${record.environment?.os?.release ?? ''}, Node ${record.environment?.node ?? 'unknown'}, npm ${record.environment?.npm ?? 'unknown'}, Studio ${record.environment?.studio?.version ?? 'unknown'}`);
    for (const artifact of verification.artifacts) log(`  ${artifact.name}@${artifact.version}  ${artifact.file}  sha256 ${artifact.sha256}`);
    if (options.override) log('Evidence is valid; the emergency override was not needed and is not logged.');
    return publishTarballs(withPaths(verification.artifacts), { run, log, dryRun: options.dryRun });
  }

  const report = verification.failures.map((item) => `  [${item.check}] ${item.message}`);
  if (!options.override) {
    warn('Refusing to publish: the release evidence is missing, stale, failed, or does not match this checkout.');
    for (const line of report) warn(line);
    warn('\nRelease flow: npm run release:sync-versions -- <version>, commit, npm run test:e2e:full, npm run publish:all.');
    return 1;
  }

  warn('EMERGENCY OVERRIDE: publishing without valid release evidence. Bypassed checks:');
  for (const line of report) warn(line);
  warn(`Reason: ${options.reason.trim()}`);
  const reuse = verification.artifacts.length === PUBLISHED_PACKAGE_DIRECTORIES.length &&
    !verification.failures.some((item) => item.check === 'artifacts');
  if (options.dryRun) {
    log(reuse ? 'Dry run: would publish the recorded tarballs.' : 'Dry run: would build and pack fresh tarballs.');
    log('Dry run: no override was logged and nothing was published.');
    return 0;
  }
  const timestamp = now().toISOString();
  const artifacts = reuse ? withPaths(verification.artifacts) : buildOverrideTarballs({ rootDir, run, timestamp });
  const entry = createOverrideEntry({
    timestamp,
    user: user(),
    reason: options.reason.trim(),
    source: evidence.source,
    packages: evidence.packages,
    failures: verification.failures,
    artifacts,
  });
  const logPath = path.join(rootDir, RELEASE_DIRECTORY, RELEASE_OVERRIDE_LOG);
  mkdirSync(path.dirname(logPath), { recursive: true });
  appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
  warn(`Override recorded in ${path.join(RELEASE_DIRECTORY, RELEASE_OVERRIDE_LOG)}; commit it with the release.`);
  return publishTarballs(artifacts, { run, log, dryRun: false });
}

function currentUser() {
  try {
    return os.userInfo().username;
  } catch {
    return process.env.USER ?? process.env.USERNAME ?? 'unknown';
  }
}

function createRunner(rootDir) {
  return (command, args, { capture = false } = {}) => {
    // Through `npm run`, npm_execpath names npm's JS entry point; invoking it
    // with Node avoids Windows npm.cmd shell quoting of tarball paths.
    const npmCli = command === 'npm' && /\.c?js$/u.test(process.env.npm_execpath ?? '') ? process.env.npm_execpath : undefined;
    console.log(`> ${command} ${args.join(' ')}`);
    const result = spawnSync(npmCli ? process.execPath : command, npmCli ? [npmCli, ...args] : args, {
      cwd: rootDir,
      encoding: 'utf8',
      stdio: capture ? ['inherit', 'pipe', 'inherit'] : 'inherit',
      shell: !npmCli && command === 'npm' && process.platform === 'win32',
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed with ${result.status ?? result.signal}.`);
    return capture ? result.stdout : '';
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  try {
    process.exitCode = runPublish({
      argv: process.argv.slice(2),
      rootDir,
      git: (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8' }),
      run: createRunner(rootDir),
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
