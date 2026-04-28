# codekiwi-app-backend

> The core server behind [CodeKiwi](https://codekiwi.tech) — handles session creation, real-time WebSocket sync, PDF-to-slides conversion, and sandboxed code execution.

## What it does

- **WebSocket server** — broadcasts slide changes, editor lock state, and session-end events scoped per session
- **PDF upload** — converts teacher-uploaded PDFs to per-slide PNG images via `pdf-to-img`
- **Session management** — create, join, end sessions; persist state to disk with hourly cleanup
- **Code execution** — runs student code in Docker containers (Python, JavaScript, Java) with memory/CPU limits and a 10s timeout
- **Editor lock** — REST endpoints + WS broadcast for toggling the student editor lock
- **AppScript auth** — `/api/sessions/upload` validates `x-codekiwi-secret` header against `APPSCRIPT_SECRET` env var

## Stack

| Layer | Tech |
|---|---|
| Server | Node.js + Express |
| Real-time | `ws` (WebSocket) |
| PDF conversion | `pdf-to-img` |
| Code sandbox | Docker (python:3.10, node:20, openjdk:17) |
| TLS | Let's Encrypt (auto-loaded in production) |

## Setup

```bash
git clone https://github.com/JayantDeveloper/codekiwi-app-backend
cd codekiwi-app-backend
npm install
```

Create a `.env` file:

```env
NODE_ENV=DEV
PORT=4000
APPSCRIPT_SECRET=your_secret_here
```

```bash
node server.js
```

For local HTTPS tunneling during development:

```bash
lt --port 4000 --subdomain your-subdomain
```

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `NODE_ENV` | Yes | `DEV` uses HTTP on port 4000; anything else uses HTTPS on port 443 with Let's Encrypt certs |
| `PORT` | No | Overrides default port in DEV mode |
| `APPSCRIPT_SECRET` | Yes (prod) | Shared secret validated on `/api/sessions/upload` — must match the `API_SECRET` Script Property in the Google Slides add-on |

## API endpoints

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/sessions/upload` | Create session from PDF (AppScript) |
| `GET` | `/api/sessions/:code/exists` | Check if session exists and is active |
| `POST` | `/api/sessions/:code/join` | Student joins session, returns `studentId` |
| `POST` | `/api/sessions/:code/end` | Teacher ends session |
| `GET` | `/api/sessions/:code/students` | List all students + their code/output |
| `GET` | `/api/sessions/:code/students/:id` | Single student code + output |
| `POST` | `/api/sessions/:code/code` | Student submits code snapshot |
| `GET` | `/api/sessions/:code/notes` | Slide notes for the session |
| `GET` | `/api/sessions/:code/coding-slides` | Indices of slides with coding questions |
| `GET` | `/api/sessions/:code/lock` | Get current editor lock state |
| `POST` | `/api/sessions/:code/lock` | Set editor lock state + broadcast via WS |
| `POST` | `/api/run` | Execute code in Docker sandbox |
| `GET` | `/health` | Health check |

## WebSocket events

Clients connect to the root WebSocket URL and send a `join` message first:

```json
{ "type": "join", "sessionCode": "1234567890" }
```

| Event (client → server) | Description |
|---|---|
| `join` | Subscribe to a session's broadcast channel |
| `change` | Teacher moved to a new slide |
| `lock-editors` | Teacher toggled editor lock |
| `session-ended` | Teacher ended the session |

| Event (server → client) | Description |
|---|---|
| `sync` | New current slide index |
| `lock-editors` | Editor lock state changed |
| `session-ended` | Session has ended |

## Related repositories

- [codekiwi-app-frontend](https://github.com/JayantDeveloper/codekiwi-app-frontend) — React classroom interface
- [codekiwi-site](https://github.com/JayantDeveloper/codekiwi-site) — Commercial site and teacher portal

Live API → [api.codekiwi.app](https://api.codekiwi.app/health)
