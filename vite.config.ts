import {fileURLToPath} from 'node:url';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import {defineConfig} from 'vitest/config';

export default defineConfig({
  root: 'frontend',
  plugins: [react(), tailwindcss()],
  resolve: {alias: {'@': fileURLToPath(new URL('./frontend/src', import.meta.url))}},
  build: {outDir: '../dist', emptyOutDir: true},
  server: {
    host: '127.0.0.1',
    proxy: {'/api': {target: 'http://127.0.0.1:8000', changeOrigin: true, headers: {origin: 'http://127.0.0.1:8000'}}},
  },
  test: {
    maxWorkers: 2,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    restoreMocks: true,
    clearMocks: true,
  },
});
