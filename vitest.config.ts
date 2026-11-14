import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    env: {
      OMEN_FEED_SHIM: '1',
    },
    coverage: {
      reporter: ['text', 'lcov'],
    },
  },
});
