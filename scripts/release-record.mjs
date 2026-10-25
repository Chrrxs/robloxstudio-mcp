// Release evidence: the record the live release gate writes for the tarballs it
// tested, and the pure checks publish.mjs applies before publishing them.

import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';

export const RELEASE_RECORD_KIND = 'robloxstudio-mcp-release-record';
export const RELEASE_RECORD_SCHEMA_VERSION = 1;
// Source-worktree locations (gitignored except the override log).
export const RELEASE_DIRECTORY = 'release';
export const RELEASE_RECORD_FILE = 'release-record.json';
export const RELEASE_ARTIFACTS_DIRECTORY = 'artifacts';
export const RELEASE_OVERRIDE_LOG = 'overrides.jsonl';
// Directory inside the managed snapshot where the gate writes its output.
export const RELEASE_OUTPUT_DIRECTORY = 'release-output';
export const RELEASE_OUTPUT_ENV = 'RSMCP_RELEASE_OUTPUT_DIR';
// A record older than this no longer represents the current Studio/Roblox
// environment closely enough to publish from.
export const RELEASE_RECORD_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const CLOCK_SKEW_MS = 5 * 60 * 1000;

export const PUBLISHED_PACKAGE_DIRECTORIES = ['packages/robloxstudio-mcp', 'packages/robloxstudio-mcp-inspector'];
export const VERSIONED_PACKAGE_DIRECTORIES = ['.', 'packages/core', ...PUBLISHED_PACKAGE_DIRECTORIES];

export function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/** Read package/package.json from an npm pack tarball without external tools. */
export function readTarballPackageJson(tarball) {
  const tar = gunzipSync(tarball);
  let offset = 0;
  let paxPath;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const field = (start, length) => {
      const raw = header.subarray(start, start + length);
      const end = raw.indexOf(0);
      return raw.subarray(0, end < 0 ? length : end).toString('utf8');
    };
    const size = Number.parseInt(field(124, 12).trim() || '0', 8);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error('Tarball has an invalid entry size');
    const type = field(156, 1);
    const prefix = field(257, 5) === 'ustar' ? field(345, 155) : '';
    const name = paxPath ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100));
    const body = tar.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
    if (type === 'x') {
      paxPath = /(?:^|\n)\d+ path=([^\n]*)\n/u.exec(body.toString('utf8'))?.[1];
      continue;
    }
    paxPath = undefined;
    if ((type === '0' || type === '') && name === 'package/package.json') return JSON.parse(body.toString('utf8'));
  }
  throw new Error('Tarball has no package/package.json');
}

export function describeTarball(file, contents) {
  const packageJson = readTarballPackageJson(contents);
  return { name: packageJson.name, version: packageJson.version, file, sha256: sha256(contents), size: contents.length };
}

/** Describe every .tgz in a directory, sorted by file name. */
export function describeReleaseArtifacts(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory).filter((file) => file.endsWith('.tgz')).sort()
    .map((file) => describeTarball(file, readFileSync(path.join(directory, file))));
}

function npmVersion(env, execPath) {
  const agent = /(?:^|\s)npm\/(\S+)/u.exec(env.npm_config_user_agent ?? '')?.[1];
  if (agent) return agent;
  const directory = path.dirname(execPath);
  for (const candidate of [
    path.join(directory, 'node_modules', 'npm', 'package.json'),
    path.join(directory, '..', 'lib', 'node_modules', 'npm', 'package.json'),
  ]) {
    try {
      const version = JSON.parse(readFileSync(candidate, 'utf8')).version;
      if (typeof version === 'string') return version;
    } catch {
      // Try the next layout.
    }
  }
  return 'unknown';
}

export function studioVersionFromExecutable(executable) {
  const directory = typeof executable === 'string' ? path.win32.basename(path.win32.dirname(executable)) : '';
  return /^version-[0-9a-f]+$/iu.test(directory) ? directory : 'unknown';
}

