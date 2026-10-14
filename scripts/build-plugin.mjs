#!/usr/bin/env node

import {
  readFileSync,
  readdirSync,
  writeFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  unlinkSync,
  renameSync,
  rmSync,
  statSync,
  constants,
} from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, basename } from 'path';
import { homedir } from 'os';
import { randomUUID } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');
const { version: VERSION } = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8'));
const pluginDir = join(rootDir, 'studio-plugin');
const outDir = join(pluginDir, 'out');
const serverDir = join(outDir, 'server');
const modulesDir = join(outDir, 'modules');
const includeDir = join(pluginDir, 'include');
const nodeModulesRbxtsDir = join(pluginDir, 'node_modules', '@rbxts');
// Compiled story renderer + MCP preview adapter (GPL-3.0), produced by
// scripts/build-ui-renderer.mjs. Bundled into the main variant only.
const rendererDir = join(rootDir, '.local', 'ui-renderer-build');
const rendererOutDir = join(rendererDir, 'out');
const rendererIncludeDir = join(rendererDir, 'include');

// Three icon variants per build, swapped by the plugin at runtime to reflect
// connection state. Until separate white/yellow/green assets are uploaded, all
// three slots point at the same legacy ID so behavior is unchanged visually.
const VARIANTS = {
  main: {
    scriptName: 'MCPPlugin',
    outputName: 'MCPPlugin.rbxmx',
    toolbarName: 'MCP Integration',
    buttonTitle: 'MCP Server',
    buttonTooltip: 'Connect to MCP Server for AI Integration',
    buttonIconDisconnected: '75876056391496',  // red
    buttonIconConnecting: '71302583919560',    // yellow
    buttonIconConnected: '130958234173611',    // green
  },
  inspector: {
    scriptName: 'MCPInspectorPlugin',
    outputName: 'MCPInspectorPlugin.rbxmx',
    toolbarName: 'MCP Inspector',
    buttonTitle: 'MCP Inspector',
    buttonTooltip: 'Connect to MCP Inspector (read-only) for AI Integration',
    buttonIconDisconnected: '125921838360800', // TODO: replace with white-variant asset ID
    buttonIconConnecting: '125921838360800',   // TODO: replace with yellow-variant asset ID
    buttonIconConnected: '125921838360800',    // TODO: replace with green-variant asset ID
  },
};

const variantArgIdx = process.argv.indexOf('--variant');
const variantName = variantArgIdx !== -1 ? process.argv[variantArgIdx + 1] : 'main';
const variant = VARIANTS[variantName];
if (!variant) {
  console.error(`Unknown variant "${variantName}". Available: ${Object.keys(VARIANTS).join(', ')}`);
  process.exit(1);
}

const outputPath = join(pluginDir, variant.outputName);
const otherVariant = variantName === 'main' ? VARIANTS.inspector : VARIANTS.main;

function escapeCdata(source) {
  return source.replace(/\]\]>/g, ']]]]><![CDATA[>');
}

function injectVersion(source) {
  return source
    .replace(/__VERSION__/g, VERSION)
    .replace(/__PLUGIN_VARIANT__/g, variantName)
    .replace(/__TOOLBAR_NAME__/g, variant.toolbarName)
    .replace(/__BUTTON_TITLE__/g, variant.buttonTitle)
    .replace(/__BUTTON_TOOLTIP__/g, variant.buttonTooltip)
    .replace(/__BUTTON_ICON_DISCONNECTED__/g, variant.buttonIconDisconnected)
    .replace(/__BUTTON_ICON_CONNECTING__/g, variant.buttonIconConnecting)
    .replace(/__BUTTON_ICON_CONNECTED__/g, variant.buttonIconConnected);
}

const serverInitPath = join(serverDir, 'init.server.luau');
if (!existsSync(serverInitPath)) {
  console.error(`Server script not found at ${serverInitPath}`);
  console.error('Run "cd studio-plugin && npm run build" first to compile TypeScript.');
  process.exit(1);
}

const mainSource = injectVersion(readFileSync(serverInitPath, 'utf8'));

let refId = 1;

function findInitFile(dir) {
  for (const name of ['init.luau', 'init.lua']) {
    const p = join(dir, name);
    if (existsSync(p)) return p;
  }
  return undefined;
}

const INIT_FILENAMES = new Set(['init.luau', 'init.lua', 'init.server.luau', 'init.server.lua']);

// pnpm links packages into node_modules via symlinks; follow them.
function isDirectoryEntry(entry, fullPath) {
  return entry.isDirectory() || (entry.isSymbolicLink() && statSync(fullPath).isDirectory());
}

