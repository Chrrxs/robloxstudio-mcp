import { execFile } from 'node:child_process';
import { isUtf8 } from 'node:buffer';
import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';

const runFile = promisify(execFile);
const manifestName = '.studio-test-snapshot.json';
const excludedDirectories = new Set([
  '.git', 'node_modules', 'dist', 'coverage', '.cache', '.next', '.turbo',
  '.ssh', '.aws', '.azure', '.docker', '.kube', '.gnupg', '.config',
  '.claude', '.codex', '.agents',
]);
const credentialNames = new Set([
  '.git-credentials', '.gitconfig', '.netrc', '_netrc', '.pypirc', '.dockercfg',
  '.claude.json', '.codex.json', 'mcp.json', 'auth.json', 'kubeconfig',
]);

function excluded(parts) {
  const lower = parts.map((part) => part.toLowerCase());
  const name = lower.at(-1);
  return lower[0] === manifestName || lower.some((part) => excludedDirectories.has(part))
    || (lower[0] === 'studio-plugin' && lower[1] === 'out')
    || lower.some((part) => part.startsWith('.env')
      || /^\.(?:npmrc|yarnrc)/.test(part)
      || credentialNames.has(part)
      || /^\.?(?:credentials?|secrets?|tokens?)(?:$|[._-].*\.(?:json|ya?ml|toml|ini|conf|txt|env)$|\.(?:json|ya?ml|toml|ini|conf|txt|env)$)/.test(part))
    || /\.(?:env|npmrc|pem|key|p12|pfx|jks|keystore|tsbuildinfo)$/.test(name)
    || /^id_(?:rsa|dsa|ecdsa|ed25519)(?:$|\.)/.test(name);
}

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function sourceParts(filename) {
  const parts = filename.split('/');
  // The export is consumed on Windows: reject alternate separators, drive/ADS
  // syntax and names Windows would normalize to a different destination.
  if (parts.some((part) => !part || part === '.' || part === '..'
    || /[\\:<>"|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part)
    || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw new Error(`Unsafe snapshot source path: ${JSON.stringify(filename)}`);
  }
  return parts;
}

async function destinationDirectory(source, destinationParent) {
  const requested = path.resolve(destinationParent);
  let ancestor = requested;
  const missing = [];
  for (;;) {
    try {
      const resolved = path.join(await realpath(ancestor), ...missing);
      if (isWithin(source, resolved)) {
        throw new Error('Snapshot destination parent must be outside the source directory');
      }
      break;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      missing.unshift(path.basename(ancestor));
      const next = path.dirname(ancestor);
      if (next === ancestor) throw error;
      ancestor = next;
    }
  }
  await mkdir(requested, { recursive: true });
  const parent = await realpath(requested);
  if (isWithin(source, parent)) {
    throw new Error('Snapshot destination parent must be outside the source directory');
  }
  return mkdtemp(path.join(parent, 'snapshot-'));
}

async function openSourceFile(source, parts) {
  let filename = source;
  let info;
  for (const [index, part] of parts.entries()) {
    filename = path.join(filename, part);
    try {
      info = await lstat(filename);
    } catch (error) {
      if (error.code === 'ENOENT') return; // Deleted tracked files stay deleted.
      throw error;
    }
    if (info.isSymbolicLink()) throw new Error(`Snapshot source symlink is not allowed: ${filename}`);
    if (index < parts.length - 1 && !info.isDirectory()) {
      throw new Error(`Snapshot source ancestor is not a directory: ${filename}`);
    }
  }
  if (!info.isFile()) throw new Error(`Snapshot source is not a regular file: ${filename}`);
  if (!isWithin(source, await realpath(filename))) throw new Error(`Snapshot source escaped its directory: ${filename}`);

  const input = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await input.stat();
    if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino) {
      throw new Error(`Snapshot source changed while opening: ${filename}`);
    }
    return { input, mode: info.mode & 0o777 };
  } catch (error) {
    await input.close();
    throw error;
  }
}

