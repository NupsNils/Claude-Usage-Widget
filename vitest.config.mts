import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', '.claude/hooks/**/*.test.mjs'],
    environment: 'node',
  },
});
