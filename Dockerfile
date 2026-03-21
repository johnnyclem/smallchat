# syntax=docker/dockerfile:1
# ============================================================
# smallchat — Optimized multi-stage Dockerfile
# ============================================================
#
# Build: docker build -t smallchat .
# Run:   docker run -p 3001:3001 -e SC_SOURCE_PATH=/app/examples smallchat

# ============================================================
# Stage 1: Builder
# ============================================================
FROM node:22-alpine AS builder

WORKDIR /build

# Install dependencies first (layer caching)
COPY package.json package-lock.json* ./
RUN npm ci --ignore-scripts

# Copy source and build
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# ============================================================
# Stage 2: Production runtime
# ============================================================
FROM node:22-alpine AS runtime

# Security: run as non-root
RUN addgroup -S smallchat && adduser -S smallchat -G smallchat

WORKDIR /app

# Install only production dependencies
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --ignore-scripts && \
    npm cache clean --force

# Copy compiled output
COPY --from=builder /build/dist ./dist

# Copy ONNX models
COPY models/ ./models/

# Copy examples (can be volume-mounted at runtime)
COPY examples/ ./examples/

# Data directory for SQLite and flight recorder
RUN mkdir -p /data && chown smallchat:smallchat /data

USER smallchat

# Environment configuration
ENV NODE_ENV=production \
    SC_PORT=3001 \
    SC_HOST=0.0.0.0 \
    SC_LOG_LEVEL=info \
    SC_DB_PATH=/data/smallchat.db \
    SC_FR_FILE=/data/smallchat-flight.ndjson

EXPOSE 3001

# Health check using /ready endpoint
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
    CMD wget -qO- http://localhost:3001/ready || exit 1

ENTRYPOINT ["node", "dist/cli/index.js"]
CMD ["serve", \
     "--source", "/app/examples", \
     "--port", "3001", \
     "--host", "0.0.0.0", \
     "--db-path", "/data/smallchat.db", \
     "--metrics", \
     "--audit"]
