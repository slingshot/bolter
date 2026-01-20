import { defineConfig, Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { UI_DEFAULTS } from '@bolter/shared';

// Plugin to inject app config into index.html at build time
function htmlConfigPlugin(): Plugin {
  return {
    name: 'html-config',
    transformIndexHtml(html) {
      const title = process.env.VITE_APP_TITLE || UI_DEFAULTS.TITLE;
      const description = process.env.VITE_APP_DESCRIPTION || UI_DEFAULTS.DESCRIPTION;

      return html
        .replace('<!--app-title-->', title)
        .replace('<!--app-description-->', description);
    },
  };
}

export default defineConfig({
  plugins: [react(), htmlConfigPlugin()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 3000,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
      '/config': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
