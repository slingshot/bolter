# AGENTS.md

This file provides guidance to AI coding agents (Claude Code, Cursor, Copilot, etc.) when working with code in this repository. It is symlinked as `CLAUDE.md` for Claude Code compatibility.

> **Important**: At the end of any work session, update both `AGENTS.md` and `README.md` if your changes affect project documentation — architecture, commands, environment variables, API endpoints, features, or configuration. Keep these files in sync with the codebase.

## Project Overview

Bolter is a file sharing application with optional end-to-end encryption. When encryption is enabled, files are encrypted client-side using AES-GCM before upload, with encryption keys embedded in shareable URLs (never sent to server). Encryption is off by default and toggled on per-upload by the user. Supports files up to 1TB via multipart uploads to S3/Cloudflare R2.

## Commands

```bash
# Install dependencies
bun install

# Development (runs both frontend and backend via Turborepo)
bun run dev

# Run individually via turbo filtering
turbo run dev --filter=@bolter/frontend  # http://localhost:3000
turbo run dev --filter=@bolter/backend   # http://localhost:3001

# Production build (cached — second run is instant)
bun run build

# Type checking (both workspaces)
bun run typecheck

# Linting / formatting (biome, runs at root)
bun run check

# Docker deployment
docker compose up
```

## Turborepo

Task pipeline is defined in `turbo.json`. Key tasks:
- `build` — depends on `^build` (shared builds first), outputs cached in `dist/**`
- `dev` — persistent, not cached, depends on `^build`
- `typecheck` — depends on `^build`

Environment variables that affect build output (`VITE_*`, `SENTRY_*`, `NODE_ENV`) are in `build.env` for cache busting. Runtime-only vars (S3, Redis, limits, etc.) are in `globalPassThroughEnv`.

## Architecture

**Monorepo Structure** (Turborepo + Bun workspaces):
- `apps/frontend/` - Vite + React 18 + TypeScript + Tailwind
- `apps/backend/` - Elysia (Bun web framework) + TypeScript
- `packages/shared/` - Constants exported to both (BYTES, LIMITS, DEFAULTS)

**Data Flow**:
1. Frontend optionally encrypts files with Web Crypto API (AES-GCM + HKDF key derivation)
2. Backend provides pre-signed S3 URLs for direct cloud uploads (no file handling)
3. Redis stores metadata (TTL, download limits, encryption flags)
4. Download URLs contain encryption key in hash fragment for client-side decryption (when encrypted)

**Resilient Uploads**:
- **Upload resumability**: Multipart upload state (uploadId, completed parts, encryption counter) is persisted to IndexedDB via `apps/frontend/src/lib/upload-state.ts`. On page reload, the user is prompted to resume incomplete uploads, skipping already-uploaded parts.
- **Preflight speed test**: Before multipart uploads (>100MB), a speed test uploads 5x100MB parts concurrently to S3 via pre-signed URLs to measure real throughput, then cleans up the test objects.
- **Adaptive part sizing**: Upload part size is selected from `PART_SIZE_TIERS` (defined in `packages/shared/config.ts`) based on the measured upload speed from the preflight test.
- **Stall detection**: Instead of hard XHR timeouts, uploads use progress-based stall detection — if no bytes are transferred for a threshold period, the part is retried. Retries pause automatically when the browser goes offline.
- **Connection quality UI**: The upload progress component displays real-time connection quality states (e.g., "Checking speed...", online/offline awareness) and updates every second during uploads.

**Key Backend Components**:
- `apps/backend/src/routes/upload.ts` - Pre-signed URL generation, multipart orchestration, resume endpoint, speed test endpoints
- `apps/backend/src/routes/download.ts` - URL signing, download count enforcement
- `apps/backend/src/storage/s3.ts` - S3 client with multipart support
- `apps/backend/src/storage/redis.ts` - Metadata operations with TTL
- `apps/backend/src/config.ts` - Environment validation via Convict

**Key Frontend Components**:
- `apps/frontend/src/lib/crypto.ts` - AES-GCM encryption, HKDF key derivation
- `apps/frontend/src/lib/api.ts` - Direct S3 multipart uploads, download logic, stall detection, adaptive part sizing
- `apps/frontend/src/lib/upload-state.ts` - IndexedDB persistence for multipart upload resumability
- `apps/frontend/src/stores/app.ts` - Zustand store (config, upload state, files)
- `apps/frontend/src/pages/Home.tsx` - Upload interface
- `apps/frontend/src/pages/Download.tsx` - Download/decryption interface

**Path Alias**: `@/` maps to `apps/frontend/src/`

## Environment Variables

Required for local development:
- `S3_BUCKET`, `S3_ENDPOINT` - Cloudflare R2 bucket config
- `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` - R2 credentials
- `REDIS_URL` - Redis connection (default: `redis://localhost:6379`)

See `.env.example` for full list of configurable limits and UI options.

## API Endpoints

- `GET /health` - Full health check (Redis + S3)
- `GET /config` - Client configuration (limits, defaults)
- `POST /upload/url` - Request pre-signed upload URL
- `POST /upload/multipart/:id` - Initiate multipart upload
- `POST /upload/multipart/:id/resume` - List completed parts for upload resumption
- `POST /upload/speedtest` - Generate pre-signed URLs for preflight speed test parts
- `POST /upload/speedtest/cleanup` - Clean up speed test objects from S3
- `GET /download/url/:id` - Get pre-signed download URL

## Documentation Maintenance

When making changes to the project, ensure the following files stay in sync:

- **`AGENTS.md`** — architecture, commands, env vars, API endpoints, key components
- **`README.md`** — features, configuration tables, API reference, deployment instructions
- **`SECURITY.md`** — if encryption or security model changes
- **`CONTRIBUTING.md`** — if project structure or dev workflow changes
