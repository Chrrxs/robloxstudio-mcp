import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import * as path from 'path';

/**
 * Studio installation discovery.
 *
 * Roblox Studio is not only installed by the official bootstrapper. Third-party
 * launchers (notably Roblox Mod Loader) keep their own version trees and are the
 * build a user actually runs, so auto-discovery has to look past
 * `%LOCALAPPDATA%\Roblox\Versions`.
 */

export type StudioInstallationSource = 'official' | 'rml' | 'custom';

export interface StudioInstallation {
  /** Absolute path to RobloxStudioBeta.exe. */
  executable: string;
  source: StudioInstallationSource;
  /** Versions root the executable was discovered under. */
  root: string;
  /** `version-<hash>` folder name, when the layout is versioned. */
  versionFolder?: string;
  modifiedAtMs: number;
  /** The launcher itself declares this installation as its default. */
  launcherDefault: boolean;
}

export interface StudioInstallationRoot {
  path: string;
  source: StudioInstallationSource;
  /** Version folder the launcher declares as its default, when known. */
  defaultVersionFolder?: string;
  /** Root holds a single Studio directly instead of `version-*` subfolders. */
  flat?: boolean;
}

export interface StudioInstallationFs {
  existsSync: (target: string) => boolean;
  readdirSync: (target: string) => string[];
  statSync: (target: string) => { mtimeMs: number };
  readFileSync: (target: string, encoding: 'utf8') => string;
}

export interface StudioInstallationSearchPaths {
  /** Host-native `%LOCALAPPDATA%`. */
  localAppData?: string;
  /** Host-native `%APPDATA%`. */
  roamingAppData?: string;
  /** Extra roots, highest priority first (ROBLOX_STUDIO_SEARCH_ROOTS). */
  extraRoots?: string[];
}

export const STUDIO_EXECUTABLE_NAME = 'RobloxStudioBeta.exe';

/** Roblox Mod Loader launcher data directory, under `%APPDATA%`. */
export const RML_LAUNCHER_DIRECTORY = 'com.revolution.rml-launcher';

const VERSION_FOLDER = /^version-[a-z0-9]+$/i;

const DEFAULT_FS: StudioInstallationFs = {
  existsSync,
  readdirSync: (target) => readdirSync(target),
  statSync: (target) => statSync(target),
  readFileSync: (target, encoding) => readFileSync(target, encoding),
};

export function parseStudioSearchRoots(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(';')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export function parseStudioInstallationSource(value: string | undefined): StudioInstallationSource | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === '' || normalized === 'auto' || normalized === 'any') return undefined;
  if (normalized === 'official' || normalized === 'roblox') return 'official';
  if (normalized === 'rml' || normalized === 'modloader' || normalized === 'roblox-mod-loader') return 'rml';
  if (normalized === 'custom') return 'custom';
  throw new Error(
    `Unsupported ROBLOX_STUDIO_SOURCE "${value}". Use auto, official, rml, or custom.`,
  );
}

export interface RmlDefaultInstallation {
  /** RML `InstallationSource` slug, e.g. `managed` or `roblox-official`. */
  slug: string;
  versionFolder: string;
}

/**
 * `{ "defaultInstallationId": "<source>:<version-folder>" }` in the Roblox Mod
 * Loader launcher's Studio settings names the build it opens. The slug matters:
 * `managed` installs live in the launcher's own tree, `roblox-official` ones in
 * the official Roblox tree.
 */
export function readRmlDefaultInstallation(
  studioDirectory: string,
  fileSystem: StudioInstallationFs = DEFAULT_FS,
): RmlDefaultInstallation | undefined {
  const settingsPath = path.join(studioDirectory, 'settings.json');
  if (!fileSystem.existsSync(settingsPath)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fileSystem.readFileSync(settingsPath, 'utf8'));
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object' || !('defaultInstallationId' in parsed)) return undefined;
  const id = parsed.defaultInstallationId;
  if (typeof id !== 'string') return undefined;
  const separator = id.lastIndexOf(':');
  const slug = separator === -1 ? 'managed' : id.slice(0, separator);
  const versionFolder = separator === -1 ? id : id.slice(separator + 1);
  if (!VERSION_FOLDER.test(versionFolder)) return undefined;
  return { slug, versionFolder };
}