export function collectReleaseEnvironment({ env = process.env, resolveStudioExecutable, execPath = process.execPath } = {}) {
  let studio = 'unknown';
  try {
    if (resolveStudioExecutable) studio = studioVersionFromExecutable(resolveStudioExecutable());
  } catch {
    // Best effort; the gate itself fails if Studio cannot be launched.
  }
  return {
    os: { platform: os.platform(), release: os.release(), version: os.version(), arch: os.arch() },
    node: process.version,
    npm: npmVersion(env, execPath),
    studio: { version: studio },
  };
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

export function createReleaseRecord({ results, skipped, artifacts, artifactsError, environment, createdAt }) {
  const stages = [
    ...results.map(({ file, code, error }) => ({
      name: file.name,
      command: file.args,
      result: code === 0 ? 'passed' : 'failed',
      exitCode: code,
      ...(error ? { error: errorMessage(error) } : {}),
    })),
    ...skipped.map((stage) => ({ name: stage.name, command: stage.args, result: 'skipped', reason: 'release gate stopped after failure' })),
  ];
  const passed = stages.length > 0 && stages.every((stage) => stage.result === 'passed') && !artifactsError;
  return {
    kind: RELEASE_RECORD_KIND,
    schemaVersion: RELEASE_RECORD_SCHEMA_VERSION,
    createdAt,
    result: passed ? 'passed' : 'failed',
    artifacts,
    ...(artifactsError ? { artifactsError } : {}),
    environment,
    stages,
  };
}

const failure = (check, message) => ({ check, message });

/**
 * Pure release-evidence check. `readArtifact(file)` returns the tarball bytes
 * from the release artifacts directory, or undefined when absent.
 */
export function verifyReleaseEvidence({
  record,
  recordError,
  source,
  packages,
  readArtifact,
  now = Date.now(),
  maxAgeMs = RELEASE_RECORD_MAX_AGE_MS,
}) {
  const failures = [];
  if (!source.clean) failures.push(failure('tree-clean', 'The working tree has uncommitted or untracked changes.'));
  const versions = [...new Set(packages.map((pkg) => pkg.version))];
  if (versions.length !== 1) {
    failures.push(failure('versions', `package.json versions differ (${packages.map((pkg) => `${pkg.directory}=${pkg.version}`).join(', ')}); run npm run release:sync-versions and commit.`));
  }
  if (record === undefined || record === null || typeof record !== 'object' || Array.isArray(record)) {
    failures.push(failure('record', recordError ?? 'No release record found; run npm run test:e2e:full.'));
    return { ok: false, failures, artifacts: [] };
  }
  if (record.kind !== RELEASE_RECORD_KIND || record.schemaVersion !== RELEASE_RECORD_SCHEMA_VERSION) {
    failures.push(failure('record', `Unsupported release record (kind ${JSON.stringify(record.kind)}, schema ${JSON.stringify(record.schemaVersion)}).`));
    return { ok: false, failures, artifacts: [] };
  }

  const recordedCommit = record.source?.commit;
  if (typeof recordedCommit !== 'string' || !recordedCommit) {
    failures.push(failure('commit', 'The release record has no source commit; run the gate through npm run test:e2e:full.'));
  } else if (recordedCommit !== source.commit) {
    failures.push(failure('commit', `The release record is for commit ${recordedCommit}, but HEAD is ${source.commit}.`));
  }
  if (record.source?.clean !== true) {
    failures.push(failure('source-clean', 'The gate ran on a working tree with uncommitted or untracked changes.'));
  }

  const createdAt = Date.parse(record.createdAt);
  if (!Number.isFinite(createdAt)) {
    failures.push(failure('age', 'The release record has no valid timestamp.'));
  } else if (createdAt - now > CLOCK_SKEW_MS) {
    failures.push(failure('age', `The release record timestamp ${record.createdAt} is in the future.`));
  } else if (now - createdAt > maxAgeMs) {
    failures.push(failure('age', `The release record from ${record.createdAt} is older than ${Math.round(maxAgeMs / 3_600_000)} hours.`));
  }

  if (record.result !== 'passed') failures.push(failure('result', `The release gate result is ${JSON.stringify(record.result)}, not "passed".`));

  if (!Array.isArray(record.stages) || record.stages.length === 0) {
    failures.push(failure('stages', 'The release record lists no stages.'));
  } else {
    for (const stage of record.stages) {
      if (stage?.result === 'passed') continue;
      const verb = stage?.result === 'skipped' ? 'was skipped' : stage?.result === 'failed' ? 'failed' : `has result ${JSON.stringify(stage?.result)}`;
      failures.push(failure('stages', `Stage ${JSON.stringify(stage?.name)} ${verb}.`));
    }
  }

  const recordedArtifacts = Array.isArray(record.artifacts) ? record.artifacts : [];
  const published = packages.filter((pkg) => PUBLISHED_PACKAGE_DIRECTORIES.includes(pkg.directory));
  for (const artifact of recordedArtifacts) {
    if (!published.some((pkg) => pkg.name === artifact?.name)) {
      failures.push(failure('artifacts', `The release record contains an unexpected artifact ${JSON.stringify(artifact?.file ?? artifact?.name)}.`));
    }
  }
  const verified = [];
  for (const pkg of published) {
    const matches = recordedArtifacts.filter((artifact) => artifact?.name === pkg.name);
    if (matches.length !== 1) {
      failures.push(failure('artifacts', `The release record has ${matches.length} tarballs for ${pkg.name}; expected exactly one.`));
      continue;
    }
    const [artifact] = matches;
    if (artifact.version !== pkg.version) {
      failures.push(failure('versions', `The tested ${pkg.name} tarball is v${artifact.version}, but ${pkg.directory}/package.json is v${pkg.version}.`));
    }
    const file = artifact.file;
    if (typeof file !== 'string' || !/^[A-Za-z0-9@._-]+\.tgz$/u.test(file)) {
      failures.push(failure('artifacts', `The release record names an invalid tarball ${JSON.stringify(file)} for ${pkg.name}.`));
      continue;
    }
    const contents = readArtifact(file);
    if (contents === undefined) {
      failures.push(failure('artifacts', `The tested tarball ${file} is missing from ${RELEASE_DIRECTORY}/${RELEASE_ARTIFACTS_DIRECTORY}.`));
      continue;
    }
    const digest = sha256(contents);
    if (digest !== artifact.sha256 || contents.length !== artifact.size) {
      failures.push(failure('artifacts', `${file} does not match the tested tarball (sha256 ${digest}, ${contents.length} bytes; recorded ${artifact.sha256}, ${artifact.size} bytes).`));
      continue;
    }
    let packageJson;
    try {
      packageJson = readTarballPackageJson(contents);
    } catch (error) {
      failures.push(failure('artifacts', `${file} is not a readable npm tarball: ${errorMessage(error)}`));
      continue;
    }
    if (packageJson.name !== artifact.name || packageJson.version !== artifact.version) {
      failures.push(failure('artifacts', `${file} contains ${packageJson.name}@${packageJson.version}, but the record says ${artifact.name}@${artifact.version}.`));
      continue;
    }
    verified.push({ name: artifact.name, version: artifact.version, file, sha256: digest, size: contents.length });
  }
  return { ok: failures.length === 0, failures, artifacts: verified };
}

/** Load the inputs for verifyReleaseEvidence from a source worktree. */
export function loadReleaseEvidence({ rootDir, git }) {
  const releaseDirectory = path.join(rootDir, RELEASE_DIRECTORY);
  const artifactsDirectory = path.join(releaseDirectory, RELEASE_ARTIFACTS_DIRECTORY);
  const recordPath = path.join(releaseDirectory, RELEASE_RECORD_FILE);
  let record;
  let recordError;
  if (existsSync(recordPath)) {
    try {
      record = JSON.parse(readFileSync(recordPath, 'utf8'));
    } catch (error) {
      recordError = `The release record at ${recordPath} is unreadable: ${errorMessage(error)}`;
    }
  } else {
    recordError = `No release record at ${path.join(RELEASE_DIRECTORY, RELEASE_RECORD_FILE)}; run npm run test:e2e:full.`;
  }
  const packages = VERSIONED_PACKAGE_DIRECTORIES.map((directory) => {
    const packageJson = JSON.parse(readFileSync(path.join(rootDir, directory, 'package.json'), 'utf8'));
    return { directory, name: packageJson.name, version: packageJson.version };
  });
  return {
    record,
    recordError,
    source: readSourceState(rootDir, git),
    packages,
    artifactsDirectory,
    readArtifact(file) {
      const filename = path.join(artifactsDirectory, file);
      return existsSync(filename) && statSync(filename).isFile() ? readFileSync(filename) : undefined;
    },
  };
}

/** `git(args, cwd)` returns stdout. Ignored files (including release/) do not count as dirty. */
export function readSourceState(cwd, git) {
  const commit = git(['rev-parse', 'HEAD'], cwd).trim();
  const status = git(['status', '--porcelain', '--untracked-files=all'], cwd).trim();
  return { commit, clean: status === '' };
}

export function createOverrideEntry({ timestamp, user, reason, source, packages, failures, artifacts }) {
  return {
    timestamp,
    user,
    reason,
    commit: source.commit,
    treeClean: source.clean,
    versions: Object.fromEntries(packages.map((pkg) => [pkg.name, pkg.version])),
    bypassedChecks: failures,
    artifacts: artifacts.map(({ name, version, file, sha256: digest, size }) => ({ name, version, file, sha256: digest, size })),
  };
}

/** Remove the previous record and tarballs so a new gate run cannot leave stale evidence behind. */
export function clearReleaseEvidence(releaseDirectory) {
  rmSync(path.join(releaseDirectory, RELEASE_RECORD_FILE), { force: true });
  rmSync(path.join(releaseDirectory, RELEASE_ARTIFACTS_DIRECTORY), { recursive: true, force: true });
}

/**
 * Copy the gate output from the snapshot back into the source worktree and bind
 * it to the source state the outer harness observed before exporting.
 */
export function collectReleaseOutput({ outputDirectory, releaseDirectory, source }) {
  const recordPath = path.join(outputDirectory, RELEASE_RECORD_FILE);
  if (!existsSync(recordPath)) throw new Error('The release gate wrote no record; it did not reach the end of tests/run-release.mjs.');
  const record = JSON.parse(readFileSync(recordPath, 'utf8'));
  if (record?.kind !== RELEASE_RECORD_KIND || !Array.isArray(record.artifacts)) throw new Error('The gate wrote an invalid release record.');
  clearReleaseEvidence(releaseDirectory);
  const artifactsDirectory = path.join(releaseDirectory, RELEASE_ARTIFACTS_DIRECTORY);
  mkdirSync(artifactsDirectory, { recursive: true });
  for (const artifact of record.artifacts) {
    if (typeof artifact?.file !== 'string' || !/^[A-Za-z0-9@._-]+\.tgz$/u.test(artifact.file)) {
      throw new Error(`The gate recorded an invalid tarball name ${JSON.stringify(artifact?.file)}.`);
    }
    copyFileSync(path.join(outputDirectory, RELEASE_ARTIFACTS_DIRECTORY, artifact.file), path.join(artifactsDirectory, artifact.file));
  }
  const bound = { ...record, source };
  writeFileSync(path.join(releaseDirectory, RELEASE_RECORD_FILE), `${JSON.stringify(bound, null, 2)}\n`);
  return bound;
}
