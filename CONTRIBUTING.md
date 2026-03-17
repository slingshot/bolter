# Contributing to Bolter

Thanks for your interest in contributing to Bolter. This document covers everything you need to get started.

## Table of Contents

- [Prerequisites](#prerequisites)
- [Development Setup](#development-setup)
- [Project Structure](#project-structure)
- [Development Workflow](#development-workflow)
- [Code Style](#code-style)
- [Commit Conventions](#commit-conventions)
- [Pull Request Process](#pull-request-process)
- [Reporting Issues](#reporting-issues)

## Prerequisites

- [Bun](https://bun.sh) v1.x — runtime and package manager
- [Redis](https://redis.io) v7+ — metadata storage (or use Docker: `docker run -d -p 6379:6379 redis:7-alpine`)
- An S3-compatible object store for development — [MinIO](https://min.io) works well locally, or use [Cloudflare R2](https://developers.cloudflare.com/r2/)
- [Git](https://git-scm.com)

## Development Setup

1. **Fork and clone** the repository:

   ```bash
   git clone https://github.com/<your-username>/bolter.git
   cd bolter
   ```

2. **Install dependencies** (this also sets up git hooks via lefthook):

   ```bash
   bun install
   ```

3. **Configure environment variables**:

   ```bash
   cp .env.example .env.local
   ```

   Edit `.env.local` with your S3/R2 credentials and Redis URL. See the [README](README.md#configuration) for the full variable reference.

4. **Start development**:

   ```bash
   bun run dev
   ```

   This runs both the frontend (`http://localhost:3000`) and backend (`http://localhost:3001`) concurrently via Turborepo.

5. **Verify everything works**:

   ```bash
   bun run typecheck   # Type check all workspaces
   bun run check       # Lint + format with Biome
   ```

## Project Structure

```
bolter/
├── apps/
│   ├── frontend/          # React 18 + Vite + Tailwind CSS
│   │   └── src/
│   │       ├── components/   # UI components (Radix UI primitives)
│   │       ├── lib/          # Core logic: crypto, API, upload state
│   │       ├── pages/        # Route pages (Home, Download)
│   │       └── stores/       # Zustand state management
│   │
│   └── backend/           # Elysia (Bun web framework)
│       └── src/
│           ├── routes/       # API endpoints (upload, download)
│           ├── storage/      # S3 + Redis adapters
│           └── config.ts     # Environment validation (Convict)
│
├── packages/
│   └── shared/            # Shared constants (BYTES, LIMITS, etc.)
│       └── config.ts
│
├── turbo.json             # Task pipeline config
├── biome.json             # Linter + formatter
├── lefthook.yml           # Git hooks
└── docker-compose.yml     # Full stack deployment
```

### Key Source Files

| File | Purpose |
|------|---------|
| `apps/frontend/src/lib/crypto.ts` | AES-GCM encryption, HKDF key derivation |
| `apps/frontend/src/lib/api.ts` | S3 multipart uploads, stall detection, adaptive part sizing |
| `apps/frontend/src/lib/upload-state.ts` | IndexedDB persistence for upload resumability |
| `apps/frontend/src/stores/app.ts` | Zustand store (upload state, config, files) |
| `apps/backend/src/routes/upload.ts` | Pre-signed URL generation, multipart orchestration |
| `apps/backend/src/routes/download.ts` | URL signing, download count enforcement |
| `apps/backend/src/storage/s3.ts` | S3 client abstraction |
| `apps/backend/src/storage/redis.ts` | Redis metadata operations with TTL |
| `packages/shared/config.ts` | Shared constants (sizes, limits, part size tiers) |

## Development Workflow

### Running Individual Workspaces

```bash
# Frontend only
turbo run dev --filter=@bolter/frontend

# Backend only
turbo run dev --filter=@bolter/backend
```

### Building

```bash
# Build all workspaces (Turborepo-cached — instant on second run)
bun run build

# Type check
bun run typecheck
```

### Useful Commands

| Command | Description |
|---------|-------------|
| `bun run dev` | Start frontend + backend in development |
| `bun run build` | Production build (all workspaces) |
| `bun run typecheck` | Type check all workspaces |
| `bun run check` | Lint + format with Biome (auto-fix) |
| `bun run lint` | Lint only |
| `bun run format` | Format only |
| `bun run commit` | Interactive conventional commit helper |

## Code Style

This project uses [Biome](https://biomejs.dev) for linting and formatting. The configuration is in [`biome.json`](biome.json) at the repository root.

- **No manual formatting** — Biome handles it. Run `bun run check` to auto-fix.
- **TypeScript everywhere** — all code is written in TypeScript. Use strict types; avoid `any`.
- **Path aliases** — the frontend uses `@/` as an alias for `apps/frontend/src/`.
- **Shared constants** — limits, sizes, and defaults live in `packages/shared/config.ts`. Don't duplicate magic numbers across workspaces.

Biome runs automatically on staged files via a pre-commit hook ([lefthook](https://github.com/evilmartians/lefthook)). If the hook fails, fix the issues before committing.

## Commit Conventions

This project follows [Conventional Commits](https://www.conventionalcommits.org/). Commit messages are validated by [commitlint](https://commitlint.js.org/) via a `commit-msg` git hook.

### Format

```
<type>(<scope>): <description>

[optional body]

[optional footer(s)]
```

### Types

| Type | Usage |
|------|-------|
| `feat` | A new feature |
| `fix` | A bug fix |
| `docs` | Documentation changes |
| `style` | Code style (formatting, no logic change) |
| `refactor` | Code restructuring (no feature/fix) |
| `perf` | Performance improvement |
| `test` | Adding or updating tests |
| `build` | Build system or dependency changes |
| `ci` | CI configuration changes |
| `chore` | Maintenance tasks |
| `revert` | Revert a previous commit |

### Scopes

Use workspace names when the change is scoped to one workspace:

```
feat(frontend): add drag-and-drop upload zone
fix(backend): handle expired pre-signed URLs gracefully
refactor(shared): normalize byte constants
docs: update README with deployment instructions
chore(deps): bump elysia to v1.2
```

### Interactive Helper

For guided commit message creation:

```bash
bun run commit
```

## Pull Request Process

1. **Create a branch** from `main`:

   ```bash
   git checkout -b feat/my-feature
   ```

2. **Make your changes** and ensure:

   - `bun run typecheck` passes
   - `bun run check` passes
   - The app works end-to-end (upload a file, download it, verify decryption)

3. **Commit** using conventional commits.

4. **Open a pull request** against `main` with:

   - A clear description of what the PR does and why
   - Steps to test the change
   - Screenshots if the change is visual

5. **Review** — maintainers will review your PR. Address feedback by pushing additional commits (don't force-push during review).

### What Makes a Good PR

- **Focused** — one logical change per PR. Split large changes into smaller PRs.
- **Tested** — verify your change works. For crypto changes, test encryption and decryption round-trips.
- **Documented** — update the README or inline comments if you're changing behavior or configuration.

## Reporting Issues

### Bug Reports

Open an issue with:

- Steps to reproduce
- Expected behavior vs actual behavior
- Browser and OS information
- File size and type (if relevant to the bug)
- Any console errors

### Feature Requests

Open an issue describing:

- The problem you're trying to solve
- Your proposed solution
- Alternatives you've considered

### Security Vulnerabilities

**Do not open a public issue for security vulnerabilities.** See [`SECURITY.md`](SECURITY.md) for responsible disclosure instructions.

## License

By contributing to Bolter, you agree that your contributions will be licensed under the [Mozilla Public License 2.0](LICENSE).
