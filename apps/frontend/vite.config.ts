import path from 'node:path';
import {
    DISCOVERY_VERSION,
    type InstanceDocument,
    PROTOCOL_VERSION,
} from '@bolter/protocol/instance';
import { DOWNLOAD_LIMITS, TIME_LIMITS, UI_DEFAULTS, UPLOAD_LIMITS } from '@bolter/shared';
import { sentryVitePlugin } from '@sentry/vite-plugin';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

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

/**
 * Emit `/instance.json` alongside the built app.
 *
 * A share link names this origin, but the API is a separate deployment, and
 * nothing else in the protocol lets a client holding only the link find it.
 * The backend serves the same document and is authoritative for runtime
 * limits; this copy exists because it is the one reachable from a share URL.
 */
function instanceJsonPlugin(): Plugin {
    return {
        name: 'instance-json',
        apply: 'build',
        generateBundle() {
            const api = process.env.VITE_API_URL || 'http://localhost:3001';
            const document: InstanceDocument = {
                bolter: DISCOVERY_VERSION,
                name: process.env.VITE_APP_TITLE || UI_DEFAULTS.TITLE,
                description: process.env.VITE_APP_DESCRIPTION || UI_DEFAULTS.DESCRIPTION,
                // `web` is deliberately absent: a static file cannot know the
                // origin it will be served from, and the client that fetched
                // it does.
                api,
                protocol: { version: PROTOCOL_VERSION, min: PROTOCOL_VERSION },
                features: [
                    'multipart',
                    'resume',
                    'ece-v1',
                    'owner-tokens',
                    'password',
                    'zip-at-upload',
                ],
                limits: {
                    maxFileSize: UPLOAD_LIMITS.MAX_FILE_SIZE,
                    maxFilesPerArchive: UPLOAD_LIMITS.MAX_FILES_PER_ARCHIVE,
                    maxExpireSeconds: TIME_LIMITS.MAX_EXPIRE_SECONDS,
                    maxDownloads: DOWNLOAD_LIMITS.MAX_DOWNLOADS,
                    multipartThreshold: UPLOAD_LIMITS.MULTIPART_THRESHOLD,
                    minPartSize: UPLOAD_LIMITS.MIN_PART_SIZE,
                    maxParts: UPLOAD_LIMITS.MAX_PARTS,
                    maxMetadataBytes: UPLOAD_LIMITS.MAX_METADATA_BYTES,
                },
                defaults: {
                    expireSeconds: TIME_LIMITS.DEFAULT_EXPIRE_SECONDS,
                    downloads: DOWNLOAD_LIMITS.DEFAULT_DOWNLOADS,
                },
                cli: { package: 'sendfm', install: 'https://send.fm/install.sh' },
            };
            this.emitFile({
                type: 'asset',
                fileName: 'instance.json',
                source: `${JSON.stringify(document, null, 2)}\n`,
            });
        },
    };
}

export default defineConfig({
    plugins: [
        react(),
        htmlConfigPlugin(),
        instanceJsonPlugin(),
        process.env.SENTRY_AUTH_TOKEN &&
            sentryVitePlugin({
                url: 'https://glitch.slingshot.fm',
                org: process.env.SENTRY_ORG,
                project: process.env.SENTRY_PROJECT,
                authToken: process.env.SENTRY_AUTH_TOKEN,
                sourcemaps: {
                    filesToDeleteAfterUpload: ['**/*.map'],
                },
            }),
    ],
    resolve: {
        alias: {
            '@': path.resolve(__dirname, './src'),
        },
    },
    server: {
        port: 3000,
        allowedHosts: true,
    },
    build: {
        outDir: 'dist',
        sourcemap: 'hidden',
    },
});
