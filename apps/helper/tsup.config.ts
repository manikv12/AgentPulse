import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/main.ts', 'src/dev-server.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  clean: true,
  external: ['electron'],
  noExternal: ['@agent-pulse/shared']
});
