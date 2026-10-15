# OpsPulse — Real-Time DevOps Monitoring Platform

Monitors your websites and APIs with **real HTTP requests**, records every
response in MongoDB, and shows uptime, latency, outages and incidents computed
from that stored evidence.

> **Nothing on this dashboard is faked.** Every uptime figure, response time and
> incident comes from a `CheckResult` document that a real request produced. When
> a check is *missing*, OpsPulse reports it as missing — it never quietly counts
> missing data as success.

**Stack:** React (Vite) · Node.js · Express · MongoDB/Mongoose · Socket.IO · Docker

---

## Table of contents

1. [Features](#features)
2. [Quick start with Docker](#quick-start-with-docker)
3. [Running locally without Docker](#running-locally-without-docker)
4. [Environment variables](#environment-variables)
5. [How uptime and downtime are calculated](#how-uptime-and-downtime-are-calculated)
6. [SSRF protection](#ssrf-protection)
7. [The scheduler and how to scale it](#the-scheduler-and-how-to-scale-it)
8. [Architecture](#architecture)
9. [API reference](#api-reference)
10. [Testing](#testing)
11. [Deployment](#deployment)
12. [Troubleshooting](#troubleshooting)

---

## Features

| Area | What it does |
|---|---|
| **Monitoring** | HTTP/HTTPS checks with configurable method, interval, timeout, expected status codes and expected response text |
| **Status machine** | `pending → up / degraded / down`, plus `paused`. Flap protection via a recovery threshold |
| **Incidents** | Opened automatically after repeated failures, updated (never duplicated), acknowledged, resolved, with a full timeline |
| **Notifications** | Persisted in-app alerts with unread counts, cooldowns and deduplication |
| **Email (optional)** | SMTP via environment variables. Reports `skipped` honestly when not configured — never fakes a send |
| **Real time** | Socket.IO pushes monitor status, checks and incidents to authorised users only |
| **Analytics** | Response-time charts, uptime over time, daily/weekly/lifetime reports, p50/p95/p99 latency |
| **Teams** | Workspaces with `owner` / `admin` / `viewer` roles and strict isolation between workspaces |
| **Security** | SSRF guard, bcrypt hashing, JWT, rate limiting, helmet, ownership checks on every route |
| **Ops** | Health/readiness endpoints, structured logs, graceful shutdown, Docker, GitHub Actions |

---

## Quick start with Docker

### Requirements

- Docker Desktop 4.25+ (or Docker Engine 24+ with the Compose plugin)

### Run it

```powershell
# 1. Create the environment file (contains the secret — never commit it)
Copy-Item .env.example .env

# 2. Generate a strong JWT_SECRET and paste it into .env
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"

# 3. Start everything
docker compose up -d --build

# 4. Watch it come up
docker compose ps
```

| Service | URL | Notes |
|---|---|---|
| Web UI | <http://localhost:8080> | nginx serves the SPA **and** proxies the API |
| API | <http://localhost:5000/api/health> | |
| Readiness | <http://localhost:5000/api/ready> | 503 until MongoDB is connected |
| MongoDB | `localhost:27017` | remove the port mapping to keep it private |

Create your account on the landing page — registration makes a personal
workspace automatically.

### Stop / clean up

```powershell
docker compose down          # stop (data is kept)
docker compose down -v       # stop and DELETE the database volume
```

> ⚠️ `down -v` permanently deletes all monitors, checks, incidents and
> notifications.

---

## Running locally without Docker

### Requirements

- Node.js 18+ (developed on 22)
- MongoDB 6+ (developed on 8.2)

```powershell
# ── MongoDB ───────────────────────────────────────────────────────
# Start the installed Windows service
Start-Service MongoDB
# …or run a throwaway instance
Start-Process "C:\Program Files\MongoDB\Server\8.2\bin\mongod.exe" `
  -ArgumentList "--dbpath","$env:TEMP\mongo-data","--port","27017","--bind_ip","127.0.0.1"

# ── Backend ──────────────────────────────────────────────────────
cd C:\Users\user\Downloads\ammu.mern\server
Copy-Item .env.example .env
npm install
npm run dev            # http://localhost:5000

# ── Frontend (second terminal) ────────────────────────────────────
cd C:\Users\user\Downloads\ammu.mern\client
Copy-Item .env.example .env
npm install
npm run dev            # http://localhost:5173
```

The Vite dev server proxies `/api` and `/socket.io` to `localhost:5000`, so the
browser stays on one origin and behaves exactly like production.

### Useful scripts

| Location | Command | What it does |
|---|---|---|
| `server` | `npm run dev` | Start with nodemon |
| `server` | `npm start` | Start normally |
| `server` | `npm test` | Run the backend test suite |
| `server` | `npm run test:coverage` | Tests with coverage |
| `server` | `npm run lint` | ESLint |
| `client` | `npm run dev` | Vite dev server |
| `client` | `npm run build` | Production bundle into `dist/` |
| `client` | `npm test` | Frontend tests (Vitest, watch mode) |
| `client` | `npm run test:run` | Frontend tests once |
| `client` | `npm run lint` | ESLint |

---

## Environment variables

### Root `.env` (Docker Compose only)

`JWT_SECRET` is the only required value. Everything else has a sensible default.
See [`.env.example`](.env.example).

### Backend `server/.env`

| Variable | Default | Description |
|---|---|---|
| `PORT` | `5000` | API port |
| `NODE_ENV` | `development` | `production` enables JSON logs and strict JWT rules |
| `LOG_LEVEL` | `debug` | `error` / `warn` / `info` / `debug` |
| `MONGO_URI` | `mongodb://localhost:27017/opspulse` | Connection string |
| `JWT_SECRET` | — | **Required in production.** ≥32 random chars; the server refuses to boot otherwise |
| `JWT_EXPIRES_IN` | `7d` | Token lifetime |
| `CORS_ORIGIN` | `http://localhost:5173` | Comma-separated list of allowed origins |
| `MONITOR_MIN_INTERVAL_SECONDS` | `30` | Fastest allowed check interval |
| `MONITOR_MAX_INTERVAL_SECONDS` | `86400` | Slowest allowed interval |
| `MONITOR_DEFAULT_INTERVAL_SECONDS` | `300` | Interval for new monitors |
| `MONITOR_MIN_TIMEOUT_MS` | `1000` | Shortest allowed timeout |
| `MONITOR_MAX_TIMEOUT_MS` | `30000` | Longest allowed timeout |
| `MONITOR_DEFAULT_TIMEOUT_MS` | `10000` | Timeout for new monitors |
| `MONITOR_DEGRADED_MS` | `3000` | Slower than this ⇒ `degraded` |
| `MONITOR_MAX_REDIRECTS` | `3` | Redirect hops before giving up |
| `MONITOR_USER_AGENT` | `OpsPulse-Monitor/1.0` | `User-Agent` sent to targets |
| `ALLOW_PRIVATE_TARGETS` | `false` | ⚠️ See [SSRF protection](#ssrf-protection) |
| `RATE_LIMIT_WINDOW_MS` | `900000` | Rate-limit window (15 min) |
| `RATE_LIMIT_AUTH_MAX` | `20` | Auth attempts per window per IP |
| `RATE_LIMIT_API_MAX` | `300` | API calls per window per IP |
| `CHECK_RETENTION_DAYS` | `0` | Auto-delete checks older than N days (0 = keep forever) |
| `SCHEDULER_ENABLED` | `true` | Run monitoring jobs in this process |
| `SCHEDULER_TICK_SECONDS` | `30` | How often to look for due monitors |
| `SCHEDULER_MAX_CONCURRENCY` | `10` | Parallel checks per tick |
| `SMTP_HOST` / `SMTP_PORT` | — | Leave blank to disable email |
| `SMTP_USER` / `SMTP_PASS` | — | SMTP credentials |
| `SMTP_SECURE` | `false` | `true` for port 465 (implicit TLS) |
| `SMTP_FROM` | `OpsPulse <noreply@opspulse.dev>` | Sender address |

### Frontend `client/.env`

| Variable | Default | Description |
|---|---|---|
| `VITE_API_BASE_URL` | *(empty)* | Leave empty to use same-origin (nginx proxy / Vite dev proxy) |

---

## How uptime and downtime are calculated

This is the part most monitoring tools fudge, so OpsPulse is explicit about it.

### Uptime

```
uptime% = (up_checks + degraded_checks × 0.5) / total_recorded_checks × 100
```

- Every persisted `CheckResult` is **one data point**.
- A `degraded` check counts as **half** a success (0.5 credit).
- If **no** checks were recorded, the answer is `null` — not 0% and not 100%.

### Missing checks are never success

If a monitor should have been checked 120 times in a window but only 100 checks
exist, OpsPulse reports:

- `uptimePercentage` — computed from the 100 **real** checks
- `unknownChecks` — `120 − 100 = 20`
- `coveragePercentage` — `100 / 120 = 83.3%`

The dashboard and report pages show a visible warning whenever
`unknownChecks > 0`. A gap in the chart is a gap, not a straight line.

### Downtime

Downtime is measured, not guessed. When a monitor transitions to `down` the
server records `downSince`. When it recovers:

```
totalDowntimeMs += recoveredAt − downSince
```

### Recovery threshold

A monitor that was `down` does **not** jump back to `up` after a single success
when `recoveryThreshold > 1`. It stays `down`, flagged `isRecovering`, until it
has that many consecutive successes. This stops a target that blinks for one
second from looking healthy.

---

## SSRF protection

Monitors are a request primitive: a logged-in user can make the OpsPulse server
fetch any address. Without protection that is a server-side request forgery
tool. OpsPulse applies seven layers (`server/src/services/ssrfGuard.js`):

1. **Scheme allow-list** — only `http:` and `https:`
2. **No credentials in the URL** — blocks `http://user:pass@host` tricks
3. **Hostname block-list** — `localhost`, `*.internal`, `*.local`, `metadata.google.internal`
4. **Port block-list** — 22, 3306, 6379, 27017, 6443 … (internal services)
5. **IP range checks** — `0.0.0.0/8`, `10/8`, `100.64/10`, `127/8`, `169.254/16`
   (cloud metadata), `172.16/12`, `192.168/16`, `fc00::/7`, `fe80::/10`, and the
   rest of the reserved IPv4/IPv6 space
6. **DNS-rebinding pinning** — the socket connects to the **exact validated IP**,
   never to a re-resolved hostname; if *any* DNS answer is private, the whole
   hostname is rejected
7. **Redirect re-validation** — every redirect hop goes through steps 1–6 again

### Monitoring internal services

`ALLOW_PRIVATE_TARGETS=true` disables the private-range checks so you can watch
services inside your own network. **Keep it `false` unless that is genuinely
what you want** — with it enabled, any user with a viewer account can use a
monitor to read internal endpoints.

---

## The scheduler and how to scale it

The monitoring scheduler runs **inside** a backend process. By default OpsPulse
guarantees that **exactly one instance ever schedules checks**, using a
MongoDB-backed lease (`server/src/monitoring/lease.js`):

- The first instance to start acquires the lease and logs
  `Monitoring scheduler started`.
- Every other instance logs
  `Backend started as a PASSIVE instance (no monitoring jobs)` and serves API
  traffic only.
- The holder renews the lease every 15 s. If it dies, the lease expires and a
  passive instance **promotes itself automatically**.

You can watch this at `/api/ready`:

```json
{ "scheduler": { "isLeader": true, "stats": { "ticks": 42, "checksRun": 97 } } }
```

### Overlap protection

Independently of the lease, every running monitor ID is held in an `inFlight`
map for exactly as long as its check runs. If a target takes longer than the
interval, the next tick skips it (`checksSkippedOverlap`) instead of firing a
second request.

### Running more than one backend replica

```powershell
docker compose up -d --scale backend=3
```

This is safe **because of the lease** — one replica monitors, all three serve
API traffic. To be explicit instead of automatic:

```yaml
services:
  backend:
    environment:
      SCHEDULER_ENABLED: "false"   # on the web replicas
  scheduler:
    build: ./server
    command: ["node", "worker.js"] # a dedicated monitoring worker
    environment:
      SCHEDULER_ENABLED: "true"
```

### Moving to a distributed job queue

The in-process scheduler is the right choice up to a few thousand monitors. When
you outgrow it, the migration path is:

| Approach | What changes |
|---|---|
| **BullMQ + Redis** | Replace `runDueChecks()` with enqueued jobs. Add retry + backoff and per-monitor rate limiting for free. The `inFlight` overlap guard becomes the BullMQ `jobId` (setting it to the monitor id makes duplicate jobs a no-op). |
| **MongoDB as the queue** | Change streams on `CheckResult` to trigger follow-up work. Keeps one datastore, but throughput is lower than Redis. |
| **Kubernetes CronJob** | One pod per tick. Needs an external lock anyway — the existing lease can be reused as-is. |

In all three cases `server/src/services/monitorService.js#executeCheck` stays
exactly the same, because it is already an idempotent "check once and persist"
function.

---

## Architecture

```
ammu.mern/
├── docker-compose.yml          frontend + backend + mongo
├── .env.example                Compose environment template
├── .github/workflows/ci.yml    lint → test → build → docker smoke test
│
├── server/                     Express API + scheduler
│   ├── Dockerfile              multi-stage, non-root, healthcheck
│   ├── server.js               boot, graceful shutdown, signal handling
│   ├── jest.config.js
│   └── src/
│       ├── config/             env parsing + validation, DB, structured logger
│       ├── models/             User, Team, TeamMember, Monitor, CheckResult,
│       │                       Incident, Notification, SchedulerLease
│       ├── routes/             auth, teams, monitors, checks, analytics,
│       │                       incidents, notifications, settings
│       ├── controllers/        thin HTTP layer
│       ├── services/           ssrfGuard, healthCheck, monitorService,
│       │                       incidentService, alertService, emailService,
│       │                       analyticsService, reportService
│       ├── monitoring/         scheduler.js (cron) + lease.js (MongoDB lock)
│       ├── socket/             Socket.IO server, JWT handshake, room model
│       ├── middleware/         auth, roleCheck, loadMonitor, validate,
│       │                       rateLimit, errorHandler
│       ├── validators/         express-validator rule sets
│       ├── utils/              ApiError, asyncHandler, pagination, uptime
│       └── tests/              14 suites, 282 tests
│
└── client/                     React + Vite SPA
    ├── Dockerfile              build → nginx
    ├── nginx.conf              SPA + /api + /socket.io proxy
    └── src/
        ├── api/                Axios instance + typed endpoint modules
        ├── components/         layout, ui primitives, charts
        ├── context/            Auth, Theme, Realtime
        ├── hooks/              useAsync, useDebouncedValue, useNow
        ├── pages/              12 pages
        ├── socket/             Socket.IO client
        └── test/               Vitest setup
```

### Socket.IO authorisation model

1. The handshake must carry a valid JWT. An anonymous socket is rejected.
2. Each socket joins `user:<id>` and one `team:<id>` room per membership.
3. Rooms are derived from the **database**, never from client input, so a
   client cannot request a room it does not belong to.

---

## API reference

All routes are prefixed with `/api`. Protected routes need
`Authorization: Bearer <token>` (an httpOnly cookie also works).

### Auth
| Method | Path | Description |
|---|---|---|
| `POST` | `/auth/register` | Create account + personal workspace |
| `POST` | `/auth/login` | Sign in |
| `POST` | `/auth/logout` | Clear the session |
| `GET` | `/auth/me` | Profile + workspaces |
| `PUT` | `/auth/profile` | Update name/email |
| `PUT` | `/auth/change-password` | Change password |

### Monitors
| Method | Path | Description |
|---|---|---|
| `GET` | `/monitors` | List (`status`, `search`, `teamId`, `page`, `limit`) |
| `POST` | `/monitors` | Create (owner/admin) |
| `GET` | `/monitors/:id` | One monitor |
| `PUT` | `/monitors/:id` | Update (owner/admin) |
| `DELETE` | `/monitors/:id` | Delete + its checks (owner/admin) |
| `PATCH` | `/monitors/:id/pause` | Pause scheduling |
| `PATCH` | `/monitors/:id/resume` | Resume |
| `POST` | `/monitors/:id/check` | Run a check now |
| `GET` | `/monitors/:id/checks` | Check history |

### Checks & analytics
| Method | Path | Description |
|---|---|---|
| `GET` | `/checks/recent` | Activity feed |
| `GET` | `/analytics/dashboard/summary` | Headline numbers (`range`, `teamId`) |
| `GET` | `/analytics/monitors` | Per-monitor table |
| `GET` | `/analytics/monitors/:id` | Deep analytics for one monitor |
| `GET` | `/analytics/reports/daily` | Daily summary (`days`, `monitor`) |
| `GET` | `/analytics/reports/weekly` | Weekly summary (`weeks`, `monitor`) |
| `GET` | `/analytics/reports/lifetime/:monitorId` | All-time summary |

### Incidents
| Method | Path | Description |
|---|---|---|
| `GET` | `/incidents` | List (`status`, `severity`, `search`, …) |
| `GET` | `/incidents/summary` | Counts by status |
| `GET` | `/incidents/:id` | Detail + timeline |
| `POST` | `/incidents/:id/acknowledge` | Acknowledge |
| `POST` | `/incidents/:id/resolve` | Resolve (`notes`) |
| `POST` | `/incidents/:id/note` | Append a timeline note |

### Notifications & settings
| Method | Path | Description |
|---|---|---|
| `GET` | `/notifications` | List (`unread`, `type`, paging) |
| `GET` | `/notifications/unread-count` | Badge count |
| `POST` | `/notifications/:id/read` | Mark read |
| `POST` | `/notifications/read-all` | Mark all read |
| `DELETE` | `/notifications/:id` | Delete |
| `GET` | `/settings` | Profile, preferences, SMTP capability |
| `PUT` | `/settings/preferences` | Update alert preferences |
| `POST` | `/settings/test-email` | Send a real test email, report the truth |
| `DELETE` | `/settings/notifications` | Clear notification history |

### Teams
| Method | Path | Description |
|---|---|---|
| `GET` | `/teams` | My workspaces |
| `POST` | `/teams` | Create |
| `GET` | `/teams/:id` | Detail + members |
| `GET` | `/teams/:id/stats` | Live counts |
| `PUT` | `/teams/:id` | Rename (owner/admin) |
| `DELETE` | `/teams/:id` | Delete (owner) |
| `POST` | `/teams/:id/members` | Add by email (owner/admin) |
| `PUT` | `/teams/:id/members/:userId` | Change role (owner/admin) |
| `DELETE` | `/teams/:id/members/:userId` | Remove (owner/admin) |
| `POST` | `/teams/:id/transfer-ownership` | Hand over ownership (owner) |
| `POST` | `/teams/:id/leave` | Leave a workspace |

### Operations
| Method | Path | Description |
|---|---|---|
| `GET` | `/api/health` | Liveness — answers as soon as the process is up |
| `GET` | `/api/ready` | Readiness — 503 until MongoDB is connected; includes scheduler state |

---

## Testing

```powershell
# Backend — 14 suites, 282 tests, uses a separate opspulse_test database
cd server
npm test
npm run test:coverage

# Frontend — 4 suites, 46 tests (Vitest + Testing Library)
cd client
npm run test:run
```

The backend suite covers SSRF blocking, real health checks (against a genuine
local HTTP server), the scheduler and its lease, status transitions, incident
lifecycle, notification deduplication, workspace authorisation, Socket.IO room
isolation, analytics maths and error handling.

### GitHub Actions

`.github/workflows/ci.yml` runs on every push and pull request:

1. **backend** — `npm ci` → lint → test against a real `mongo:8` service container
2. **frontend** — `npm ci` → lint → test → build
3. **docker** — builds both images and smoke-tests that the backend container
   becomes healthy

---

## Deployment

### Docker Compose (single host)

```powershell
Copy-Item .env.example .env
# set JWT_SECRET
docker compose up -d --build
```

Put a TLS terminator in front (Traefik, Caddy, nginx, or a cloud load balancer)
and forward to port 8080. Keep `CORS_ORIGIN` matching your public origin.

### Kubernetes

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: opspulse-backend
spec:
  replicas: 2
  template:
    spec:
      containers:
        - name: backend
          image: ghcr.io/your-org/opspulse-backend:latest
          env:
            - name: SCHEDULER_ENABLED   # pick ONE replica to monitor
              value: "true"
            - name: JWT_SECRET
              valueFrom:
                secretKeyRef: { name: opspulse, key: jwt-secret }
          readinessProbe:
            httpGet: { path: /api/ready, port: 5000 }
            initialDelaySeconds: 15
          livenessProbe:
            httpGet: { path: /api/health, port: 5000 }
            initialDelaySeconds: 10
          resources:
            requests: { cpu: 100m, memory: 256Mi }
```

Use a `PersistentVolumeClaim` or an external MongoDB for the database, and set
`MONGO_URI` accordingly. With the lease in place, leaving `SCHEDULER_ENABLED`
true on every replica is still safe — only one becomes leader — but being
explicit is clearer.

### Checklist before going live

- [ ] `JWT_SECRET` is at least 32 random characters (`openssl rand -hex 48`)
- [ ] `NODE_ENV=production`
- [ ] `ALLOW_PRIVATE_TARGETS=false`
- [ ] `CORS_ORIGIN` lists only your real origins
- [ ] TLS terminated in front of the stack
- [ ] `CHECK_RETENTION_DAYS` set if check history grows too large
- [ ] MongoDB backups configured
- [ ] `/api/ready` wired to your load balancer's health check

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `FATAL: JWT_SECRET …` on boot | Placeholder secret in production | Generate a real one |
| Backend exits immediately, log shows `ECONNREFUSED …:27017` | MongoDB not reachable | Start MongoDB, check `MONGO_URI` |
| `503` from `/api/ready` | Database not connected | Same as above |
| Live badge shows **Offline** | WebSocket blocked by a proxy | Ensure the proxy forwards `/socket.io` with `Upgrade`/`Connection` headers (see `client/nginx.conf`) |
| `429 Too many attempts` on login | Rate limit (20 / 15 min) | Wait, or raise `RATE_LIMIT_AUTH_MAX` |
| Monitor stays `pending` | Scheduler disabled | Set `SCHEDULER_ENABLED=true` |
| `This URL cannot be monitored` | SSRF guard | Expected — see [SSRF protection](#ssrf-protection) |
| No email arrives | SMTP not configured or disabled by the user | Check **Settings → Test email**; the API reports the exact reason |
| Charts show gaps | Genuinely missing checks | Expected — see [uptime calculation](#how-uptime-and-downtime-are-calculated) |

---

## License

MIT — use it, fork it, self-host it.