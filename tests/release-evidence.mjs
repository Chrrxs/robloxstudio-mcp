#!/usr/bin/env node

// Offline coverage for the release record (run-release + profile harness) and
// the publish gate. No Studio, npm registry, or real git history is touched.

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import {
  readTarballPackageJson,
  RELEASE_OUTPUT_DIRECTORY,
  RELEASE_OUTPUT_ENV,
  sha256,
  studioVersionFromExecutable,
  verifyReleaseEvidence,
} from '../scripts/release-record.mjs';
import { parsePublishArguments, runPublish } from '../scripts/publish.mjs';
import { syncVersions } from '../scripts/sync-versions.mjs';
import {
  beginReleaseRecord,
  confirmReleaseSource,
  finishReleaseRecord,
  isReleaseGateCommand,
  runTestProfilePayload,
} from '../scripts/studio-test-profile.mjs';
import { exportReleaseArtifact } from './auto-install-plugin-e2e.mjs';
import { runRelease } from './run-release.mjs';

const VERSION = '9.8.7';
const MAIN = '@chrrxs/robloxstudio-mcp';
const INSPECTOR = '@chrrxs/robloxstudio-mcp-inspector';
const COMMIT = 'a'.repeat(40);
const NOW = new Date('2026-10-25T12:00:00.000Z');
const temporaryRoots = [];

function temporaryDirectory(prefix) {
  const directory = mkdtempSync(path.join(tmpdir(), `rsmcp-release-${prefix}-`));
  temporaryRoots.push(directory);
  return directory;
}

function tarEntry(name, body, type = '0') {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf8');
  header.write('0000644\0', 100, 'ascii');
  header.write('0000000\0', 108, 'ascii');
  header.write('0000000\0', 116, 'ascii');
  header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124, 'ascii');
  header.write('00000000000\0', 136, 'ascii');
  header.write(type, 156, 'ascii');
  header.write('ustar\0', 257, 'ascii');
  header.write('00', 263, 'ascii');
  header.fill(' ', 148, 156);
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
  return Buffer.concat([header, body, Buffer.alloc(Math.ceil(body.length / 512) * 512 - body.length)]);
}

function tarball({ name, version, extra = 'dist' }) {
  const pax = Buffer.from('27 comment=npm pack fixture\n');
  return gzipSync(Buffer.concat([
    tarEntry('package/', Buffer.alloc(0), '5'),
    tarEntry('PaxHeader', pax, 'x'),
    tarEntry('package/dist/index.js', Buffer.from(`// ${extra}\n`)),
    tarEntry('package/package.json', Buffer.from(JSON.stringify({ name, version }))),
    Buffer.alloc(1024),
  ]));
}

function tarballFile(name, version) {
  return `${name.replace('@', '').replace('/', '-')}-${version}.tgz`;
}

// ---- tarball reader ----
assert.deepEqual(readTarballPackageJson(tarball({ name: MAIN, version: VERSION })), { name: MAIN, version: VERSION });
assert.throws(() => readTarballPackageJson(gzipSync(Buffer.concat([tarEntry('package/README.md', Buffer.from('x')), Buffer.alloc(1024)]))),
  /no package\/package.json/);
assert.equal(studioVersionFromExecutable('C:\\Users\\StudioTests\\AppData\\Local\\Roblox\\Versions\\version-0123abcd\\RobloxStudioBeta.exe'), 'version-0123abcd');
assert.equal(studioVersionFromExecutable('/Applications/RobloxStudio.app/Contents/MacOS/RobloxStudio'), 'unknown');
assert.equal(studioVersionFromExecutable(undefined), 'unknown');

// ---- run-release writes a record for pass and failure ----
const ENVIRONMENT = { os: { platform: 'win32', release: '10.0.26100' }, node: 'v22.0.0', npm: '10.9.0', studio: { version: 'version-0123abcd' } };

