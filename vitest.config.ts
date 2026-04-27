import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
    include: ['apps/**/*.test.{ts,tsx}', 'packages/**/*.test.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html']
    }
  },
  resolve: {
    alias: {
      '@agent-pulse/shared': new URL('./packages/shared/src/index.ts', import.meta.url).pathname
    }
  }
});
