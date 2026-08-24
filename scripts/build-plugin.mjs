#!/usr/bin/env node

import { readFileSync, readdirSync, writeFileSync, copyFileSync, existsSync, mkdirSync, statSync, unlinkSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, basename } from 'path';
import { homedir } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');
const { version: VERSION } = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8'));
const pluginDir = join(rootDir, 'studio-plugin');
const outDir = join(pluginDir, 'out');
const serverDir = join(outDir, 'server');
const modulesDir = join(outDir, 'modules');
const includeDir = join(pluginDir, 'include');
const nodeModulesRbxtsDir = join(pluginDir, 'node_modules', '@rbxts');

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

function isLuaFile(name) {
  return name.endsWith('.luau') || name.endsWith('.lua');
}

function dirHasLuaContent(dir) {
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isFile() && isLuaFile(entry.name)) return true;
    if (entry.isDirectory() && dirHasLuaContent(join(dir, entry.name))) return true;
  }
  return false;
}

function buildModuleItems(dir, depth = 0) {
  if (!existsSync(dir)) return '';

  let items = '';
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);

    if (entry.isDirectory()) {
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

function countModules(dir) {
  if (!existsSync(dir)) return 0;
  let count = 0;
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
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
    </Item>` : ''}
  </Item>
</roblox>
`;

writeFileSync(outputPath, rbxmx, 'utf8');
const moduleCount = countModules(modulesDir);
const includeCount = countModules(includeDir);
const rbxtsCount = countModules(nodeModulesRbxtsDir);
console.log(`Built studio-plugin/${variant.outputName} (${moduleCount} modules${includeCount > 0 ? `, ${includeCount} runtime includes` : ''}${rbxtsCount > 0 ? `, ${rbxtsCount} @rbxts packages` : ''})`);

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

const pluginsDir = resolvePluginsDir();
if (pluginsDir) {
  mkdirSync(pluginsDir, { recursive: true });
  const otherInstallPath = join(pluginsDir, otherVariant.outputName);
  if (existsSync(otherInstallPath)) {
    unlinkSync(otherInstallPath);
    console.log(`Removed conflicting ${otherVariant.outputName} from ${pluginsDir}`);
  }
  const installPath = join(pluginsDir, variant.outputName);
  copyFileSync(outputPath, installPath);
  console.log(`Installed to ${installPath}`);
} else {
  console.log(
    `Skipped install: no Studio plugins folder resolvable on ${process.platform}. ` +
    `Set MCP_PLUGINS_DIR or copy ${variant.outputName} manually.`,
  );
}