async function gate({ failAt, exportTarballs = true, stale = false } = {}) {
  const outputDirectory = path.join(temporaryDirectory('gate'), RELEASE_OUTPUT_DIRECTORY);
  if (stale) {
    mkdirSync(path.join(outputDirectory, 'artifacts'), { recursive: true });
    writeFileSync(path.join(outputDirectory, 'release-record.json'), '{"stale":true}');
    writeFileSync(path.join(outputDirectory, 'artifacts', 'old-1.0.0.tgz'), 'old');
  }
  const packDirectory = temporaryDirectory('pack');
  const env = { RSMCP_STUDIO_TEST_PREPARED: '1' };
  let stage = 0;
  const result = await runRelease({
    env,
    outputDirectory,
    log: () => {},
    now: () => NOW,
    collectEnvironment: () => ENVIRONMENT,
    async execute(_command, _args, options) {
      stage += 1;
      assert.equal(options.env[RELEASE_OUTPUT_ENV], outputDirectory, 'every stage can locate the release output');
      assert.equal(options.env.RSMCP_STUDIO_TEST_PREPARED, '1');
      if (stage === 1 && exportTarballs) {
        for (const name of [MAIN, INSPECTOR]) {
          const file = path.join(packDirectory, tarballFile(name, VERSION));
          writeFileSync(file, tarball({ name, version: VERSION }));
          exportReleaseArtifact(file, options.env);
        }
      }
      return { code: stage === failAt ? 3 : 0 };
    },
  });
  const written = existsSync(path.join(outputDirectory, 'release-record.json'))
    ? JSON.parse(readFileSync(path.join(outputDirectory, 'release-record.json'), 'utf8'))
    : undefined;
  return { result, written, outputDirectory, packDirectory };
}

{
  const { result, written, outputDirectory } = await gate({ stale: true });
  assert.equal(result.code, 0);
  assert.deepEqual(written, result.record);
  assert.equal(written.kind, 'robloxstudio-mcp-release-record');
  assert.equal(written.result, 'passed');
  assert.equal(written.createdAt, NOW.toISOString());
  assert.deepEqual(written.environment, ENVIRONMENT);
  assert.deepEqual(written.stages.map((stage) => stage.result), ['passed', 'passed', 'passed', 'passed']);
  assert.deepEqual(written.stages.map((stage) => stage.name),
    ['auto-install + functional', 'WSL process identity', 'lifecycle regressions', 'parallel Studio isolation']);
  assert.equal(written.source, undefined, 'only the outer harness may bind the source commit');
  const files = [tarballFile(MAIN, VERSION), tarballFile(INSPECTOR, VERSION)];
  assert.deepEqual(written.artifacts.map((artifact) => artifact.file), files, 'stale tarballs from an earlier run are removed');
  for (const artifact of written.artifacts) {
    const bytes = readFileSync(path.join(outputDirectory, 'artifacts', artifact.file));
    assert.equal(artifact.sha256, sha256(bytes));
    assert.equal(artifact.size, bytes.length);
    assert.equal(artifact.version, VERSION);
  }
}

{
  const { result, written } = await gate({ failAt: 2 });
  assert.equal(result.code, 1);
  assert.equal(written.result, 'failed', 'a failed gate still writes its record');
  assert.deepEqual(written.stages.map((stage) => [stage.name, stage.result]), [
    ['auto-install + functional', 'passed'],
    ['WSL process identity', 'failed'],
    ['lifecycle regressions', 'skipped'],
    ['parallel Studio isolation', 'skipped'],
  ], 'skipped stages stay visible');
  assert.equal(written.stages[1].exitCode, 3);
  assert.equal(written.artifacts.length, 2);
}

{
  const { result, written } = await gate({ exportTarballs: false });
  assert.equal(result.code, 1, 'a passing gate without tested tarballs cannot produce publishable evidence');
  assert.equal(written.result, 'failed');
  assert.match(written.artifactsError, /no tested tarballs/);
}

{
  let collected = false;
  const result = await runRelease({
    env: {},
    log: () => {},
    collectEnvironment: () => { collected = true; return ENVIRONMENT; },
    async execute() { return { code: 0 }; },
  });
  assert.equal(result.code, 0);
  assert.equal(result.record, undefined, 'without an output directory no record is written');
  assert.equal(collected, false);
}

