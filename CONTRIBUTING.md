# Contributing to Bolter

Thank you for your interest in contributing to Bolter! This guide will help you get started.

## Prerequisites

- [Bun](https://bun.sh/) v1.0+
- [Docker](https://www.docker.com/) (optional, for containerized development)
- A Cloudflare R2 or S3-compatible bucket for storage
- A Redis instance

## Getting Started

1. Fork the repository
2. Clone your fork:
   ```bash
   git clone https://github.com/<your-username>/bolter.git
   cd bolter
   ```
3. Install dependencies:
   ```bash
   bun install
   ```
4. Copy the environment file and fill in your values:
   ```bash
   cp .env.example .env
   ```
5. Start the development servers:
   ```bash
   bun run dev
   ```

## Project Structure

```
bolter/
├── frontend/   # Vite + React 18 + TypeScript + Tailwind
├── backend/    # Elysia (Bun) + TypeScript
├── shared/     # Constants shared between frontend and backend
└── docker/     # Docker configuration
```

## Coding Standards

### Linting & Formatting

We use [Biome](https://biomejs.dev/) for linting and formatting. Pre-commit hooks run automatically via Lefthook.

```bash
bun run check    # lint + format (with auto-fix)
bun run lint     # lint only
bun run format   # format only
```

### Commit Messages

We follow [Conventional Commits](https://www.conventionalcommits.org/). Commit messages are validated by commitlint on each commit.

**Format:** `<type>(<scope>): <description>`

**Types:** `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`

**Scopes:** `frontend`, `backend`, `shared`, `deps`, `ci`, `docker`, `release`

You can use the interactive commit helper:
```bash
bun run commit
```

### Examples

```
feat(frontend): add drag-and-drop upload zone
fix(backend): handle expired pre-signed URLs gracefully
docs: update README with deployment instructions
chore(deps): bump elysia to v1.2
```

## Pull Request Process

1. Create a feature branch from `main`:
   ```bash
   git checkout -b feat/my-feature
   ```
2. Make your changes and commit using conventional commits
3. Push your branch and open a Pull Request against `main`
4. Fill out the PR template completely
5. Ensure all CI checks pass
6. Request a review from a maintainer

## Reporting Bugs

Please use the [bug report issue template](https://github.com/slingshot/bolter/issues/new?template=bug_report.md) and include:

- Steps to reproduce the issue
- Expected vs. actual behavior
- Browser and OS information
- Any relevant error messages or screenshots

## Requesting Features

Use the [feature request issue template](https://github.com/slingshot/bolter/issues/new?template=feature_request.md) and describe:

- The problem your feature would solve
- Your proposed solution
- Any alternatives you've considered

## Security Vulnerabilities

Please do **not** open a public issue for security vulnerabilities. See [SECURITY.md](SECURITY.md) for responsible disclosure instructions.

## License

By contributing to Bolter, you agree that your contributions will be licensed under the [Mozilla Public License 2.0](LICENSE).
