import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    include: ['src/__tests__/**/*.test.{ts,tsx}'],
    setupFiles: ['src/__tests__/setup.ts'],
    // Vitest blanks every stylesheet by default; narrowScreen.test.tsx reads styles.css as text.
    css: { include: [/styles\.css/] },
    // Each file gets a fresh api.ts: its session state is module-level.
    isolate: true,
  },
});
