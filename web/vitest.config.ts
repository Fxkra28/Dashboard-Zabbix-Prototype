import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['src/__tests__/setup.ts'],
    // Vitest blanks every stylesheet by default; the tests read the stylesheet as text (src/__tests__/stylesheet.ts).
    css: { include: [/styles\/.*\.css/] },
    // Each file gets a fresh api.ts: its session state is module-level.
    isolate: true,
  },
});