function isLuaFile(name) {
  // *.server/*.client entry scripts (e.g. the upstream renderer's toolbar plugin) are never serialized as modules.
  if (/\.(server|client)\.luau?$/.test(name)) return false;
  return name.endsWith('.luau') || name.endsWith('.lua');
}

function dirHasLuaContent(dir) {
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isFile() && isLuaFile(entry.name)) return true;
    const fullPath = join(dir, entry.name);
    if (isDirectoryEntry(entry, fullPath) && dirHasLuaContent(fullPath)) return true;
  }
  return false;
}

function buildModuleItems(dir, depth = 0) {
  if (!existsSync(dir)) return '';

  let items = '';
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);

    if (isDirectoryEntry(entry, fullPath)) {
      if (!dirHasLuaContent(fullPath)) continue;

      const initFile = findInitFile(fullPath);
      refId++;
      const currentRef = refId;

      if (initFile) {
        const moduleSource = injectVersion(readFileSync(initFile, 'utf8'));
        const childItems = buildModuleItems(fullPath, depth + 1);
        items += `
      ${'  '.repeat(depth)}<Item class="ModuleScript" referent="${currentRef}">
      ${'  '.repeat(depth)}  <Properties>
      ${'  '.repeat(depth)}    <string name="Name">${entry.name}</string>
      ${'  '.repeat(depth)}    <string name="Source"><![CDATA[${escapeCdata(moduleSource)}]]></string>
      ${'  '.repeat(depth)}  </Properties>${childItems}
      ${'  '.repeat(depth)}</Item>`;
      } else {
        const childItems = buildModuleItems(fullPath, depth + 1);
        items += `
      ${'  '.repeat(depth)}<Item class="Folder" referent="${currentRef}">
      ${'  '.repeat(depth)}  <Properties>
      ${'  '.repeat(depth)}    <string name="Name">${entry.name}</string>
      ${'  '.repeat(depth)}  </Properties>${childItems}
      ${'  '.repeat(depth)}</Item>`;
      }
    } else if (isLuaFile(entry.name) && !INIT_FILENAMES.has(entry.name)) {
      const ext = entry.name.endsWith('.luau') ? '.luau' : '.lua';
      const moduleName = basename(entry.name, ext);
      const moduleSource = injectVersion(readFileSync(fullPath, 'utf8'));
      refId++;
      items += `
      ${'  '.repeat(depth)}<Item class="ModuleScript" referent="${refId}">
      ${'  '.repeat(depth)}  <Properties>
      ${'  '.repeat(depth)}    <string name="Name">${moduleName}</string>
      ${'  '.repeat(depth)}    <string name="Source"><![CDATA[${escapeCdata(moduleSource)}]]></string>
      ${'  '.repeat(depth)}  </Properties>
      ${'  '.repeat(depth)}</Item>`;
    }
  }

  return items;
}

const moduleItems = buildModuleItems(modulesDir);

const includeItems = buildModuleItems(includeDir);

const rbxtsItems = buildModuleItems(nodeModulesRbxtsDir);

function folderItem(name, children, depth) {
  const pad = '  '.repeat(depth);
  return `
      ${pad}<Item class="Folder" referent="${++refId}">
      ${pad}  <Properties>
      ${pad}    <string name="Name">${name}</string>
      ${pad}  </Properties>${children}
      ${pad}</Item>`;
}

function moduleScriptItem(name, sourcePath, children, depth) {
  const pad = '  '.repeat(depth);
  const source = injectVersion(readFileSync(sourcePath, 'utf8'));
  return `
      ${pad}<Item class="ModuleScript" referent="${++refId}">
      ${pad}  <Properties>
      ${pad}    <string name="Name">${name}</string>
      ${pad}    <string name="Source"><![CDATA[${escapeCdata(source)}]]></string>
      ${pad}  </Properties>${children}
      ${pad}</Item>`;
}

// Minimal Rojo project-node resolver for installed packages: honors $path
// (directory with/without init, or a single Lua file) and named child nodes.
// Nested projects are named by their project "name" as Rojo does, e.g.
// @rbxts-js/react -> "React", which @rbxts/react requires by that name.
function projectNodeItems(name, node, baseDir, depth) {
  let children = '';
  for (const [key, child] of Object.entries(node)) {
    if (!key.startsWith('$') && child && typeof child === 'object') {
      children += projectNodeItems(key, child, baseDir, depth + 1);
    }
  }
  const target = node.$path ? join(baseDir, node.$path) : undefined;
  if (target && existsSync(target)) {
    if (statSync(target).isDirectory()) {
      children = buildModuleItems(target, depth + 1) + children;
      const initFile = findInitFile(target);
      if (initFile) return moduleScriptItem(name, initFile, children, depth);
    } else if (isLuaFile(target)) {
      return moduleScriptItem(name, target, children, depth);
    }
  }
  return children ? folderItem(name, children, depth) : '';
}

