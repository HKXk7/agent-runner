import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:8787' },
  },
  // workspace 共享包入口是 .ts 源码，不走预构建
  optimizeDeps: { exclude: ['@agent-runner/shared'] },
});
