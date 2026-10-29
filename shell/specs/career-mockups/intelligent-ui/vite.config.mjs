// 预览：npx vite --config specs/career-mockups/intelligent-ui/vite.config.mjs（在 app/shell 下跑）
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';

const here = import.meta.dirname;
export default defineConfig({
  root: here, base: './', logLevel: 'warn',
  plugins: [react(), tailwindcss()],
  resolve: { dedupe: ['react', 'react-dom'], alias: [{ find: '@', replacement: resolve(here, '../../../src/renderer') }] },
  build: { outDir: resolve(here, 'dist'), emptyOutDir: true, assetsInlineLimit: 0 },
});
