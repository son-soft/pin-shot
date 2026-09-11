import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import pkg from '../package.json' with { type: 'json' };

export default defineConfig({
  root: 'frontend',
  clearScreen: false,
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  server: {
    port: 1420,
    strictPort: true,
  },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      onwarn(warning, warn) {
        if (warning.code === 'EVAL') return;
        warn(warning);
      },
    },
    rolldownOptions: {
      onwarn(warning: any, warn: any) {
        if (warning?.code === 'EVAL') return;
        warn(warning);
      },
    },
  },
});
