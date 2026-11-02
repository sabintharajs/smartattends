import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const apiPort = process.env.PORT || env.PORT || '4000';

  return {
    plugins: [react()],
    server: {
      proxy: { '/api': `http://localhost:${apiPort}` },
    },
    build: {
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (id.includes('/node_modules/recharts/')) return 'charts';
          },
        },
      },
    },
  };
});
