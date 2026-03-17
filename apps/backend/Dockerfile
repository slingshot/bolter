# Build stage
FROM oven/bun:1 AS builder

WORKDIR /app

# Copy workspace files for dependency resolution
COPY package.json bun.lock ./
COPY apps/frontend/package.json ./apps/frontend/
COPY apps/backend/package.json ./apps/backend/
COPY packages/shared/package.json ./packages/shared/
COPY packages/shared/config.ts ./packages/shared/

# Install dependencies
RUN bun install --frozen-lockfile --production

# Copy backend source
COPY apps/backend/ ./apps/backend/

# Production stage
FROM oven/bun:1-slim

WORKDIR /app

# Copy installed dependencies and source from builder
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/apps/backend ./apps/backend
COPY --from=builder /app/packages/shared ./packages/shared
COPY --from=builder /app/package.json ./

# Set working directory to backend
WORKDIR /app/apps/backend

# Expose port
EXPOSE 3001

# Health check - uses liveness probe for quick checks
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD bun -e "fetch('http://localhost:3001/api/health/live').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

# Run the server
CMD ["bun", "run", "src/index.ts"]