// ---- profile harness: child env and source binding ----
assert.equal(isReleaseGateCommand(['tests/run-release.mjs']), true);
assert.equal(isReleaseGateCommand(['./tests\\run-release.mjs']), true);
assert.equal(isReleaseGateCommand(['tests/run-all.mjs', '--managed']), false);
assert.equal(isReleaseGateCommand([]), false);

{
  const identity = {
    sid: 'S-1-5-21-100-200-300-1002',
    accountName: 'MACHINE\\StudioTests',
    profileDirectory: 'C:\\Users\\StudioTests',
    localAppData: 'C:\\Users\\StudioTests\\AppData\\Local',
    roamingAppData: 'C:\\Users\\StudioTests\\AppData\\Roaming',
    profileLoaded: true,
    interactiveSession: true,
    machinePath: 'C:\\Windows\\System32',
    userPath: '',
  };
  const payload = {
    sourceSid: 'S-1-5-21-100-200-300-1001',
    targetSid: identity.sid,
    mode: 'run',
    repo: 'C:\\snapshots\\snapshot-abc',
    command: ['tests/run-release.mjs'],
    managedSnapshot: true,
    prepareWorkspace: true,
    releaseRecord: true,
  };
  const options = {
    identity,
    runSafely: async (_env, operation) => operation(),
    holdDisplay: async () => async () => {},
  };
  const originalLog = console.log;
  console.log = () => {};
  try {
    let suiteEnv;
    const code = await runTestProfilePayload(payload, {
      ...options,
      async execute(_command, args, childOptions) {
        if (args[0] === 'tests/run-release.mjs') suiteEnv = childOptions.env;
        return 0;
      },
    });
    assert.equal(code, 0);
    assert.equal(suiteEnv[RELEASE_OUTPUT_ENV], 'C:\\snapshots\\snapshot-abc\\release-output', 'the gate writes inside its own snapshot');
    assert.equal(suiteEnv.USERPROFILE, identity.profileDirectory, 'the record does not relax the dedicated profile');

    let otherEnv;
    await runTestProfilePayload({ ...payload, releaseRecord: undefined }, {
      ...options,
      async execute(_command, args, childOptions) {
        if (args[0] === 'tests/run-release.mjs') otherEnv = childOptions.env;
        return 0;
      },
    });
    assert.equal(RELEASE_OUTPUT_ENV in otherEnv, false, 'callers cannot inject a release output directory');

    for (const invalid of [
      { managedSnapshot: undefined },
      { command: ['tests/run-all.mjs', '--managed'] },
      { releaseRecord: 'yes' },
    ]) {
      await assert.rejects(runTestProfilePayload({ ...payload, ...invalid }, {
        ...options,
        execute: async () => assert.fail('an invalid release payload runs nothing'),
      }), /release record/);
    }
  } finally {
    console.log = originalLog;
  }
}

