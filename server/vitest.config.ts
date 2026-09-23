import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/__tests__/**/*.test.ts'],
    // Route tests mock '../zabbix.js' per file; without isolation a mock from
    // one file would leak into the next through the ESM module cache.
    isolate: true,
  },
});
