# Multi-stage production build for Node.js Express + Vite
FROM node:20-alpine AS builder

WORKDIR /app

# Install build dependencies
COPY package*.json ./
RUN npm ci --legacy-peer-deps || npm install --legacy-peer-deps

# Copy source files
COPY . .

# Build both static client (/dist) and production server (/dist/server.cjs)
RUN npm run build

# Production runner image
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production

# Copy built artifacts and production dependencies
COPY package*.json ./
RUN npm ci --only=production --legacy-peer-deps || npm install --only=production --legacy-peer-deps

COPY --from=builder /app/dist ./dist

# Non-root user for container security
USER node

# Cloud Run injects PORT (defaults to 8080)
ENV PORT=8080
EXPOSE 8080

CMD ["node", "dist/server.cjs"]
