# Build stage
FROM oven/bun:1 AS builder

WORKDIR /app

# Copy workspace files for dependency resolution
COPY package.json bun.lock ./
COPY apps/frontend/package.json ./apps/frontend/
COPY apps/backend/package.json ./apps/backend/
COPY packages/shared/package.json ./packages/shared/
COPY packages/shared/config.ts ./packages/shared/
# @bolter/protocol is a workspace both apps depend on, so a pruned checkout has
# to keep it — bun refuses to install otherwise. Its source is copied whole
# because its postinstall builds it.
COPY packages/protocol/package.json ./packages/protocol/
COPY packages/protocol/src ./packages/protocol/src
COPY packages/protocol/tsconfig.json ./packages/protocol/
COPY apps/cli/package.json ./apps/cli/

# Install dependencies
RUN bun install --frozen-lockfile

# Build the workspace packages: Vite resolves them through their `import`
# condition, which points at dist rather than source.
RUN cd packages/shared && bun run build
RUN cd packages/protocol && bun run build

# Copy frontend source
COPY apps/frontend/ ./apps/frontend/

# Build the frontend
WORKDIR /app/apps/frontend
ARG VITE_APP_TITLE
ARG VITE_APP_DESCRIPTION
# Required: the build emits instance.json, which tells non-browser clients
# where this deployment's API lives. Without it they are handed localhost.
ARG VITE_API_URL
RUN bun run build

# Production stage
FROM nginx:alpine

# Copy custom nginx config
COPY apps/frontend/nginx.conf /etc/nginx/conf.d/default.conf

# Copy built assets and set proper permissions
COPY --from=builder /app/apps/frontend/dist /usr/share/nginx/html

# Fix permissions for nginx user
RUN chown -R nginx:nginx /usr/share/nginx/html && \
    chmod -R 755 /usr/share/nginx/html && \
    find /usr/share/nginx/html -type f -exec chmod 644 {} \;

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