function buildPackageScopeItems(scopeDir, depth) {
  let items = '';
  const entries = readdirSync(scopeDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const packageDir = join(scopeDir, entry.name);
    if (!isDirectoryEntry(entry, packageDir)) continue;
    const projectPath = join(packageDir, 'default.project.json');
    if (existsSync(projectPath)) {
      const project = JSON.parse(readFileSync(projectPath, 'utf8'));
      items += projectNodeItems(project.name ?? entry.name, project.tree, packageDir, depth);
    } else if (dirHasLuaContent(packageDir)) {
      // No project: Rojo syncs the package directory as-is (a root init.lua
      // makes it a ModuleScript, e.g. @rbxts/services); rbxtsc imports append
      // any subpath (e.g. "sift", "out").
      items += projectNodeItems(entry.name, { $path: '.' }, packageDir, depth);
    }
  }
  return items;
}

// Mirrors vendor/ui-renderer/default.project.json: out/ at the root, include/ as a
// child with node_modules/@rbxts and node_modules/@rbxts-js inside it.
function buildRendererItems() {
  if (variantName !== 'main') return '';
  if (!existsSync(join(rendererOutDir, 'McpPreview.luau'))) {
    console.error(`Story renderer not built at ${rendererOutDir}`);
    console.error('Run "node scripts/build-ui-renderer.mjs" first (requires the vendor/ui-renderer submodule and pnpm).');
    process.exit(1);
  }
  const outItems = buildModuleItems(rendererOutDir, 1);
  const runtimeItems = buildModuleItems(rendererIncludeDir, 2);
  let scopeItems = '';
  for (const scope of ['@rbxts', '@rbxts-js']) {
    const scopeDir = join(rendererDir, 'node_modules', scope);
    if (!existsSync(scopeDir)) continue;
    const packages = buildPackageScopeItems(scopeDir, 4);
    if (packages) scopeItems += folderItem(scope, packages, 3);
  }
  const nodeModules = scopeItems ? folderItem('node_modules', scopeItems, 2) : '';
  return folderItem('UIRenderer', outItems + folderItem('include', runtimeItems + nodeModules, 1), 0);
}

const rendererItems = buildRendererItems();

function countModules(dir) {
  if (!existsSync(dir)) return 0;
  let count = 0;
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (isDirectoryEntry(entry, join(dir, entry.name))) {
      count += countModules(join(dir, entry.name));
      if (findInitFile(join(dir, entry.name))) count++;
    } else if (isLuaFile(entry.name) && !INIT_FILENAMES.has(entry.name)) {
      count++;
    }
  }
  return count;
}

const rbxmx = `<?xml version="1.0" encoding="utf-8"?>
<roblox version="4">
  <Item class="Script" referent="0">
    <Properties>
      <string name="Name">${variant.scriptName}</string>
      <token name="RunContext">0</token>
      <string name="Source"><![CDATA[${escapeCdata(mainSource)}]]></string>
    </Properties>
    <Item class="Folder" referent="1">
      <Properties>
        <string name="Name">modules</string>
      </Properties>${moduleItems}
    </Item>${includeItems ? `
    <Item class="Folder" referent="${++refId}">
      <Properties>
        <string name="Name">include</string>
      </Properties>${includeItems}
    </Item>` : ''}${rbxtsItems ? `
    <Item class="Folder" referent="${++refId}">
      <Properties>
        <string name="Name">node_modules</string>
      </Properties>
      <Item class="Folder" referent="${++refId}">
        <Properties>
          <string name="Name">@rbxts</string>
        </Properties>${rbxtsItems}
      </Item>
    </Item>` : ''}${rendererItems}
  </Item>
</roblox>
`;

writeFileSync(outputPath, rbxmx, 'utf8');
const moduleCount = countModules(modulesDir);
const includeCount = countModules(includeDir);
const rbxtsCount = countModules(nodeModulesRbxtsDir);
console.log(`Built studio-plugin/${variant.outputName} (${moduleCount} modules${includeCount > 0 ? `, ${includeCount} runtime includes` : ''}${rbxtsCount > 0 ? `, ${rbxtsCount} @rbxts packages` : ''}${rendererItems ? ', story renderer' : ''})`);