async function copySourceFile(source, destination, parts) {
  const opened = await openSourceFile(source, parts);
  if (!opened) return false;
  const { input, mode } = opened;
  try {
    const target = path.join(destination, ...parts);
    await mkdir(path.dirname(target), { recursive: true });
    const output = await open(target, 'wx', mode);
    try {
      await pipeline(input.createReadStream(), output.createWriteStream());
    } finally {
      await output.close();
    }
  } finally {
    await input.close();
  }
  return true;
}

async function enumerateSourceFiles(source) {
  let ancestor = source;
  let gitPresent = false;
  for (;;) {
    try {
      await lstat(path.join(ancestor, '.git'));
      gitPresent = true;
      break;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  if (gitPresent) {
    const gitOptions = { cwd: source, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, windowsHide: true };
    const { stdout: root } = await runFile('git', ['rev-parse', '--show-toplevel'], gitOptions);
    if (await realpath(root.toString('utf8').replace(/\r?\n$/, '')) !== source) {
      throw new Error('Snapshot source must be the root of a Git working tree');
    }
    const { stdout } = await runFile('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], gitOptions);
    if (!isUtf8(stdout)) throw new Error('Snapshot source filenames must be valid UTF-8');
    return stdout.toString('utf8').split('\0').filter(Boolean);
  }

  const opened = await openSourceFile(source, [manifestName]);
  if (!opened) throw new Error(`Snapshot source requires a Git working tree or ${manifestName}`);
  let manifest;
  try {
    const contents = await opened.input.readFile();
    if (!isUtf8(contents)) throw new Error('Snapshot manifest must be valid UTF-8');
    manifest = JSON.parse(contents.toString('utf8'));
  } finally {
    await opened.input.close();
  }
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)
    || manifest.version !== 1 || !Array.isArray(manifest.sourceFiles)
    || !manifest.sourceFiles.every((filename) => typeof filename === 'string')) {
    throw new Error('Invalid snapshot manifest: expected version 1 and a sourceFiles string array');
  }
  return manifest.sourceFiles;
}

/** Export working contents, never Git history or an existing worker directory. */
export async function prepareStudioTestSnapshot({ sourceDirectory, destinationParent }) {
  if (typeof sourceDirectory !== 'string' || !sourceDirectory || typeof destinationParent !== 'string' || !destinationParent) {
    throw new Error('Snapshot sourceDirectory and destinationParent must be nonempty host filesystem paths');
  }
  const sourceInfo = await lstat(path.resolve(sourceDirectory));
  if (sourceInfo.isSymbolicLink() || !sourceInfo.isDirectory()) {
    throw new Error('Snapshot source must be a directory, not a symlink');
  }
  const source = await realpath(sourceDirectory);
  const filenames = new Set(await enumerateSourceFiles(source));
  const workingDirectory = await destinationDirectory(source, destinationParent);
  const destinations = new Map();
  const sourceFiles = [];
  try {
    for (const filename of filenames) {
      const parts = sourceParts(filename);
      if (excluded(parts)) continue;
      for (let length = 1; length <= parts.length; length += 1) {
        const prefix = parts.slice(0, length).join('/');
        const key = prefix.toLowerCase();
        const previous = destinations.get(key);
        if (previous !== undefined && previous !== prefix) {
          throw new Error(`Snapshot source has Windows case-colliding paths: ${filename}`);
        }
        destinations.set(key, prefix);
      }
      if (await copySourceFile(source, workingDirectory, parts)) sourceFiles.push(filename);
    }
    await writeFile(path.join(workingDirectory, manifestName),
      `${JSON.stringify({ version: 1, sourceFiles }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    try {
      await rm(workingDirectory, { recursive: true, force: true });
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], `Snapshot failed; could not remove ${workingDirectory}`);
    }
    throw error;
  }
  return {
    workingDirectory,
    sourceFiles,
    cleanup: () => rm(workingDirectory, { recursive: true, force: true }),
  };
}
