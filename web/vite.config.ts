import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// Dev: proxy /bff -> the BFF so the browser never sees Zabbix (instruct §7).
// /bff/api/hosts  ->  http://localhost:4000/api/hosts
//
// Both are overridable so the two portal variants can run side by side, e.g.
//   VITE_PORT=5174 BFF_URL=http://localhost:4001 npm run dev
// strictPort: when 5173 was taken Vite used to move to 5174 silently while
// still proxying to :4000: a page that looked like one portal and talked to
// the other's BFF. Now it stops and says the port is in use.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '');
  return {
    plugins: [react()],
    server: {
      port: Number(env.VITE_PORT) || 5173,
      strictPort: true,
      proxy: {
        '/bff': {
          target: env.BFF_URL || 'http://localhost:4000',
          changeOrigin: true,
          rewrite: (p: string) => p.replace(/^\/bff/, ''),
        },
      },
    },
  };
});
