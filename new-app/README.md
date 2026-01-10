# Bolter - Encrypted File Sharing

A modern, end-to-end encrypted file sharing application built with Bun.

## Stack

- **Frontend**: Vite + React + TypeScript + Tailwind CSS
- **Backend**: Elysia (Bun) + S3/R2 + Redis
- **Encryption**: AES-GCM with HKDF key derivation (client-side)

## Quick Start

```bash
# Install dependencies for all workspaces
cd new-app
bun install

# Run both frontend and backend in development
bun run dev

# Or run them separately:
bun run dev:frontend  # Frontend on http://localhost:3000
bun run dev:backend   # Backend on http://localhost:3001
```

## Project Structure

```
new-app/
├── frontend/          # Vite + React frontend
│   ├── src/
│   │   ├── components/   # UI components (shadcn-style)
│   │   ├── lib/          # Crypto, API utilities
│   │   ├── pages/        # Route pages
│   │   └── stores/       # Zustand state
│   └── package.json
├── backend/           # Elysia backend
│   ├── src/
│   │   ├── routes/       # API endpoints
│   │   ├── storage/      # S3 + Redis adapters
│   │   └── middleware/   # Auth, etc
│   └── package.json
└── package.json       # Workspace root
```

## Environment Variables

### Backend

```bash
# S3/R2 Storage
S3_BUCKET=your-bucket
S3_ENDPOINT=https://your-r2-endpoint.r2.cloudflarestorage.com
AWS_ACCESS_KEY_ID=xxx
AWS_SECRET_ACCESS_KEY=xxx

# Redis
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=  # optional

# Server
PORT=3001
BASE_URL=http://localhost:3001
```

## Features

- **Direct-to-cloud uploads**: Files upload directly to S3/R2 via pre-signed URLs
- **Multipart support**: Large files (>100MB) use multipart uploads with resume
- **End-to-end encryption**: Files encrypted in browser before upload
- **Automatic expiration**: Files auto-delete after time or download limit
- **No account required**: Share links contain the encryption key
