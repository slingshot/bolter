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
RUN bun install --frozen-lockfile

# Copy frontend source
COPY apps/frontend/ ./apps/frontend/

# Build the frontend
WORKDIR /app/apps/frontend
ARG VITE_APP_TITLE
ARG VITE_APP_DESCRIPTION
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