{
  const sourceDirectory = temporaryDirectory('source');
  const releaseDirectory = path.join(sourceDirectory, 'release');
  mkdirSync(path.join(releaseDirectory, 'artifacts'), { recursive: true });
  writeFileSync(path.join(releaseDirectory, 'release-record.json'), '{"previous":true}');
  writeFileSync(path.join(releaseDirectory, 'artifacts', 'previous.tgz'), 'previous');
  writeFileSync(path.join(releaseDirectory, 'overrides.jsonl'), '{"kept":true}\n');
  let status = '';
  let head = COMMIT;
  const git = (args, cwd) => {
    assert.equal(cwd, sourceDirectory);
    if (args[0] === 'rev-parse') return `${head}\n`;
    if (args[0] === 'status') return status;
    throw new Error(`unexpected git ${args.join(' ')}`);
  };
  const before = beginReleaseRecord(sourceDirectory, { git });
  assert.deepEqual(before, { commit: COMMIT, clean: true });
  assert.equal(existsSync(path.join(releaseDirectory, 'release-record.json')), false, 'a new gate run removes the previous record first');
  assert.equal(existsSync(path.join(releaseDirectory, 'artifacts')), false);
  assert.equal(readFileSync(path.join(releaseDirectory, 'overrides.jsonl'), 'utf8'), '{"kept":true}\n', 'the override log survives');

  const source = confirmReleaseSource(sourceDirectory, before, { git, now: () => NOW });
  assert.deepEqual(source, { commit: COMMIT, clean: true, exportedAt: NOW.toISOString() });
  status = ' M package.json\n';
  assert.equal(confirmReleaseSource(sourceDirectory, before, { git }).clean, false, 'an edit during export taints the record');
  status = '';
  head = 'b'.repeat(40);
  assert.equal(confirmReleaseSource(sourceDirectory, before, { git }).clean, false, 'a commit during export taints the record');

  const { outputDirectory } = await gate();
  const snapshotDirectory = path.dirname(outputDirectory);
  const record = finishReleaseRecord({ snapshotDirectory, sourceDirectory, source });
  assert.deepEqual(record.source, source);
  const saved = JSON.parse(readFileSync(path.join(releaseDirectory, 'release-record.json'), 'utf8'));
  assert.deepEqual(saved, record);
  for (const artifact of saved.artifacts) {
    assert.equal(sha256(readFileSync(path.join(releaseDirectory, 'artifacts', artifact.file))), artifact.sha256);
  }

  const emptySnapshot = temporaryDirectory('empty-snapshot');
  assert.throws(() => finishReleaseRecord({ snapshotDirectory: emptySnapshot, sourceDirectory, source }), /wrote no record/);
  const hostile = temporaryDirectory('hostile-snapshot');
  mkdirSync(path.join(hostile, RELEASE_OUTPUT_DIRECTORY), { recursive: true });
  writeFileSync(path.join(hostile, RELEASE_OUTPUT_DIRECTORY, 'release-record.json'), JSON.stringify({
    kind: 'robloxstudio-mcp-release-record', artifacts: [{ file: '../../escape.tgz' }],
  }));
  assert.throws(() => finishReleaseRecord({ snapshotDirectory: hostile, sourceDirectory, source }), /invalid tarball name/);
}

// ---- publish gate ----
function fixtureRoot({ version = VERSION, recordMutator, tarballMutator } = {}) {
  const rootDir = temporaryDirectory('publish');
  const packages = {
    '.': '@chrrxs/robloxstudio-mcp-monorepo',
    'packages/core': '@chrrxs/robloxstudio-mcp-core',
    'packages/robloxstudio-mcp': MAIN,
    'packages/robloxstudio-mcp-inspector': INSPECTOR,
  };
  for (const [directory, name] of Object.entries(packages)) {
    mkdirSync(path.join(rootDir, directory), { recursive: true });
    writeFileSync(path.join(rootDir, directory, 'package.json'), `${JSON.stringify({ name, version: directory === '.' ? version : VERSION }, null, 2)}\n`);
  }
  const artifactsDirectory = path.join(rootDir, 'release', 'artifacts');
  mkdirSync(artifactsDirectory, { recursive: true });
  const artifacts = [MAIN, INSPECTOR].map((name) => {
    const file = tarballFile(name, VERSION);
    const bytes = tarball({ name, version: VERSION });
    writeFileSync(path.join(artifactsDirectory, file), tarballMutator?.(name, bytes) ?? bytes);
    return { name, version: VERSION, file, sha256: sha256(bytes), size: bytes.length };
  });
  const record = {
    kind: 'robloxstudio-mcp-release-record',
    schemaVersion: 1,
    createdAt: new Date(NOW.getTime() - 60 * 60 * 1000).toISOString(),
    result: 'passed',
    artifacts,
    environment: ENVIRONMENT,
    stages: ['auto-install + functional', 'WSL process identity', 'lifecycle regressions', 'parallel Studio isolation']
      .map((name) => ({ name, command: [], result: 'passed', exitCode: 0 })),
    source: { commit: COMMIT, clean: true, exportedAt: NOW.toISOString() },
  };
  recordMutator?.(record);
  if (record.kind) writeFileSync(path.join(rootDir, 'release', 'release-record.json'), JSON.stringify(record, null, 2));
  return rootDir;
}