function resolveWslWindowsPluginsDir() {
  // On WSL, walk /mnt/c/Users/*/AppData/Local/Roblox/Plugins and return the
  // one that already exists. Single-user dev boxes have exactly one; if there
  // are multiple, the user can set MCP_PLUGINS_DIR explicitly.
  try {
    const usersDir = '/mnt/c/Users';
    if (!existsSync(usersDir)) return undefined;
    const candidates = readdirSync(usersDir)
      .map((u) => join(usersDir, u, 'AppData', 'Local', 'Roblox', 'Plugins'))
      .filter((p) => existsSync(p));
    if (candidates.length === 1) return candidates[0];
    if (candidates.length > 1) {
      console.warn(
        `[build-plugin] multiple WSL Studio plugin folders found; set MCP_PLUGINS_DIR to disambiguate:\n  ${candidates.join('\n  ')}`,
      );
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function resolvePluginsDir() {
  // Explicit override wins. Useful for CI or unconventional Studio installs.
  if (process.env.MCP_PLUGINS_DIR) return process.env.MCP_PLUGINS_DIR;

  switch (process.platform) {
    case 'win32':
      return join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'Roblox', 'Plugins');
    case 'darwin':
      return join(homedir(), 'Documents', 'Roblox', 'Plugins');
    case 'linux': {
      // WSL hosts Studio on the Windows side; translate the Windows path.
      const wslDir = resolveWslWindowsPluginsDir();
      if (wslDir) return wslDir;
      return undefined;
    }
    default:
      return undefined;
  }
}

const PLUGIN_INSTALL_LOCK_NAME = '.robloxstudio-mcp-plugin-install.lock';

function acquirePluginInstallLock(pluginsDir) {
  const lockPath = join(pluginsDir, PLUGIN_INSTALL_LOCK_NAME);
  const ownerPath = join(lockPath, 'owner.json');
  const owner = {
    pid: process.pid,
    token: randomUUID(),
    createdAt: Date.now(),
  };

  try {
    mkdirSync(lockPath);
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    throw new Error(
      `Another Studio plugin installation is already in progress: ${lockPath}. ` +
        'If no installer is running, remove that lock directory and retry.',
    );
  }

  try {
    writeFileSync(ownerPath, `${JSON.stringify(owner)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    });
  } catch (error) {
    try {
      rmSync(lockPath, { recursive: true, force: true });
    } catch (cleanupError) {
      console.warn(`[build-plugin] Could not clean failed install lock ${lockPath}: ${cleanupError}`);
    }
    throw error;
  }

  return () => {
    try {
      const currentOwner = JSON.parse(readFileSync(ownerPath, 'utf8'));
      if (currentOwner.pid === owner.pid && currentOwner.token === owner.token) {
        rmSync(lockPath, { recursive: true, force: true });
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        console.warn(`[build-plugin] Could not release install lock ${lockPath}: ${error}`);
      }
    }
  };
}

if (process.argv.includes('--build-only')) {
  console.log('Skipped Studio install (--build-only).');
} else {
  const pluginsDir = resolvePluginsDir();
  if (pluginsDir) {
    mkdirSync(pluginsDir, { recursive: true });
    const installPath = join(pluginsDir, variant.outputName);
    const tempInstallPath = join(pluginsDir, `.${variant.outputName}.${randomUUID()}.tmp`);
    let releaseInstallLock;
    try {
      copyFileSync(outputPath, tempInstallPath, constants.COPYFILE_EXCL);
      releaseInstallLock = acquirePluginInstallLock(pluginsDir);
      renameSync(tempInstallPath, installPath);

      const otherInstallPath = join(pluginsDir, otherVariant.outputName);
      if (existsSync(otherInstallPath)) {
        try {
          unlinkSync(otherInstallPath);
          console.log(`Removed conflicting ${otherVariant.outputName} from ${pluginsDir}`);
        } catch (error) {
          console.warn(
            `[build-plugin] Could not remove conflicting ${otherInstallPath}: ${error}. ` +
              'Continuing with both variants present.',
          );
        }
      }
      console.log(`Installed to ${installPath}`);
    } finally {
      try {
        unlinkSync(tempInstallPath);
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          console.warn(`[build-plugin] Could not remove staging file ${tempInstallPath}: ${error}`);
        }
      }
      releaseInstallLock?.();
    }
  } else {
    console.log(
      `Skipped install: no Studio plugins folder resolvable on ${process.platform}. ` +
      `Set MCP_PLUGINS_DIR or copy ${variant.outputName} manually.`,
    );
  }
}
