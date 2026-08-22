import { defineConfig } from 'tsup';
import { copyFileSync, mkdirSync } from 'fs';
import { join } from 'path';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node20',
  bundle: true,
  splitting: false,
  clean: true,
  noExternal: ['@chrrxs/robloxstudio-mcp-core'],
  banner: {
    js: '#!/usr/bin/env node',
  },
  onSuccess: async () => {
    const assetsDir = join('dist', 'assets');
    mkdirSync(assetsDir, { recursive: true });
    copyFileSync(join('..', 'core', 'assets', 'Baseplate.rbxl'), join(assetsDir, 'Baseplate.rbxl'));
  },
});
