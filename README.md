# SSE Gateway

Node.js sidecar that terminates Server-Sent Event (SSE) connections on behalf of a backend application. It is **not** an HTTP reverse proxy — it owns the SSE stream lifecycle and delegates authorization, identity, and event origination to the backend via callbacks and AMQP.

## How it works

1. A browser opens an SSE connection to the gateway (any path).
2. The gateway calls the backend's callback URL with `action: connect`, forwarding the raw URL and headers.
3. The backend authenticates the request, resolves identity, and returns `request_id`, `subject`, `role`, and a list of AMQP `bindings` (routing keys).
4. The gateway creates a per-connection AMQP queue, binds it to the `sse.events` topic exchange using the returned routing keys, and starts consuming.
5. Messages arriving on the queue are formatted as SSE events and written to the client's stream.
6. On disconnect (client or server), the gateway calls the backend with `action: disconnect` and cleans up the queue.

When AMQP is not configured, the gateway operates in HTTP-only mode — events are delivered via `POST /internal/send` instead.

## Event formatting

Domain events from AMQP are wrapped in an **unnamed envelope** so the browser receives them via a single `EventSource.onmessage` handler:

```
data: {"type":"<event_name>","payload":<data>}\n\n
```

The `ready` event is the exception — it is a **named SSE event with no data line**, keeping it out of the domain message flow:

```
event: ready\n\n
```

The `ready` event is sent after AMQP queue bindings are confirmed (or immediately in HTTP-only mode). Clients must wait for it before treating the connection as established. It is re-sent after AMQP reconnection and rebinding.

## Endpoints

### `GET /<any-path>` — SSE stream

Accepts any path. The raw URL and headers are forwarded to the callback. Returns `text/event-stream`.

If the callback returns non-2xx, the gateway returns the same status code to the client (no SSE stream opened).

### `POST /internal/send` — send event / close connection

```json
{
  "token": "string",
  "event": { "name": "string", "data": "string" },
  "close": true
}
```

- `token` — required. The connection UUID.
- `event` — optional. If present, `data` is required; `name` is optional.
- `close` — optional. If `true`, the connection is closed after the event is sent.
- If both `event` and `close` are present, the event is sent first, then the connection is closed.
- Unknown token returns 404.

### `GET /healthz` — liveness

Always returns 200.

### `GET /readyz` — readiness

Returns 200 when the callback URL is configured and initialization is complete. Otherwise 503.

## Callback protocol

The gateway POSTs to the configured `CALLBACK_URL`:

**Connect:**

```json
{
  "action": "connect",
  "token": "<uuid>",
  "request": { "url": "<raw-url>", "headers": { ... } }
}
```

The backend responds with:

```json
{
  "request_id": "abc123",
  "subject": "keycloak-sub-uuid",
  "role": "editor",
  "bindings": ["broadcast", "connection.abc123", "subject.keycloak-sub-uuid", "role.editor"]
}
```

**Disconnect:**

```json
{
  "action": "disconnect",
  "token": "<uuid>",
  "reason": "client_closed | server_closed | error",
  "request": { "url": "<raw-url>", "headers": { ... } }
}
```

Callbacks are best-effort — no retries, errors are logged only.

## AMQP transport

- **Exchange:** `sse.events` (topic, durable). Prefixed with `RABBITMQ_ENV_PREFIX` if set (e.g. `myapp.sse.events`).
- **Queues:** One per connection, non-durable, auto-delete disabled, TTL controlled by `RABBITMQ_QUEUE_TTL_MS`.
- **Routing keys:** Set by the backend via the `bindings` array in the connect callback response. Common patterns:
  - `connection.<request_id>` — single connection
  - `subject.<oidc_subject>` — all connections for a user
  - `role.<role>` — all connections with a role
  - `broadcast` — all connections
- **Message format** (JSON):
  ```json
  { "event_name": "<event_type>", "data": "{...}" }
  ```
  The gateway wraps these in the unnamed envelope format described above.
- **Reconnect:** Exponential backoff capped at 30 seconds. After reconnect, queues are re-asserted, bindings re-established, and consumers re-created. A `ready` event is re-sent to each connection.

## Heartbeats

SSE comment heartbeats (`: heartbeat\n`) are sent at a configurable interval to keep connections alive through proxies and load balancers. Not visible to the backend.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server listen port |
| `CALLBACK_URL` | — | Backend callback endpoint (required for readiness) |
| `HEARTBEAT_INTERVAL_SECONDS` | `15` | Heartbeat interval per connection |
| `RABBITMQ_URL` | — | AMQP URL; omit to disable RabbitMQ transport |
| `RABBITMQ_QUEUE_TTL_MS` | `300000` | TTL for per-connection queues (ms) |
| `RABBITMQ_ENV_PREFIX` | — | Prefix for exchange name (environment isolation) |

## Technology

- Node.js 20 / TypeScript 5 / Express 5 / ESM
- amqplib for AMQP
- Single-threaded event loop — event ordering per connection is guaranteed
- No authentication, no persistence, single-instance sidecar

## Development

```bash
npm install
npm run build
npm test
npm run lint
```

The gateway is also published as an npm package for use in Playwright test harnesses. See `docs/usage.md`.
