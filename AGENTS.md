# SSEGateway - Project Context

## Project Overview

SSEGateway is a standalone Node.js service that manages Server-Sent Events (SSE) connections between frontend clients and a Python backend application. It acts as a **connection terminator** (not a proxy), handling the long-lived SSE connections while the Python backend remains stateless.

## Architecture

```
[Browser/Client] <--SSE--> [SSEGateway (Node)] <--HTTP--> [Python Backend]
```

**Key Design Principles:**
- Gateway terminates SSE connections (does not proxy them)
- Runs as an internal sidecar behind a reverse proxy
- No authentication/authorization (delegated to Python via callback)
- No persistent state across restarts
- Single-instance operation only

## Core Responsibilities

The gateway must:
- Accept SSE connections at `/sse/*` (any path)
- Generate a unique token (UUID) for each connection
- Notify Python backend on connect/disconnect via callback
- Accept event delivery commands from Python at `/internal/send`
- Send heartbeat comments every 15 seconds (configurable)
- Flush all events immediately (no buffering)
- Preserve strict event ordering per connection

The gateway must NOT:
- Parse cookies, headers, or authenticate requests
- Parse or validate URLs beyond path separation
- Maintain state across restarts
- Buffer or batch events
- Handle client reconnection logic

## Key Interfaces

### 1. SSE Client → Gateway
**Endpoint:** `GET /sse/<any-path>`

**Flow:**
1. Client connects
2. Gateway generates token, captures request metadata (URL, headers, remote address)
3. Gateway calls Python callback with `action: "connect"`
4. If callback returns non-2xx → close connection immediately
5. If callback returns 2xx → maintain connection, send heartbeats
6. On disconnect → gateway calls callback with `action: "disconnect"` and reason

### 2. Python → Gateway
**Endpoint:** `POST /internal/send`

**Payload:**
```json
{
  "token": "string",           // required
  "event": {                   // optional
    "name": "string",
    "data": "string"           // may contain newlines
  },
  "close": true                // optional
}
```

**Behavior:**
- If both `event` and `close`: send event first, then close
- If only `close`: close immediately
- Multiline `data` must be split into multiple `data:` lines per SSE spec

### 3. Gateway → Python Callback
**Endpoint:** `POST {CALLBACK_URL}` (from env var)

**Payload:**
```json
{
  "action": "connect" | "disconnect",
  "reason": "client_closed" | "server_closed" | "error",  // only for disconnect
  "token": "string",
  "request": {
    "url": "string",           // full URL with query string
    "headers": { ... }         // forwarded verbatim
  }
}
```

## SSE Protocol Implementation

**Required format:**
- `event: <name>` (when name provided)
- `data: <line>` (repeat for each line in multiline data)
- Blank line to terminate event
- UTF-8 encoding, no escaping

**Heartbeats:**
- Format: `: heartbeat\n`
- Interval: `HEARTBEAT_INTERVAL_SECONDS` (default 15s)
- Must flush immediately

## Connection Lifecycle

**Connect:**
1. Generate UUID token
2. Store token → connection mapping
3. POST callback with `action: "connect"`
4. If non-2xx response → abort SSE connection with same status
5. If 2xx → proceed, start heartbeats

**Event Send:**
1. Validate token exists (return 404 if not)
2. Send SSE event if provided
3. Close connection if `close: true`
4. Preserve strict ordering for back-to-back sends

**Disconnect:**
1. Identify reason: `client_closed`, `server_closed`, or `error`
2. POST callback with `action: "disconnect"` and reason
3. Delete token from internal store

## Environment Variables

| Variable | Default | Required | Description |
|----------|---------|----------|-------------|
| `CALLBACK_URL` | none | YES | Python callback endpoint for connect/disconnect notifications |
| `HEARTBEAT_INTERVAL_SECONDS` | `15` | NO | Heartbeat interval in seconds |

## Routes

| Route | Method | Purpose |
|-------|--------|---------|
| `/sse/*` | GET | Accept SSE connections (any subpath allowed) |
| `/internal/send` | POST | Receive event/close commands from Python |
| `/healthz` | GET | Liveness check |
| `/readyz` | GET | Readiness check |

## Important Constraints

**Performance:**
- Must handle thousands of concurrent connections
- Single-instance only (no horizontal scaling)
- Use Node's event loop for non-blocking I/O

**Data Handling:**
- All headers forwarded verbatim (no inspection or modification)
- No encoding/escaping of event data
- Immediate flushing after every event
- Preserve exact request URL including query string

**Error Handling:**
- Log all connect/disconnect events
- Log internal send errors (token not found, invalid payload)
- Log callback failures
- Use plain console logging only

**Restart Behavior:**
- All connections lost on restart
- No state recovery
- No special disconnect callbacks for restart scenario

## Development Guidelines

When working on this codebase:
1. Ensure all SSE events flush immediately (critical for real-time delivery)
2. Preserve strict ordering of events per connection
3. Never parse or validate forwarded headers or URLs
4. Always forward full request metadata to Python callback
5. Handle disconnect reasons accurately (client vs server vs error)
6. Test with thousands of concurrent connections
7. Verify heartbeats work correctly and flush immediately
