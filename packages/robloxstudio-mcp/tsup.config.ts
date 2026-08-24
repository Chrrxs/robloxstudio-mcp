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
  shims: true,
  noExternal: [/(.*)/],
  banner: {
    js: `#!/usr/bin/env node
import { createRequire as __createRequire } from 'module';
const require = __createRequire(import.meta.url);`,
  },
  onSuccess: async () => {
    const assetsDir = join('dist', 'assets');
    mkdirSync(assetsDir, { recursive: true });
    copyFileSync(join('..', 'core', 'assets', 'Baseplate.rbxl'), join(assetsDir, 'Baseplate.rbxl'));
  },
});
