# Build stage
FROM oven/bun:1 AS builder

WORKDIR /app

# Copy workspace files for dependency resolution
COPY package.json bun.lock ./
COPY frontend/package.json ./frontend/
COPY backend/package.json ./backend/
COPY shared/package.json ./shared/
COPY shared/config.ts ./shared/

# Install dependencies
RUN bun install --frozen-lockfile

# Copy frontend source
COPY frontend/ ./frontend/

# Build the frontend
WORKDIR /app/frontend
ARG VITE_APP_TITLE
ARG VITE_APP_DESCRIPTION
RUN bun run build

# Production stage
FROM nginx:alpine

# Copy custom nginx config
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf

# Copy built assets and set proper permissions
COPY --from=builder /app/frontend/dist /usr/share/nginx/html

# Fix permissions for nginx user
RUN chown -R nginx:nginx /usr/share/nginx/html && \
    chmod -R 755 /usr/share/nginx/html && \
    find /usr/share/nginx/html -type f -exec chmod 644 {} \;

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
