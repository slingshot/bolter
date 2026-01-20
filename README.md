# Bolter - Encrypted File Sharing

A modern, end-to-end encrypted file sharing application built with Bun.

## Stack

- **Frontend**: Vite + React + TypeScript + Tailwind CSS (Figma-based design system)
- **Backend**: Elysia (Bun) + S3/R2 + Redis
- **Encryption**: AES-GCM with HKDF key derivation (client-side)
- **Design**: Custom dark theme with Slingshot branding

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
├── shared/            # Shared configuration constants
│   └── config.ts         # BYTES, UPLOAD_LIMITS, TIME_LIMITS, etc.
└── package.json       # Workspace root
```

## Environment Variables

Create a `.env.local` file in the `new-app` directory:

```bash
# S3/R2 Storage (required)
S3_BUCKET=your-bucket
S3_ENDPOINT=https://your-r2-endpoint.r2.cloudflarestorage.com
AWS_ACCESS_KEY_ID=xxx
AWS_SECRET_ACCESS_KEY=xxx

# Redis (required) - Use full connection string
REDIS_URL=redis://localhost:6379
# For Redis with auth: redis://username:password@host:port
# For TLS: rediss://username:password@host:port

# Server
PORT=3001
BASE_URL=http://localhost:3001
DETECT_BASE_URL=false  # Set to 'true' to auto-detect from request headers

# Upload Limits
MAX_FILE_SIZE=1099511627776      # Max file size in bytes (default: 1TB)
MAX_FILES_PER_ARCHIVE=64         # Max files per archive (default: 64)

# Time Limits
MAX_EXPIRE_SECONDS=604800        # Max expiration time in seconds (default: 7 days)
DEFAULT_EXPIRE_SECONDS=86400     # Default expiration in seconds (default: 1 day)
EXPIRE_TIMES_SECONDS=300,3600,86400,604800  # Comma-separated expire time options

# Download Limits
MAX_DOWNLOADS=100                # Maximum download count option (default: 100)
DEFAULT_DOWNLOADS=1              # Default download limit (default: 1)
DOWNLOAD_COUNTS=1,2,3,4,5,20,50,100  # Comma-separated download count options

# UI Customization (backend - runtime)
CUSTOM_TITLE=Slingshot Send      # App title shown in header and page title
CUSTOM_DESCRIPTION=Encrypt and send files with a link that automatically expires.

# UI Customization (frontend - build time)
VITE_APP_TITLE=Slingshot Send    # HTML title tag (set at build time)
VITE_APP_DESCRIPTION=Encrypt and send files with a link that automatically expires.
```

> **Note**: The dev commands automatically load `.env` and `.env.local` files via `@dotenvx/dotenvx`. Values in `.env.local` override those in `.env`.

### Build-time vs Runtime Configuration

- **Build-time** (`VITE_APP_*`): Used for HTML `<title>` and `<meta>` tags. Set these before running `bun run build`.
- **Runtime** (`CUSTOM_*`): Served by the backend via `/config` endpoint. The frontend updates the page title/description after loading config, overriding build-time values.

### Environment Variable Reference

| Variable | Default | Description |
|----------|---------|-------------|
| `S3_BUCKET` | (required) | S3/R2 bucket name |
| `S3_ENDPOINT` | (required) | S3/R2 endpoint URL |
| `AWS_ACCESS_KEY_ID` | (required) | S3/R2 access key |
| `AWS_SECRET_ACCESS_KEY` | (required) | S3/R2 secret key |
| `REDIS_URL` | `redis://localhost:6379` | Redis connection string |
| `PORT` | `3001` | Backend server port |
| `BASE_URL` | `http://localhost:3001` | Public base URL |
| `DETECT_BASE_URL` | `false` | Auto-detect base URL from requests |
| `MAX_FILE_SIZE` | `1099511627776` (1TB) | Maximum upload size in bytes |
| `MAX_FILES_PER_ARCHIVE` | `64` | Max files per upload |
| `MAX_EXPIRE_SECONDS` | `604800` (7 days) | Maximum expiration time |
| `DEFAULT_EXPIRE_SECONDS` | `86400` (1 day) | Default expiration time |
| `EXPIRE_TIMES_SECONDS` | `300,3600,86400,604800` | Dropdown options for expiration |
| `MAX_DOWNLOADS` | `100` | Maximum download limit |
| `DEFAULT_DOWNLOADS` | `1` | Default download limit |
| `DOWNLOAD_COUNTS` | `1,2,3,4,5,20,50,100` | Dropdown options for downloads |
| `CUSTOM_TITLE` | `Slingshot Send` | App title for branding (runtime) |
| `CUSTOM_DESCRIPTION` | (see above) | App description for SEO (runtime) |
| `VITE_APP_TITLE` | `Slingshot Send` | HTML title tag (build-time) |
| `VITE_APP_DESCRIPTION` | (see above) | HTML meta description (build-time) |

## Features

- **Direct-to-cloud uploads**: Files upload directly to S3/R2 via pre-signed URLs
- **Multipart support**: Large files (>100MB) use multipart uploads with resume
- **End-to-end encryption**: Files encrypted in browser before upload
- **Automatic expiration**: Files auto-delete after time or download limit
- **No account required**: Share links contain the encryption key