export function studioInstallationRoots(
  paths: StudioInstallationSearchPaths,
  fileSystem: StudioInstallationFs = DEFAULT_FS,
): StudioInstallationRoot[] {
  const roots: StudioInstallationRoot[] = [];
  const rmlStudioDirectory = paths.roamingAppData
    ? path.join(paths.roamingAppData, RML_LAUNCHER_DIRECTORY, 'studio')
    : undefined;
  const rmlDefault = rmlStudioDirectory
    ? readRmlDefaultInstallation(rmlStudioDirectory, fileSystem)
    : undefined;

  for (const extra of paths.extraRoots ?? []) {
    roots.push({ path: extra, source: 'custom' });
    roots.push({ path: extra, source: 'custom', flat: true });
  }

  if (paths.localAppData) {
    roots.push({
      path: path.join(paths.localAppData, 'Roblox', 'Versions'),
      source: 'official',
      defaultVersionFolder: rmlDefault?.slug === 'roblox-official' ? rmlDefault.versionFolder : undefined,
    });
  }

  if (rmlStudioDirectory) {
    roots.push({
      path: path.join(rmlStudioDirectory, 'versions'),
      source: 'rml',
      defaultVersionFolder: rmlDefault?.slug === 'managed' ? rmlDefault.versionFolder : undefined,
    });
  }

  return roots;
}

export function discoverStudioInstallations(
  paths: StudioInstallationSearchPaths,
  fileSystem: StudioInstallationFs = DEFAULT_FS,
): StudioInstallation[] {
  const found: StudioInstallation[] = [];
  const seen = new Set<string>();

  for (const root of studioInstallationRoots(paths, fileSystem)) {
    if (!fileSystem.existsSync(root.path)) continue;

    let entries: string[] = [''];
    if (!root.flat) {
      try {
        entries = fileSystem.readdirSync(root.path).filter((name) => VERSION_FOLDER.test(name));
      } catch {
        continue;
      }
    }

    for (const entry of entries) {
      const directory = entry ? path.join(root.path, entry) : root.path;
      const executable = path.join(directory, STUDIO_EXECUTABLE_NAME);
      if (!fileSystem.existsSync(executable)) continue;
      if (seen.has(executable)) continue;
      seen.add(executable);

      let modifiedAtMs = 0;
      try {
        modifiedAtMs = fileSystem.statSync(executable).mtimeMs;
      } catch {
        continue;
      }

      found.push({
        executable,
        source: root.source,
        root: root.path,
        versionFolder: entry || undefined,
        modifiedAtMs,
        launcherDefault: Boolean(entry) && entry === root.defaultVersionFolder,
      });
    }
  }

  return found.sort(compareStudioInstallations);
}

/**
 * A launcher-declared default outranks the newest build: the launcher knows
 * which Studio the user actually opens, mtime is only a guess. Ties fall back
 * to newest first so the previous behaviour is preserved when nothing declares
 * a default.
 */
export function compareStudioInstallations(a: StudioInstallation, b: StudioInstallation): number {
  if (a.launcherDefault !== b.launcherDefault) return a.launcherDefault ? -1 : 1;
  if (b.modifiedAtMs !== a.modifiedAtMs) return b.modifiedAtMs - a.modifiedAtMs;
  return a.executable.localeCompare(b.executable);
}

export function selectStudioInstallation(
  installations: StudioInstallation[],
  preferredSource?: StudioInstallationSource,
): StudioInstallation | undefined {
  const candidates = preferredSource
    ? installations.filter((installation) => installation.source === preferredSource)
    : installations;
  return [...candidates].sort(compareStudioInstallations)[0];
}

export function describeStudioInstallationRoots(roots: StudioInstallationRoot[]): string {
  const unique = new Map<string, StudioInstallationSource>();
  for (const root of roots) {
    if (!unique.has(root.path)) unique.set(root.path, root.source);
  }
  return [...unique.entries()].map(([root, source]) => `${root} (${source})`).join(', ');
}
