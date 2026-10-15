# ─── OpsPulse frontend ─────────────────────────────────────────────
# Stage 1 builds the React app, stage 2 serves it with nginx and proxies
# the API + Socket.IO through to the backend so everything is same-origin.

# ── Stage 1: build ────────────────────────────────────────────────
FROM node:22-alpine AS build

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

# VITE_API_BASE_URL is intentionally left empty: the browser talks to the
# same origin and nginx forwards /api and /socket.io to the backend.
# This means no CORS configuration and no hard-coded hostnames.
ARG VITE_API_BASE_URL=""
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL

RUN npm run build

# ── Stage 2: serve ────────────────────────────────────────────────
FROM nginx:1.27-alpine AS runtime

# Replace the stock config with ours
RUN rm /etc/nginx/conf.d/default.conf
COPY nginx.conf /etc/nginx/conf.d/opspulse.conf

COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1/ >/dev/null 2>&1 || exit 1

CMD ["nginx", "-g", "daemon off;"]