# SSEGateway Project Guide

## Project Overview

SSEGateway is a **Node.js sidecar service** that terminates Server-Sent Event (SSE) connections and coordinates with a Python backend. It is NOT an HTTP reverse proxy - it owns the SSE connection lifecycle.

**Core Function:** Accept SSE connections from clients, notify Python backend of connects/disconnects, and forward events from Python to clients.

## Architecture Principles

### Technology Constraints (NON-NEGOTIABLE)
- **Node.js 20 LTS** (required for native fetch and stable ESM)
- **TypeScript 5.x with ESM** (`"type": "module"` in package.json)
- **Express 5** framework
- **Single process, single-threaded** - no clustering
- **In-memory state only** - no persistence

### Key Design Decisions
1. **Event Loop Ordering**: All events for a token are automatically serialized by Node's event loop - no additional ordering logic needed
2. **Immediate Flushing**: Every SSE write must flush immediately
3. **No Compression**: SSE output must never be compressed
4. **Best-Effort Callbacks**: No retries on callback failures, log only

## Critical Implementation Rules

### SSE Endpoint (`GET /sse/*`)
- Accept **ANY** path under `/sse/` - do NOT parse or validate
- Store the **full raw URL** including query string
- Forward headers **verbatim** to callback
- Generate token using `crypto.randomUUID()`
- If connect callback returns non-2xx, immediately close stream and return same status to client

### Send/Close Endpoint (`POST /internal/send`)
```typescript
{
  "token": "string",      // required
  "event": {              // optional
    "name": "string",
    "data": "string"
  },
  "close": true           // optional
}
```
- If both event and close: send event FIRST, then close
- Unknown token → 404
- Invalid types → 400

### SSE Event Formatting (STRICT)
Follow full SSE spec:
- If event name present: `event: <name>\n`
- Split data on newlines, send one `data:` line per data line
- End with blank line
- Flush immediately after every write

### Heartbeats
- Format: `: heartbeat\n` (SSE comment)
- Default interval: 15 seconds (configurable via `HEARTBEAT_INTERVAL_SECONDS`)
- Sent per connection, not visible to Python
- Must flush immediately

### Connection Lifecycle
```typescript
interface ConnectionRecord {
  res: express.Response;
  request: {
    url: string;
    headers: Record<string, string | string[] | undefined>;
  };
  heartbeatTimer: NodeJS.Timeout;
}
```

Store in: `Map<token, ConnectionRecord>`

### Disconnect Reasons
- `"client_closed"` - client disconnected
- `"server_closed"` - Python sent close=true
- `"error"` - write failure or other error

### Callback Contract
**POST to `CALLBACK_URL`:**
```json
{
  "action": "connect" | "disconnect",
  "reason": "client_closed" | "server_closed" | "error",  // only for disconnect
  "token": "string",
  "request": {
    "url": "string",
    "headers": { ... }
  }
}
```

## What This Service Does NOT Do

- **No authentication/authorization** - Python and NGINX handle this
- **No header/cookie parsing** - pass through raw
- **No URL validation** - forward raw URL including query string
- **No persistence** - all state lost on restart
- **No horizontal scaling** - single instance only
- **No event buffering/reordering**
- **No WebSocket support** - SSE only

## Configuration

### Environment Variables
| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `CALLBACK_URL` | Yes | none | Python callback endpoint |
| `HEARTBEAT_INTERVAL_SECONDS` | No | 15 | Heartbeat interval |

### Health Endpoints
- `GET /healthz` - Always 200 unless fatal error
- `GET /readyz` - 200 when `CALLBACK_URL` configured and server ready, else 503

## Common Pitfalls to Avoid

1. **Don't parse the SSE URL path** - forward it raw to Python
2. **Don't validate headers** - forward them unchanged
3. **Don't buffer events** - flush immediately after every write
4. **Don't retry failed callbacks** - log and move on
5. **Don't persist state** - all state is ephemeral
6. **Don't add clustering** - single instance is required for correctness
7. **Don't compress SSE output** - must remain uncompressed
8. **Don't forget to clear heartbeat timer** on disconnect

## Testing Guidance

When implementing or modifying this service:
- Test that URLs and headers are forwarded raw without parsing
- Verify SSE format compliance (event name, multi-line data, blank line ending)
- Test connect callback rejection (non-2xx should close stream immediately)
- Verify event ordering within a single connection
- Test heartbeat timer creation and cleanup
- Test all three disconnect reasons
- Verify immediate flushing (no buffering)
- Test unknown token handling (404)

## File Structure Expectations

Typical structure should include:
- `src/server.ts` - Express app and route handlers
- `src/connections.ts` - Connection state management
- `src/sse.ts` - SSE formatting utilities
- `src/callback.ts` - Python callback logic
- `src/config.ts` - Environment variable loading
- `tsconfig.json` - Must have `"module": "NodeNext"` and `"moduleResolution": "NodeNext"`
- `package.json` - Must have `"type": "module"`

## Logging Format

Plain text with severity prefix:
```
[INFO] New SSE connection: token=abc-123 url=/sse/channel/updates
[ERROR] Callback failed: token=abc-123 error=ECONNREFUSED
```

Log these events:
- Server startup (port, environment config)
- New connections (token, URL)
- Callback results (success/failure)
- Event sends (token, event name)
- Connection closes (token, reason)
- All errors

## Reference

Complete specification: `/work/docs/product_brief.md`
