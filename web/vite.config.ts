import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev: proxy /bff -> the BFF so the browser never sees Zabbix (instruct §7).
// /bff/api/hosts  ->  http://localhost:4000/api/hosts
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/bff': {
        target: 'http://localhost:4000',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/bff/, ''),
      },
    },
  },
});