function publish(rootDir, { argv = [], head = COMMIT, status = '', runImpl } = {}) {
  const calls = [];
  const out = [];
  const packageJsons = () => ['.', 'packages/core', 'packages/robloxstudio-mcp', 'packages/robloxstudio-mcp-inspector']
    .map((directory) => readFileSync(path.join(rootDir, directory, 'package.json'), 'utf8'));
  const beforePackages = packageJsons();
  const code = runPublish({
    argv,
    rootDir,
    git: (args) => (args[0] === 'rev-parse' ? `${head}\n` : status),
    run(command, args, options) {
      calls.push([command, ...args]);
      return runImpl?.(command, args, options) ?? '';
    },
    log: (line) => out.push(line),
    warn: (line) => out.push(line),
    now: () => NOW,
    user: () => 'release-tester',
  });
  assert.deepEqual(packageJsons(), beforePackages, 'publishing never edits package.json');
  return { code, calls, output: out.join('\n') };
}

{
  const rootDir = fixtureRoot();
  const { code, calls, output } = publish(rootDir);
  assert.equal(code, 0, output);
  assert.deepEqual(calls, [
    ['npm', 'publish', path.join(rootDir, 'release', 'artifacts', tarballFile(MAIN, VERSION))],
    ['npm', 'publish', path.join(rootDir, 'release', 'artifacts', tarballFile(INSPECTOR, VERSION))],
  ], 'valid evidence publishes exactly the tested tarballs, without a rebuild');
  assert.match(output, /Studio version-0123abcd/);

  const dry = publish(rootDir, { argv: ['--dry-run'] });
  assert.equal(dry.code, 0);
  assert.deepEqual(dry.calls, [], 'dry run verifies without publishing');
  assert.match(dry.output, /Dry run: would publish/);
}

