FROM node:22-alpine AS builder

WORKDIR /app

COPY bot/package.json bot/package-lock.json ./bot/
RUN cd bot && npm ci

COPY bot/ ./bot/
RUN cd bot && npm run build

# Production stage
FROM node:22-alpine AS production

WORKDIR /app

# Install production dependencies only
COPY bot/package.json bot/package-lock.json ./bot/
RUN cd bot && npm ci --omit=dev

COPY --from=builder /app/bot/dist ./bot/dist

# Create non-root user
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

WORKDIR /app/bot
CMD ["node", "dist/main.js"]
