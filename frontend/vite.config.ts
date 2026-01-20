import { defineConfig, Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { sentryVitePlugin } from '@sentry/vite-plugin';
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
  plugins: [
    react(),
    htmlConfigPlugin(),
    sentryVitePlugin({
      url: 'https://glitch.slingshot.fm',
      org: process.env.SENTRY_ORG,
      project: process.env.SENTRY_PROJECT,
      authToken: process.env.SENTRY_AUTH_TOKEN,
    }),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 3000,
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