const refusals = [
  ['missing record', { recordMutator: (record) => { delete record.kind; } }, {}, 'record', /No release record/],
  ['stale record', { recordMutator: (record) => { record.createdAt = new Date(NOW.getTime() - 8 * 24 * 60 * 60 * 1000).toISOString(); } }, {}, 'age', /older than 168 hours/],
  ['future record', { recordMutator: (record) => { record.createdAt = new Date(NOW.getTime() + 60 * 60 * 1000).toISOString(); } }, {}, 'age', /in the future/],
  ['failed result', { recordMutator: (record) => { record.result = 'failed'; record.stages[1].result = 'failed'; } }, {}, 'stages', /WSL process identity" failed/],
  ['skipped stage', { recordMutator: (record) => { record.stages[3].result = 'skipped'; } }, {}, 'stages', /parallel Studio isolation" was skipped/],
  ['no stages', { recordMutator: (record) => { record.stages = []; } }, {}, 'stages', /no stages/],
  ['hash mismatch', { tarballMutator: (name, bytes) => (name === MAIN ? tarball({ name, version: VERSION, extra: 'rebuilt' }) : bytes) }, {}, 'artifacts', /does not match the tested tarball/],
  ['missing tarball', { recordMutator: (record) => { record.artifacts[1].file = 'absent-9.8.7.tgz'; } }, {}, 'artifacts', /absent-9.8.7.tgz is missing/],
  ['missing package', { recordMutator: (record) => { record.artifacts.pop(); } }, {}, 'artifacts', /0 tarballs for @chrrxs\/robloxstudio-mcp-inspector/],
  ['tarball contents', {
    tarballMutator: (name, bytes) => (name === MAIN ? tarball({ name, version: '0.0.1' }) : bytes),
    recordMutator: (record) => {
      const bytes = tarball({ name: MAIN, version: '0.0.1' });
      Object.assign(record.artifacts[0], { sha256: sha256(bytes), size: bytes.length });
    },
  }, {}, 'artifacts', /contains @chrrxs\/robloxstudio-mcp@0.0.1/],
  ['version mismatch', { version: '9.8.8' }, {}, 'versions', /package.json versions differ/],
  ['wrong commit', {}, { head: 'c'.repeat(40) }, 'commit', /is for commit a{40}, but HEAD is c{40}/],
  ['dirty tree', {}, { status: '?? notes.txt\n' }, 'tree-clean', /uncommitted or untracked/],
  ['dirty gate source', { recordMutator: (record) => { record.source.clean = false; } }, {}, 'source-clean', /gate ran on a working tree/],
  ['unbound record', { recordMutator: (record) => { delete record.source; } }, {}, 'commit', /no source commit/],
];
for (const [label, fixture, options, check, message] of refusals) {
  const { code, calls, output } = publish(fixtureRoot(fixture), options);
  assert.equal(code, 1, `${label} refuses publication`);
  assert.deepEqual(calls, [], `${label} runs no npm command`);
  assert.match(output, /Refusing to publish/, label);
  assert.match(output, new RegExp(`\\[${check}\\]`), `${label} names the failed check`);
  assert.match(output, message, label);
}

{
  const pkg = (directory, name, version) => ({ directory, name, version });
  const result = verifyReleaseEvidence({
    record: undefined,
    recordError: 'No release record',
    source: { commit: COMMIT, clean: false },
    packages: [pkg('.', 'root', '1.0.0'), pkg('packages/core', 'core', '1.0.1')],
    readArtifact: () => assert.fail('nothing to read without a record'),
    now: NOW.getTime(),
  });
  assert.deepEqual(result.failures.map((item) => item.check), ['tree-clean', 'versions', 'record'], 'every independent failure is reported');
}

// ---- emergency override ----
assert.throws(() => parsePublishArguments(['--emergency-override']), /requires --reason/);
assert.throws(() => parsePublishArguments(['--emergency-override', '--reason', '   ']), /requires --reason/);
assert.throws(() => parsePublishArguments(['--emergency-override', '--reason']), /needs a value/);
assert.throws(() => parsePublishArguments(['--reason', 'why']), /only valid with --emergency-override/);
assert.throws(() => parsePublishArguments(['--force']), /Unknown option --force/);
assert.deepEqual(parsePublishArguments(['--emergency-override', '--reason=npm outage', '--verify-only']),
  { dryRun: true, override: true, reason: 'npm outage' });

{
  const rootDir = fixtureRoot();
  assert.throws(() => publish(rootDir, { argv: ['--emergency-override'] }), /requires --reason/);
  assert.equal(existsSync(path.join(rootDir, 'release', 'overrides.jsonl')), false);
}

{
  const rootDir = fixtureRoot({ recordMutator: (record) => { record.createdAt = '2026-01-01T00:00:00.000Z'; } });
  const dry = publish(rootDir, { argv: ['--emergency-override', '--reason', 'hotfix', '--dry-run'] });
  assert.equal(dry.code, 0);
  assert.deepEqual(dry.calls, []);
  assert.equal(existsSync(path.join(rootDir, 'release', 'overrides.jsonl')), false, 'a dry run logs nothing');

  const { code, calls, output } = publish(rootDir, { argv: ['--emergency-override', '--reason', '  Roblox outage blocks Studio  '] });
  assert.equal(code, 0, output);
  assert.match(output, /EMERGENCY OVERRIDE/);
  assert.match(output, /\[age\]/, 'bypassed checks are printed');
  assert.deepEqual(calls.map((call) => call.slice(0, 2)), [['npm', 'publish'], ['npm', 'publish']], 'valid recorded tarballs are reused, not rebuilt');
  const entries = readFileSync(path.join(rootDir, 'release', 'overrides.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(entries.length, 1);
  const [entry] = entries;
  assert.equal(entry.reason, 'Roblox outage blocks Studio');
  assert.equal(entry.user, 'release-tester');
  assert.equal(entry.commit, COMMIT);
  assert.equal(entry.timestamp, NOW.toISOString());
  assert.deepEqual(entry.versions[MAIN], VERSION);
  assert.deepEqual(entry.bypassedChecks.map((item) => item.check), ['age']);
  assert.deepEqual(entry.artifacts.map((artifact) => artifact.sha256),
    [MAIN, INSPECTOR].map((name) => sha256(tarball({ name, version: VERSION }))));
}

{
  const rootDir = fixtureRoot({ recordMutator: (record) => { delete record.kind; } });
  const order = [];
  const { code, calls } = publish(rootDir, {
    argv: ['--emergency-override', '--reason', 'gate host unavailable'],
    status: ' M README.md\n',
    runImpl(command, args) {
      order.push(args[0] === 'publish' && existsSync(path.join(rootDir, 'release', 'overrides.jsonl')) ? 'publish-after-log' : args[0]);
      if (args[0] !== 'pack') return '';
      const workspace = args[args.indexOf('-w') + 1];
      const destination = args[args.indexOf('--pack-destination') + 1];
      const name = workspace.endsWith('inspector') ? INSPECTOR : MAIN;
      writeFileSync(path.join(destination, tarballFile(name, VERSION)), tarball({ name, version: VERSION, extra: 'override' }));
      return `> prepack\nStaged studio-plugin\n${tarballFile(name, VERSION)}\n`;
    },
  });
  assert.equal(code, 0);
  assert.equal(calls.some((call) => call.includes('build:all') || call.includes('build:plugins')), false, 'override builds never install plugins into Studio');
  assert.deepEqual(order, ['run', 'run', 'scripts/build-plugin.mjs', 'pack', 'pack', 'publish-after-log', 'publish-after-log'],
    'without recorded tarballs the override packs fresh ones and logs before publishing');
  const [entry] = readFileSync(path.join(rootDir, 'release', 'overrides.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(entry.bypassedChecks.map((item) => item.check), ['tree-clean', 'record']);
  assert.equal(entry.treeClean, false);
  assert.deepEqual(entry.artifacts.map((artifact) => artifact.sha256),
    [MAIN, INSPECTOR].map((name) => sha256(tarball({ name, version: VERSION, extra: 'override' }))));
  for (const call of calls.filter((item) => item[1] === 'publish')) {
    assert.match(call[2], /release[\\/]override-20261025T120000000Z[\\/]/u);
  }
}

// ---- version sync ----
{
  const rootDir = fixtureRoot();
  writeFileSync(path.join(rootDir, 'package-lock.json'), JSON.stringify({
    name: 'root', version: VERSION, lockfileVersion: 3,
    packages: {
      '': { name: 'root', version: VERSION },
      'packages/core': { version: VERSION },
      'packages/robloxstudio-mcp': { version: VERSION },
      'packages/robloxstudio-mcp-inspector': { version: VERSION },
      'node_modules/x': { version: '1.0.0' },
    },
  }));
  assert.equal(syncVersions({ rootDir, version: '10.0.0', log: () => {} }), '10.0.0');
  for (const directory of ['.', 'packages/core', 'packages/robloxstudio-mcp', 'packages/robloxstudio-mcp-inspector']) {
    assert.equal(JSON.parse(readFileSync(path.join(rootDir, directory, 'package.json'), 'utf8')).version, '10.0.0');
  }
  const lock = JSON.parse(readFileSync(path.join(rootDir, 'package-lock.json'), 'utf8'));
  assert.equal(lock.version, '10.0.0');
  assert.equal(lock.packages[''].version, '10.0.0');
  assert.equal(lock.packages['packages/robloxstudio-mcp-inspector'].version, '10.0.0');
  assert.equal(lock.packages['node_modules/x'].version, '1.0.0');
  assert.throws(() => syncVersions({ rootDir, version: 'latest', log: () => {} }), /Invalid version/);
}

for (const directory of temporaryRoots) rmSync(directory, { recursive: true, force: true });
console.log('release-evidence: ok');
