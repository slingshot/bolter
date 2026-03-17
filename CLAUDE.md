# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Bolter is an end-to-end encrypted file sharing application. Files are encrypted client-side using AES-GCM before upload, with encryption keys embedded in shareable URLs (never sent to server). Supports files up to 1TB via multipart uploads to S3/Cloudflare R2.

## Commands

```bash
# Install dependencies
bun install

# Development (runs both frontend and backend)
bun run dev

# Run individually
bun run dev:frontend  # http://localhost:3000
bun run dev:backend   # http://localhost:3001

# Production build
bun run build

# Start production
bun run start

# Docker deployment
docker-compose up
```

## Architecture

**Monorepo Structure** (Bun workspaces):
- `frontend/` - Vite + React 18 + TypeScript + Tailwind
- `backend/` - Elysia (Bun web framework) + TypeScript
- `shared/` - Constants exported to both (BYTES, LIMITS, DEFAULTS)

**Data Flow**:
1. Frontend encrypts files with Web Crypto API (AES-GCM + HKDF key derivation)
2. Backend provides pre-signed S3 URLs for direct cloud uploads (no file handling)
3. Redis stores metadata (TTL, download limits, encryption flags)
4. Download URLs contain encryption key in hash fragment for client-side decryption

**Resilient Uploads**:
- **Upload resumability**: Multipart upload state (uploadId, completed parts, encryption counter) is persisted to IndexedDB via `frontend/src/lib/upload-state.ts`. On page reload, the user is prompted to resume incomplete uploads, skipping already-uploaded parts.
- **Preflight speed test**: Before multipart uploads (>100MB), a speed test uploads 5x100MB parts concurrently to S3 via pre-signed URLs to measure real throughput, then cleans up the test objects.
- **Adaptive part sizing**: Upload part size is selected from `PART_SIZE_TIERS` (defined in `shared/config.ts`) based on the measured upload speed from the preflight test.
- **Stall detection**: Instead of hard XHR timeouts, uploads use progress-based stall detection — if no bytes are transferred for a threshold period, the part is retried. Retries pause automatically when the browser goes offline.
- **Connection quality UI**: The upload progress component displays real-time connection quality states (e.g., "Checking speed...", online/offline awareness) and updates every second during uploads.

**Key Backend Components**:
- `backend/src/routes/upload.ts` - Pre-signed URL generation, multipart orchestration, resume endpoint, speed test endpoints
- `backend/src/routes/download.ts` - URL signing, download count enforcement
- `backend/src/storage/s3.ts` - S3 client with multipart support
- `backend/src/storage/redis.ts` - Metadata operations with TTL
- `backend/src/config.ts` - Environment validation via Convict

**Key Frontend Components**:
- `frontend/src/lib/crypto.ts` - AES-GCM encryption, HKDF key derivation
- `frontend/src/lib/api.ts` - Direct S3 multipart uploads, download logic, stall detection, adaptive part sizing
- `frontend/src/lib/upload-state.ts` - IndexedDB persistence for multipart upload resumability
- `frontend/src/stores/app.ts` - Zustand store (config, upload state, files)
- `frontend/src/pages/Home.tsx` - Upload interface
- `frontend/src/pages/Download.tsx` - Download/decryption interface

**Path Alias**: `@/` maps to `frontend/src/`

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
