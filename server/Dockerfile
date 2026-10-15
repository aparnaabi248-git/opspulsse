# ─── OpsPulse API ──────────────────────────────────────────────────
# Multi-stage build: dependencies are installed once and copied into a
# slim runtime image that carries no build tooling.

# ── Stage 1: dependencies ──────────────────────────────────────────
FROM node:22-alpine AS deps

WORKDIR /app

# Copy only the manifests first so Docker can cache the install layer
COPY package*.json ./

# Production dependencies only. `npm ci` fails loudly if package-lock.json
# is out of sync with package.json, which is exactly what we want in CI.
RUN npm ci --omit=dev --ignore-scripts

# ── Stage 2: runtime ───────────────────────────────────────────────
FROM node:22-alpine AS runtime

# tini gives us a real init so SIGTERM reaches Node and the graceful
# shutdown in server.js actually runs inside the container.
RUN apk add --no-cache tini

ENV NODE_ENV=production \
    PORT=5000

WORKDIR /app

# Run as an unprivileged user (never root inside a container)
RUN addgroup -S opspulse && adduser -S opspulse -G opspulse

COPY --from=deps --chown=opspulse:opspulse /app/node_modules ./node_modules
COPY --chown=opspulse:opspulse package.json ./
COPY --chown=opspulse:opspulse server.js ./
COPY --chown=opspulse:opspulse src ./src
COPY --chown=opspulse:opspulse jest.config.js ./

USER opspulse

EXPOSE 5000

# Liveness only: this answers as soon as the process is up.
# Readiness (/api/ready) additionally requires MongoDB.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "require('http').get({host:'127.0.0.1',port:process.env.PORT||5000,path:'/api/health'},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]