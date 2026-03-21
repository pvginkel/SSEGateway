# Plan: RabbitMQ Transport for SSE Gateway

## 0) Research Log & Findings

**Documents read:**
- `docs/features/rabbitmq_transport/change_brief.md` — primary requirements
- `/work/DesignAssistant/docs/slices/017_sse_rabbitmq_transport/gateway_brief.md` — detailed specification
- `CLAUDE.md` — architecture constraints, callback window buffering, ConnectionRecord shape
- `src/config.ts` — existing Config interface and loadConfig function
- `src/connections.ts` — ConnectionRecord interface, Map operations
- `src/callback.ts` — CallbackResult interface, sendConnectCallback, sendCallback internals
- `src/routes/sse.ts` — full SSE connection lifecycle, callback window and buffer flush logic
- `src/routes/internal.ts` — handleEventAndClose, handleServerClose, /internal/send handler
- `src/routes/health.ts` — /readyz endpoint
- `src/server.ts` — createApp, router registration order
- `src/index.ts` — start(), setupGracefulShutdown (SIGTERM/SIGINT handlers)
- `src/sse.ts` — formatSseEvent: envelope wrapping, passthrough set
- `package.json` — dependencies section, ESM type:module, test runner (jest + ts-jest)
- `__tests__/integration/sse.test.ts` — test pattern: MockServer, connections.clear(), createApp(config)

**Key findings:**

1. **Callback window is already implemented.** `src/routes/sse.ts:182-203` sets `ready = true`, flushes `eventBuffer`, then starts the heartbeat timer. AMQP consumption must be wired in after line 203 (after `eventBuffer = []`).

2. **CallbackResult does not parse response body.** `src/callback.ts:144-148` returns `{ success: true, statusCode }` without reading the response body JSON. This must be extended.

3. **ConnectionRecord has no AMQP fields.** `src/connections.ts:13-31` — two optional fields (`amqpQueueName`, `amqpConsumerTag`) must be added.

4. **handleDisconnect in sse.ts** (lines 254-313) clears the heartbeat timer but does no AMQP consumer cancellation. AMQP cleanup must be added at the same point.

5. **handleEventAndClose in routes/internal.ts** (lines 161-225) also clears the heartbeat timer on write failure — AMQP cleanup must be mirrored there.

6. **handleServerClose in routes/internal.ts** (lines 236-267) removes from Map and ends the response — AMQP cleanup needed there too.

7. **Graceful shutdown in index.ts** (lines 56-75) only closes the HTTP server. AMQP shutdown (cancel consumers, close channel, close connection) must happen before `server.close()`.

8. **Config pattern:** `loadConfig()` returns a plain `Config` object. New fields (`rabbitmqUrl: string | null`, `rabbitmqQueueTtlMs: number`) follow the same nullable/default pattern used by `callbackUrl` and `heartbeatIntervalSeconds`.

9. **Router registration order in server.ts** lines 39-46: health, then SSE, then internal. No change needed here; `createSseRouter` and `createInternalRouter` accept `Config`. After this change, both will also accept the RabbitMQ client instance (or it can be accessed as a module-level singleton).

10. **Singleton vs. injection:** The gateway spec mandates single-process, in-memory only. A module-level singleton for the RabbitMQ client (exported from `src/rabbitmq.ts`) is the appropriate pattern — it matches how `connections` is a module-level Map in `src/connections.ts`.

11. **Message format (RESOLVED):** The gateway brief (`gateway_brief.md:155`) shows `"data": { ... }` — a JSON object — but the change brief (`change_brief.md:34`), the user Q&A, and the project orchestrator's clarifications all confirm `data` is a **pre-serialized JSON string**, same structure as HTTP `/internal/send`. The AMQP message body is `{ "event": "event_name", "data": "<json-string>" }`. No `JSON.stringify` is needed — pass `data` verbatim to `formatSseEvent`. The gateway brief's object notation was illustrative, not a wire-format specification. This is now the authoritative interpretation.

12. **No `close` via RabbitMQ.** Close is exclusively HTTP-only (`/internal/send` with `close: true`). AMQP messages contain only `event` + `data`.

13. **amqplib types:** `@types/amqplib` is a separate package. Both `amqplib` and `@types/amqplib` go into `dependencies` (not `devDependencies`) because `prepare` runs `tsc` at install time for git-based consumers.

---

## 1) Intent & Scope

**User intent**

Add RabbitMQ as an additive, optional second event-delivery transport. When `RABBITMQ_URL` is set, the gateway creates a named durable queue per SSE connection after the callback window closes, binds it to routing keys returned by the connect callback, and forwards AMQP messages to the SSE stream. The existing HTTP `/internal/send` path is completely unchanged.

**Prompt quotes**

- "additive change - the existing HTTP `/internal/send` endpoint must continue to work unchanged"
- "Start AMQP consumption AFTER the callback window closes (after ready: true and buffer flush)"
- "Single AMQP connection, single shared channel, prefetch 10"
- "On AMQP connection loss: leave SSE connections open, reconnect with backoff"
- "Close is HTTP-only, no close via RabbitMQ"

**In scope**

- New `src/rabbitmq.ts` module: AMQP connection management, reconnect with backoff, exchange declaration, queue assert/bind/consume/cancel primitives
- `src/config.ts`: add `rabbitmqUrl` and `rabbitmqQueueTtlMs` fields
- `src/callback.ts`: parse `request_id` and `bindings` from 2xx connect callback response body
- `src/connections.ts`: add optional `amqpQueueName` and `amqpConsumerTag` fields to `ConnectionRecord`
- `src/routes/sse.ts`: after buffer flush, start AMQP consumption when bindings are present; add AMQP cleanup in `handleDisconnect`
- `src/routes/internal.ts`: add AMQP consumer cancellation in `handleEventAndClose` error path and `handleServerClose`
- `src/routes/health.ts`: log warning when RabbitMQ configured but not connected; readiness response unchanged (soft dependency)
- `src/index.ts`: extend graceful shutdown to cancel AMQP consumers and close channel/connection before HTTP server close
- `package.json`: add `amqplib` and `@types/amqplib` to `dependencies`
- Unit tests: callback parsing, queue name derivation, AMQP-to-SSE message forwarding, consumer cancel on disconnect
- Integration tests: full publish-to-SSE flow, reconnect/queue-reuse, multiple routing keys, HTTP-only fallback, mixed mode

**Out of scope**

- Dynamic binding updates after connection
- Message persistence / durability (delivery_mode=1, transient)
- Dead letter queues
- Multiple exchanges
- Close signal via RabbitMQ
- Horizontal scaling or clustering
- Authentication / authorization (network-level only)

**Assumptions / constraints**

- Node.js 20 LTS, TypeScript 5, ESM (`"type": "module"`), Express 5 — no changes to these constraints.
- Single-process, single-threaded; no additional locking primitives needed beyond the event loop.
- RabbitMQ available at `localhost:5672` with `guest/guest` during tests.
- `amqplib` is the chosen AMQP client; its Promise API (`amqplib/callback_api` is not used).
- A module-level singleton for the RabbitMQ client matches the pattern already used for `connections` in `src/connections.ts`.
- The `data` field in AMQP messages is a pre-serialized JSON string — passed directly to `formatSseEvent`, same as `/internal/send`.

---

## 2) Affected Areas & File Map

- Area: `src/config.ts` — `Config` interface + `loadConfig`
- Why: Two new optional env vars (`RABBITMQ_URL`, `RABBITMQ_QUEUE_TTL_MS`) must be loaded, validated, and returned.
- Evidence: `src/config.ts:10-14` — `Config` interface lists all config fields; `src/config.ts:24-60` — loadConfig pattern for nullable string and integer with default.

- Area: `src/rabbitmq.ts` (new file)
- Why: Encapsulates all amqplib interaction: single connection, single channel, exchange declare, queue assert/bind/consume/cancel, reconnect with backoff. Must attach both `connection.on('error')` and `channel.on('error')` handlers to catch connection-level and channel-level faults respectively — channel errors do not propagate to the connection error handler in amqplib.
- Evidence: `CLAUDE.md` — "File Structure Expectations" does not list this file; it must be created. Gateway brief section 2 specifies the module's responsibilities.

- Area: `src/callback.ts` — `CallbackResult` interface + `sendCallback` internal helper
- Why: `sendCallback` currently ignores the 2xx response body. It must parse JSON and extract `request_id` (as `requestId`) and `bindings`.
- Evidence: `src/callback.ts:52-61` — `CallbackResult` interface has no `requestId` or `bindings` fields; `src/callback.ts:144-148` — success branch returns `{ success: true, statusCode }` without reading body.

- Area: `src/connections.ts` — `ConnectionRecord` interface
- Why: Two optional fields needed for per-connection AMQP tracking so cleanup code can cancel the correct consumer.
- Evidence: `src/connections.ts:13-31` — interface currently ends at `eventBuffer`; gateway brief lists `amqpQueueName?: string` and `amqpConsumerTag?: string`.

- Area: `src/routes/sse.ts` — `createSseRouter` + `handleDisconnect`
- Why: After buffer flush, if bindings are present and RabbitMQ is connected, assert queue, bind, and start consuming. On disconnect, cancel consumer before heartbeat cleanup.
- Evidence: `src/routes/sse.ts:182-234` — buffer flush and heartbeat start; `src/routes/sse.ts:254-313` — handleDisconnect with heartbeat cleanup but no AMQP step.

- Area: `src/routes/internal.ts` — `handleEventAndClose` + `handleServerClose`
- Why: Both functions clear heartbeat and remove the connection; AMQP consumer must be cancelled at the same points to avoid orphaned consumers.
- Evidence: `src/routes/internal.ts:197-218` — write-failure cleanup path; `src/routes/internal.ts:236-267` — server-close cleanup path.

- Area: `src/routes/health.ts` — `createHealthRouter`, `/readyz` handler
- Why: When `RABBITMQ_URL` is configured but RabbitMQ is not connected, log a warning. The 200/503 response logic is unchanged.
- Evidence: `src/routes/health.ts:39-55` — readyz currently checks only `callbackUrl`; a log warning call is the only addition.

- Area: `src/server.ts` — `createApp`
- Why: `createSseRouter` and `createInternalRouter` currently accept only `config`. After the change, they also need access to the RabbitMQ singleton. The singleton is module-level, so no signature change is strictly required — callers import it directly. No change to `createApp` signature is needed.
- Evidence: `src/server.ts:11-46` — router creation and registration.

- Area: `src/index.ts` — `setupGracefulShutdown`
- Why: AMQP shutdown (cancel all consumers, close channel, close connection) must precede HTTP server close. `shutdownRabbitMQ()` is async, so the `shutdown` inner function must become `async () => Promise<void>`. `await shutdownRabbitMQ()` is inserted before `server.close()`. Node.js 20 process-signal handlers support async callbacks natively.
- Evidence: `src/index.ts:56-75` — shutdown currently calls only `server.close()`; AMQP teardown must be inserted before that call.

- Area: `package.json`
- Why: `amqplib` and `@types/amqplib` are runtime/compile-time dependencies for git-based install consumers.
- Evidence: `package.json:33-38` — `dependencies` block; `package.json:14` — `"prepare": "tsc"` runs at install time, requiring type declarations at install.

- Area: `__tests__/unit/rabbitmq.test.ts` (new file)
- Why: Unit tests for queue name computation, callback body parsing, message forwarding, consumer cancel, no-config graceful degradation.
- Evidence: `__tests__/unit/sse.test.ts` — unit test pattern (import specific functions, no MockServer needed).

- Area: `__tests__/integration/rabbitmq.test.ts` (new file)
- Why: Integration tests against the real RabbitMQ instance for end-to-end publish→SSE delivery, reconnect/drain, routing key filtering, mixed-mode.
- Evidence: `__tests__/integration/sse.test.ts:8-13` — integration test pattern using `createApp(config)`, `MockServer`, `connections`.

---

## 3) Data Model / Contracts

- Entity / contract: `Config` (extended)
- Shape:
  ```
  {
    port: number,
    callbackUrl: string | null,
    heartbeatIntervalSeconds: number,
    rabbitmqUrl: string | null,        // NEW — null disables RabbitMQ
    rabbitmqQueueTtlMs: number         // NEW — default 300000
  }
  ```
- Refactor strategy: Both new fields are additive with defaults; existing call sites that spread or destructure `Config` are unaffected.
- Evidence: `src/config.ts:10-14`

- Entity / contract: `CallbackResult` (extended)
- Shape:
  ```
  {
    success: boolean,
    statusCode?: number,
    errorType?: 'timeout' | 'network' | 'http_error',
    error?: string,
    requestId?: string,    // NEW — from response body, only on success
    bindings?: string[]    // NEW — from response body, only on success
  }
  ```
- Refactor strategy: Optional fields; all existing callers that only check `success` and `statusCode` continue to work unmodified.
- Evidence: `src/callback.ts:52-61`

- Entity / contract: `ConnectionRecord` (extended)
- Shape:
  ```
  {
    res: Response,
    request: { url: string, headers: Record<string, string | string[]> },
    heartbeatTimer: NodeJS.Timeout | null,
    disconnected: boolean,
    ready: boolean,
    eventBuffer: Array<{ name?: string; data: string; close?: boolean }>,
    amqpQueueName?: string,     // NEW
    amqpConsumerTag?: string    // NEW
  }
  ```
- Refactor strategy: Optional fields; existing constructors that build `ConnectionRecord` literals (in `src/routes/sse.ts:89-96`) need no new required fields.
- Evidence: `src/connections.ts:13-31`

- Entity / contract: AMQP message body (inbound from RabbitMQ)
- Shape:
  ```json
  { "event": "event_name", "data": "<pre-serialized JSON string>" }
  ```
- Refactor strategy: Parsed once inside the consumer callback in `src/rabbitmq.ts`. `data` is passed verbatim to `formatSseEvent` — same contract as `/internal/send`.
- Evidence: Change brief line 34; gateway brief "Shared conventions" section — `"data": "..."` (pre-serialized).

- Entity / contract: Connect callback response body (inbound from Python backend)
- Shape:
  ```json
  { "request_id": "string", "bindings": ["routing.key.1", "routing.key.2"] }
  ```
- Refactor strategy: Parsed in `sendCallback` success branch; `bindings` absent or empty means HTTP-only mode for that connection. Missing fields are tolerated (optional).
- Evidence: Gateway brief section 4; change brief requirement 3.

- Entity / contract: AMQP queue declaration arguments
- Shape: `{ durable: false, exclusive: false, autoDelete: false, arguments: { 'x-expires': rabbitmqQueueTtlMs } }`
- Refactor strategy: No back-compat concern; queue name `sse.conn.<request_id>` is deterministic and idempotent via `assertQueue`.
- Evidence: Gateway brief section 3, bullet 2.

---

## 4) API / Integration Surface

- Surface: `GET /*` (SSE connection endpoint) — behavior extended
- Inputs: Any HTTP GET request (URL, headers forwarded raw)
- Outputs: SSE stream; additionally, if bindings returned by callback, AMQP queue created and consumption started after buffer flush
- Errors: Unchanged error paths (callback fail → close, client disconnect → cancel consumer if started)
- Evidence: `src/routes/sse.ts:56-242`

- Surface: `POST /internal/send` — unchanged
- Inputs: `{ token, event?, close? }`
- Outputs: `{ status: 'ok' | 'buffered' }` or 4xx
- Errors: No change
- Evidence: `src/routes/internal.ts:70-143`

- Surface: `GET /readyz` — soft warning added
- Inputs: none
- Outputs: `{ status: 'ready', configured: true }` (200) or `{ status: 'not_ready', configured: false }` (503); same as before
- Errors: When `rabbitmqUrl` is set but RabbitMQ client is not connected, a `[WARN]` log line is emitted; response code is not changed
- Evidence: `src/routes/health.ts:39-55`

- Surface: RabbitMQ `sse.events` topic exchange (consumed)
- Inputs: Messages with routing key matching one of the connection's bindings; body `{ "event": string, "data": string }`
- Outputs: SSE event written to the client stream; ack on success, nack-with-requeue on write failure
- Errors: Parse failure → log and nack-with-requeue; connection lost → consumers paused until reconnect; unknown token (race) → nack-with-requeue
- Evidence: Gateway brief sections 3-4

- Surface: AMQP queue `sse.conn.<request_id>` (asserted per connection)
- Inputs: Declared with `x-expires = rabbitmqQueueTtlMs`; bound on connect, consumer cancelled on disconnect
- Outputs: Queue persists after client disconnect (TTL-based cleanup); on reconnect the same queue is reused
- Errors: assertQueue failure → log, skip AMQP for this connection, fall back to HTTP-only
- Evidence: Gateway brief section 3; change brief requirement 4

---

## 5) Algorithms & State Machines

- Flow: AMQP connection and reconnect lifecycle
- Steps:
  1. On gateway startup, if `config.rabbitmqUrl` is non-null, call `connectRabbitMQ()`.
  2. Call `amqplib.connect(rabbitmqUrl)`. On success, create a single channel, set `prefetch(10)`, assert `sse.events` exchange (topic, durable), mark module state as `connected = true`, log `[INFO] RabbitMQ connected`.
  3. Attach `connection.on('error', ...)` and `connection.on('close', ...)`. On either event: set `connected = false`, log `[WARN] RabbitMQ connection lost, reconnecting...`, schedule reconnect with exponential backoff (initial 1 s, max 30 s, factor 2).
  3a. Attach `channel.on('error', handler)` immediately after channel creation. Channel-level errors (e.g., queue redeclared with mismatched arguments, consumer tag collision) close the channel without firing `connection.on('error')`. The channel error handler must: log `[ERROR] RabbitMQ channel error: <message>`, set `connected = false`, and trigger the same reconnect backoff as step 3. Without this handler, a channel fault silently drops all consumers while the gateway appears healthy.
  4. On reconnect: repeat step 2 (including re-attaching both `connection.on('error')` and `channel.on('error')` to the new objects). Re-establish per-connection consumers for all active connections that have `amqpConsumerTag` set (iterate the `connections` Map, call `channel.consume(record.amqpQueueName, ...)` and update `record.amqpConsumerTag`).
  5. `getChannel()` exported function returns the current channel or `null` if not connected.
- States / transitions:
  - `disconnected` → `connecting` (on startup or reconnect timer fires)
  - `connecting` → `connected` (amqplib connect + channel + exchange assert succeed)
  - `connecting` → `disconnected` (connect throws; schedule next backoff)
  - `connected` → `disconnected` (connection error or close event)
- Hotspots: Reconnect loop must cap at 30 s to avoid indefinitely blocking consumers. The `connections` Map iteration on reconnect is O(n active connections) — acceptable for the controlled environment.
- Evidence: `src/index.ts:16-49` (startup pattern); `CLAUDE.md` — "On AMQP connection loss: leave SSE connections open, reconnect with backoff"

- Flow: Per-connection AMQP queue setup (triggered after buffer flush)
- Steps:
  1. After `connectionRecord.eventBuffer = []` at `src/routes/sse.ts:203`, check: `callbackResult.bindings` is non-empty AND `getChannel()` returns non-null.
  2. Derive queue name: `sse.conn.${callbackResult.requestId}`.
  3. Call `channel.assertQueue(queueName, { durable: false, exclusive: false, autoDelete: false, arguments: { 'x-expires': config.rabbitmqQueueTtlMs } })`. On failure: log `[WARN]`, skip AMQP for this connection (connection continues HTTP-only).
  4. For each key in `callbackResult.bindings`: call `channel.bindQueue(queueName, 'sse.events', key)`.
  5. Call `channel.consume(queueName, messageHandler)` and store the returned consumer tag.
  5a. **Orphaned-consumer guard:** After `channel.consume` resolves, check `getConnection(token)`. If the connection is no longer in the Map (client disconnected while `assertQueue`/`bindQueue`/`consume` were in-flight), immediately call `channel.cancel(consumerTag)` (wrapped in try/catch) and return without setting any fields on the record. Without this check, the consumer persists in RabbitMQ, every delivered message nacks-with-requeue, and the cycle continues until queue TTL fires (up to 5 minutes, up to 10 messages in flight under prefetch).
  6. Set `connectionRecord.amqpQueueName = queueName` and `connectionRecord.amqpConsumerTag = consumerTag`. Update the reverse Map in `src/rabbitmq.ts` in the same synchronous block.
  7. Log `[INFO] AMQP consumer started: token=<token> queue=<queueName> consumerTag=<tag>`.
- States / transitions: n/a (linear flow)
- Hotspots: `assertQueue` + N `bindQueue` calls are async and happen after the SSE stream is already open; failures must not crash the gateway.
- Evidence: `src/routes/sse.ts:182-234`; gateway brief section 3

- Flow: AMQP message handler (per message received on queue)
- Steps:
  1. Receive `msg` from amqplib. If `msg` is null (consumer cancelled), return immediately.
  2. Parse `msg.content.toString()` as JSON. Extract `event` (string) and `data` (string). On parse failure: log `[ERROR]`, `channel.nack(msg, false, true)`, return.
  3. Look up the connection token associated with this consumer tag. If not found (race with disconnect): `channel.nack(msg, false, true)`, return.
  4. Call `formatSseEvent(event, data)` and write to `connectionRecord.res`.
  5. On write success: `channel.ack(msg)`. Log `[INFO] AMQP event sent: token=<token> event=<name>`.
  6. On write failure (exception): log `[ERROR]`, cancel consumer, remove from Map, send disconnect callback with reason `"error"`, `channel.nack(msg, false, true)`.
- States / transitions: n/a (per-message)
- Hotspots: The token lookup by consumer tag requires either a reverse Map (`consumerTag → token`) or iterating `connections`. A reverse Map in `src/rabbitmq.ts` keeps this O(1).
- Evidence: `src/routes/internal.ts:161-225` (handleEventAndClose pattern for write failures)

- Flow: AMQP consumer cancellation on disconnect
- Steps:
  1. In `handleDisconnect` (`src/routes/sse.ts:265-275`), after `clearInterval(record.heartbeatTimer)` and before `removeConnection(token)`:
  2. If `record.amqpConsumerTag` is set and `getChannel()` is non-null: call `channel.cancel(record.amqpConsumerTag)` (fire-and-forget, wrapped in try/catch with warn log on failure).
  3. Remove `consumerTag → token` entry from the reverse Map in `src/rabbitmq.ts`.
  4. Continue with existing disconnect callback.
- States / transitions: n/a
- Hotspots: `channel.cancel` is async; `await` it to prevent partial cleanup, but wrap in try/catch since the channel may be gone (AMQP connection lost at same time as client disconnect).
- Evidence: `src/routes/sse.ts:265-287`

- Flow: Graceful shutdown AMQP teardown
- Steps:
  1. In `setupGracefulShutdown` before `server.close()`: call `shutdownRabbitMQ()` exported from `src/rabbitmq.ts`.
  2. `shutdownRabbitMQ`: iterate all active connections that have `amqpConsumerTag` and call `channel.cancel(tag)` for each.
  3. Close the channel (`channel.close()`).
  4. Close the connection (`connection.close()`).
  5. Log `[INFO] RabbitMQ connection closed`.
  6. Resolve; proceed to `server.close()`.
- States / transitions: n/a
- Hotspots: Must complete within the 10 s forced-shutdown window already in `src/index.ts:61-65`. AMQP close is typically fast (<1 s).
- Evidence: `src/index.ts:56-75`; change brief requirement 8

---

## 6) Derived State & Invariants

- Derived value: `amqpConsumerTag` on `ConnectionRecord`
  - Source: Returned by `channel.consume(queueName, handler)` after buffer flush, stored into the in-memory `ConnectionRecord` in the `connections` Map.
  - Writes / cleanup: Cleared implicitly when `removeConnection(token)` removes the entire record. The reverse Map in `src/rabbitmq.ts` must also be updated at the same time.
  - Guards: Only set when `callbackResult.bindings` is non-empty AND `getChannel()` is non-null. Queue setup errors leave both fields undefined (HTTP-only fallback).
  - Invariant: If `amqpConsumerTag` is set on a record, an entry in the reverse Map must also exist for that tag. Both must be removed atomically (same synchronous block before any await).
  - Evidence: `src/connections.ts:13-31`; gateway brief section 5

- Derived value: `consumerTag → token` reverse Map in `src/rabbitmq.ts`
  - Source: Populated when `channel.consume` succeeds; key is consumer tag string, value is gateway token UUID.
  - Writes / cleanup: Entry removed when consumer is cancelled (disconnect, server close, write failure). Cleared entirely on AMQP reconnect (stale tags are invalid after channel recreation).
  - Guards: On reconnect, the Map is rebuilt only for connections where `record.amqpQueueName` is set and the connection is still in the `connections` Map.
  - Invariant: Every entry in the reverse Map has a corresponding `ConnectionRecord` in `connections` with `amqpConsumerTag` equal to that key.
  - Evidence: Algorithm step in section 5 (message handler); reconnect flow step 4

- Derived value: `connected` flag in `src/rabbitmq.ts`
  - Source: Set to `true` after exchange assertion on connect; set to `false` immediately on connection error/close event.
  - Writes / cleanup: Controls whether new connections attempt AMQP queue setup. When `false`, new SSE connections silently use HTTP-only mode.
  - Guards: Reading the flag and acting on it must happen in the same synchronous turn to avoid a TOCTOU race between flag check and `channel.consume`.
  - Invariant: When `connected = false`, `getChannel()` returns `null` and no new AMQP operations are attempted.
  - Evidence: `CLAUDE.md` — "Single process, single-threaded — no additional ordering logic needed"; section 6 readiness check requirement

- Derived value: Queue name `sse.conn.<request_id>`
  - Source: Derived from `callbackResult.requestId` returned in the connect callback response body.
  - Writes / cleanup: Queue persists in RabbitMQ after disconnect; TTL (`x-expires`) handles expiry. The gateway does not delete it.
  - Guards: `request_id` must be a non-empty string. If absent from callback body, skip AMQP entirely for that connection.
  - Invariant: Queue name is stable across reconnects for the same logical client session. `assertQueue` is idempotent — declaring an existing queue with identical parameters is a no-op.
  - Evidence: Change brief requirement 4; gateway brief section 3 "Use assertQueue which is idempotent"

---

## 7) Consistency, Transactions & Concurrency

- Transaction scope: Connection setup is not transactional. Each step (assertQueue, bindQueue ×N, consume) is an independent async AMQP operation. Partial failure (e.g., bindQueue fails after assertQueue) leaves an unbound queue in RabbitMQ; TTL cleans it up.
- Atomic requirements: Storing `amqpConsumerTag` in `ConnectionRecord` and inserting the reverse-Map entry must happen in the same synchronous microtask after `channel.consume` resolves, before any other await. This prevents a disconnect event from missing the consumer tag.
- Retry / idempotency: `assertQueue` is idempotent — safe to call on reconnect with the same name and arguments. `bindQueue` is also idempotent. No retry on individual failures; the reconnect loop handles full re-establishment.
- Ordering / concurrency controls: Node.js single-threaded event loop serializes all events per connection. No locks needed. The critical ordering constraint from `CLAUDE.md` — "AMQP consumption AFTER ready: true and buffer flush" — is enforced by placement in `src/routes/sse.ts` after line 203.
- Evidence: `CLAUDE.md` — "Event Loop Ordering: All events for a token are automatically serialized"; `src/routes/sse.ts:182-203`

---

## 8) Errors & Edge Cases

- Failure: `RABBITMQ_URL` is set but RabbitMQ is unreachable at startup
- Surface: Gateway startup; `/readyz` endpoint
- Handling: Log `[WARN] RabbitMQ not connected`. All SSE connections proceed in HTTP-only mode. `/readyz` still returns 200 (soft dependency). Reconnect loop runs in background.
- Guardrails: Backoff cap at 30 s prevents tight reconnect loops.
- Evidence: Change brief requirement 7; gateway brief section 6

- Failure: `assertQueue` or `bindQueue` fails for a specific connection
- Surface: `src/routes/sse.ts` post-buffer-flush AMQP setup block
- Handling: Log `[WARN] AMQP queue setup failed: token=<token> error=<msg>`. Connection stays open, HTTP-only for that connection.
- Guardrails: Wrapped in try/catch; failure does not propagate to the SSE route handler.
- Evidence: Algorithm section 5, step 3

- Failure: AMQP message body is not valid JSON or missing required fields
- Surface: Message handler in `src/rabbitmq.ts`
- Handling: Log `[ERROR] AMQP message parse error: queue=<queue> error=<msg>`. Nack with requeue=true. Message will be redelivered; if structurally malformed it will loop — the queue TTL acts as the circuit breaker.
- Guardrails: Consider logging a rate-limited warning if the same message is redelivered repeatedly (out of scope for this change; acceptable residual risk given controlled DA environment).
- Evidence: Gateway brief section 3, bullet 4; change brief requirement 4

- Failure: SSE write fails while processing AMQP message (client disconnected)
- Surface: Message handler; `handleEventAndClose` error path
- Handling: Cancel consumer, remove from Map, send disconnect callback with reason `"error"`, nack with requeue=true (so message is retained for potential reconnect).
- Guardrails: Consumer cancel is wrapped in try/catch; channel may already be gone.
- Evidence: `src/routes/internal.ts:197-218`; change brief requirement 4

- Failure: AMQP connection lost while active SSE connections are consuming
- Surface: `connection.on('error')` / `connection.on('close')` in `src/rabbitmq.ts`
- Handling: Set `connected = false`. Log `[WARN]`. All active `amqpConsumerTag` values become stale. SSE connections remain open (no events delivered until reconnect). Reconnect loop runs; on success, re-establish consumers for all connections with `amqpQueueName` set.
- Guardrails: Reconnect attempts are logged at `[INFO]` level per attempt; success at `[INFO]`; persistent failure at `[WARN]` per cycle.
- Evidence: `CLAUDE.md` — "On AMQP connection loss: leave SSE connections open, reconnect with backoff"

- Failure: Client disconnects while AMQP queue setup is in progress (between buffer flush and `channel.consume` returning)
- Surface: `src/routes/sse.ts`; `handleDisconnect`
- Handling: `handleDisconnect` fires. `record.amqpConsumerTag` is not yet set (still awaiting consume). The disconnect handler skips AMQP cancel. The just-created consumer (when consume resolves) will immediately find the connection gone; the message handler's token lookup will return null and nack-with-requeue.
- Guardrails: `getConnection(token)` check inside the message handler catches this. The consumer will be cancelled when the queue TTL fires (since no reconnect comes).
- Evidence: Race condition analysis; `src/routes/sse.ts:260-313`

- Failure: `RABBITMQ_URL` is not set
- Surface: All AMQP code paths
- Handling: `connectRabbitMQ()` is never called; `getChannel()` always returns null; all AMQP branches in `src/routes/sse.ts` are skipped; `/readyz` and `/healthz` unchanged.
- Guardrails: Config check at startup time.
- Evidence: Change brief requirement 1; gateway brief section 1

---

## 9) Observability / Telemetry

- Signal: `[INFO] RabbitMQ connected`
- Type: structured log
- Trigger: Successful AMQP connect + channel + exchange assertion in `src/rabbitmq.ts`
- Labels / fields: none (single-instance service)
- Consumer: operator log tail; startup health check
- Evidence: `src/logger.ts` (plain text with severity prefix per CLAUDE.md)

- Signal: `[WARN] RabbitMQ connection lost, reconnecting in <n>s`
- Type: structured log
- Trigger: `connection.on('error')` or `connection.on('close')` in `src/rabbitmq.ts`
- Labels / fields: backoff delay in seconds
- Consumer: alerting on repeated warnings
- Evidence: `CLAUDE.md` logging format section

- Signal: `[INFO] AMQP consumer started: token=<token> queue=<queue> consumerTag=<tag>`
- Type: structured log
- Trigger: Successful `channel.consume` return in post-buffer-flush setup
- Labels / fields: token, queue name, consumer tag
- Consumer: debugging per-connection AMQP state
- Evidence: `CLAUDE.md` — "Log these events: New connections (token, URL)"

- Signal: `[INFO] AMQP consumer cancelled: token=<token> reason=<reason>`
- Type: structured log
- Trigger: Successful `channel.cancel` during disconnect / server close / write failure
- Labels / fields: token, reason (client_closed, server_closed, error)
- Consumer: pairing with SSE connection close log for full lifecycle trace
- Evidence: `CLAUDE.md` — "Connection closes (token, reason)"

- Signal: `[INFO] AMQP event sent: token=<token> event=<name>`
- Type: structured log
- Trigger: Successful ack after SSE write in message handler
- Labels / fields: token, event name
- Consumer: debugging delivery; mirrors existing `[INFO] Sent SSE event:` log in `handleEventAndClose`
- Evidence: `src/routes/internal.ts:191-196`

- Signal: `[ERROR] AMQP message parse error: queue=<queue> error=<msg>`
- Type: structured log
- Trigger: JSON parse failure or missing fields in message handler
- Labels / fields: queue name, error message
- Consumer: alerting on malformed messages from DA backend
- Evidence: Section 8 error case

- Signal: `[WARN] RabbitMQ configured but not connected` (in /readyz handler)
- Type: structured log
- Trigger: `/readyz` is called and `getChannel()` returns null while `config.rabbitmqUrl` is set
- Labels / fields: none
- Consumer: operator awareness; does not block readiness
- Evidence: Change brief requirement 7

---

## 10) Background Work & Shutdown

- Worker / job: AMQP reconnect loop in `src/rabbitmq.ts`
- Trigger cadence: Event-driven — triggered by connection error/close events; uses `setTimeout` for backoff delay
- Responsibilities: Re-establish AMQP connection, channel, and exchange assertion; re-register consumers for all active connections
- Shutdown handling: The loop must be cancelled during graceful shutdown. A `shutdownRequested` boolean flag in `src/rabbitmq.ts` prevents reconnect attempts after `shutdownRabbitMQ()` is called. Any in-flight backoff timer is cleared via `clearTimeout`.
- Evidence: `src/index.ts:56-75` — 10 s forced shutdown window; section 5 reconnect algorithm

- Worker / job: Heartbeat timers (existing, per-connection `setInterval`)
- Trigger cadence: Every `heartbeatIntervalSeconds` × 1000 ms per live connection
- Responsibilities: Write `: heartbeat\n\n` to SSE stream to keep connection alive
- Shutdown handling: Already cleared in `handleDisconnect` and `handleServerClose`; no change needed
- Evidence: `src/routes/sse.ts:206-234`

- Worker / job: AMQP consumer callbacks (event-loop callbacks, not a separate thread)
- Trigger cadence: Event-driven — fires when amqplib delivers a message
- Responsibilities: Parse, forward to SSE stream, ack/nack
- Shutdown handling: Consumers are cancelled in `shutdownRabbitMQ()` before channel and connection are closed. Amqplib stops delivering new messages once the channel is closed.
- Evidence: Section 5 graceful shutdown algorithm; `src/index.ts:66-75`

---

## 11) Security & Permissions

- Concern: AMQP credentials in `RABBITMQ_URL`
- Touchpoints: `src/config.ts` (loading), `src/rabbitmq.ts` (connect call), `src/index.ts` (startup log)
- Mitigation: Log only `<configured>` / `<not configured>` for `rabbitmqUrl` at startup (same pattern as `callbackUrl` in `src/index.ts:21-24`). Never log the URL value.
- Residual risk: URL appears in environment — acceptable, standard for containerized services.
- Evidence: `src/index.ts:21-24` — `callbackUrlSummary` pattern

---

## 12) UX / UI Impact

Not applicable. This is a backend sidecar service with no user interface.

---

## 13) Deterministic Test Plan

- Surface: `CallbackResult` parsing in `src/callback.ts`
- Scenarios:
  - Given a 2xx callback response with `{ "request_id": "r1", "bindings": ["connection.r1"] }` in body, When `sendConnectCallback` resolves, Then `callbackResult.requestId === "r1"` and `callbackResult.bindings` equals `["connection.r1"]`.
  - Given a 2xx callback response with no JSON body (empty or non-JSON), When resolved, Then `requestId` and `bindings` are undefined, `success` is still true.
  - Given a non-2xx callback response, When resolved, Then `requestId` and `bindings` are undefined.
- Fixtures / hooks: Mock `fetch` using jest `jest.spyOn(globalThis, 'fetch')` returning a mock Response with body.
- Gaps: None.
- Evidence: `src/callback.ts:144-148`; `__tests__/unit/sse.test.ts` — unit pattern

- Surface: Queue name computation
- Scenarios:
  - Given `requestId = "abc-123"`, When queue name is derived, Then result is `"sse.conn.abc-123"`.
  - Given `requestId` contains only alphanumeric and hyphens (typical UUID format), When derived, Then no characters are modified.
- Fixtures / hooks: Pure function, no fixtures needed.
- Gaps: None.
- Evidence: Gateway brief "Queue naming: `sse.conn.<request_id>`"

- Surface: AMQP message forwarding (unit, with mocked channel and ConnectionRecord)
- Scenarios:
  - Given a valid message `{ "event": "task_event", "data": "{\"x\":1}" }`, When the message handler is called with a mock `res.write`, Then `formatSseEvent("task_event", '{"x":1}')` is written and `channel.ack(msg)` is called.
  - Given a message with invalid JSON body, When handler called, Then `channel.nack(msg, false, true)` is called and no write occurs.
  - Given a valid message but `res.write` throws, When handler called, Then `channel.nack(msg, false, true)` is called and disconnect callback is sent.
  - Given a message for a consumer tag not in the reverse Map, When handler called, Then `channel.nack(msg, false, true)` is called.
- Fixtures / hooks: Mock `connections` Map with a test record; mock `channel` object with jest mock functions; mock `sendDisconnectCallback`.
- Gaps: None.
- Evidence: `src/routes/internal.ts:161-218`; section 5 message handler algorithm

- Surface: Consumer cancellation on disconnect (unit)
- Scenarios:
  - Given a `ConnectionRecord` with `amqpConsumerTag = "tag-1"` and `getChannel()` returning a mock channel, When `handleDisconnect` is called, Then `channel.cancel("tag-1")` is called.
  - Given a `ConnectionRecord` with no `amqpConsumerTag`, When `handleDisconnect` is called, Then `channel.cancel` is not called.
  - Given `getChannel()` returns null (AMQP disconnected), When `handleDisconnect` is called, Then no error is thrown.
  - Given a `ConnectionRecord` with `amqpConsumerTag = "tag-2"` and `getChannel()` returning a mock channel, When `handleEventAndClose` write fails (throws), Then `channel.cancel("tag-2")` is called before the disconnect callback is sent.
  - Given a `ConnectionRecord` with `amqpConsumerTag = "tag-3"`, When `handleServerClose` is called, Then `channel.cancel("tag-3")` is called.
- Fixtures / hooks: Mock `getChannel` to return mock channel or null.
- Gaps: None.
- Evidence: `src/routes/sse.ts:265-313`; `src/routes/internal.ts:197-218, 236-267`

- Surface: Channel-level error triggers reconnect (unit)
- Scenarios:
  - Given a connected AMQP module with a mock channel, When `channel.emit('error', new Error('PRECONDITION_FAILED'))` fires, Then `connected` becomes `false` and the reconnect backoff is scheduled.
  - Given reconnect backoff scheduled, When delay elapses, Then `amqplib.connect` is called again.
- Fixtures / hooks: Mock `amqplib.connect` to return a mock connection with a mock channel; use jest timers for backoff.
- Gaps: None.
- Evidence: Section 5 reconnect algorithm step 3a; `plan.md` risks section

- Surface: No-config graceful degradation (unit)
- Scenarios:
  - Given `RABBITMQ_URL` is not set in config, When `createSseRouter` handles a connect where callback returns `bindings: ["x"]`, Then no AMQP queue setup is attempted.
  - Given `RABBITMQ_URL` is not set, When `/readyz` is called, Then no `[WARN]` log is emitted and response is unaffected.
- Fixtures / hooks: `config.rabbitmqUrl = null`; mock `getChannel` (should not be called).
- Gaps: None.
- Evidence: Change brief requirement 1; gateway brief section 1

- Surface: Integration — full publish-to-SSE flow
- Scenarios:
  - Given RabbitMQ running at `localhost:5672`, a mock callback server returning `{ "request_id": "r1", "bindings": ["connection.r1"] }`, and an SSE client connected, When a message `{ "event": "ping", "data": "\"pong\"" }` is published to `sse.events` with routing key `connection.r1`, Then the SSE client receives the event.
  - Given the same setup, When two messages are published in sequence, Then both are received in order.
- Fixtures / hooks: `MockServer` returning bindings in connect response; direct amqplib publish in test setup; `RABBITMQ_URL=amqp://guest:guest@localhost:5672/` in test config.
- Gaps: None. Use `__tests__/utils/sseStreamReader.ts` (already in repo) as the streaming HTTP client for integration tests — it handles the keep-alive delivery timing required here. Pair with a 2 s polling timeout for AMQP delivery assertions as noted in section 15.
- Evidence: `__tests__/integration/sse.test.ts:50-80` — existing SSE stream test pattern

- Surface: Integration — reconnect / queue reuse
- Scenarios:
  - Given a client has previously connected with `request_id = "r1"` and disconnected, and the queue `sse.conn.r1` still exists with a buffered message, When the same client reconnects (callback returns same `request_id`), Then the buffered message is delivered after connection is established.
- Fixtures / hooks: Publish a message to the queue between disconnect and reconnect; assert queue explicitly before reconnect to simulate DA backend publishing during the gap.
- Gaps: Timing-sensitive; test must wait for AMQP delivery with reasonable timeout (2 s).
- Evidence: Gateway brief section 3 "assertQueue is idempotent"; change brief "Reconnect reuses queues"

- Surface: Integration — routing key filtering
- Scenarios:
  - Given two SSE connections, each with different `bindings` (conn A: `["connection.a"]`, conn B: `["connection.b"]`), When a message is published with routing key `connection.a`, Then only connection A receives the event.
- Fixtures / hooks: Two simultaneous connections via two separate `request` calls; mock callback returning different bindings per token.
- Gaps: None.
- Evidence: Gateway brief "Routing keys" section

- Surface: Integration — mixed mode (HTTP + AMQP)
- Scenarios:
  - Given a connection with AMQP bindings, When an event is also sent via `POST /internal/send`, Then both the AMQP event and the HTTP event are delivered to the SSE stream.
- Fixtures / hooks: Same as full flow test; add `/internal/send` call after AMQP event.
- Gaps: None.
- Evidence: Change brief requirement 5; gateway brief "existing HTTP /internal/send endpoint remains fully functional"

- Surface: Integration — HTTP-only fallback (no `RABBITMQ_URL`)
- Scenarios:
  - Given `RABBITMQ_URL` is not configured, When an SSE client connects and callback returns bindings, Then no AMQP queue is created and the connection works normally via HTTP `/internal/send`.
- Fixtures / hooks: `config.rabbitmqUrl = null`.
- Gaps: None.
- Evidence: Change brief requirement 5

---

## 14) Implementation Slices

- Slice: 1 — Dependencies and config
- Goal: Add amqplib to the project and extend config; validates the TypeScript build still passes.
- Touches: `package.json`, `src/config.ts`
- Dependencies: None.

- Slice: 2 — `src/rabbitmq.ts` module (connection management only, no per-connection ops)
- Goal: Establish AMQP connection with reconnect backoff, export `getChannel()`, `connectRabbitMQ()`, `shutdownRabbitMQ()`.
- Touches: `src/rabbitmq.ts` (new), `src/index.ts` (call connectRabbitMQ and shutdownRabbitMQ)
- Dependencies: Slice 1.

- Slice: 3 — Callback body parsing
- Goal: `CallbackResult` gains `requestId` and `bindings`; existing tests still pass.
- Touches: `src/callback.ts`, `__tests__/unit/rabbitmq.test.ts` (callback parsing tests)
- Dependencies: Slice 1 (type availability).

- Slice: 4 — `ConnectionRecord` extension and per-connection AMQP queue lifecycle
- Goal: After buffer flush, assert queue, bind, start consuming; cancel on disconnect.
- Touches: `src/connections.ts`, `src/routes/sse.ts`, `src/routes/internal.ts`, `src/rabbitmq.ts` (add assertQueue, bindQueue, startConsumer, cancelConsumer methods and reverse Map), `__tests__/unit/rabbitmq.test.ts`
- Dependencies: Slices 2 and 3.

- Slice: 5 — Health warning and integration tests
- Goal: `/readyz` log warning; full integration test suite for RabbitMQ transport.
- Touches: `src/routes/health.ts`, `__tests__/integration/rabbitmq.test.ts` (new)
- Dependencies: Slice 4.

---

## 15) Risks & Open Questions

- Risk: Race between client disconnect and `channel.consume` completing (consumer setup in-flight)
- Impact: Orphaned consumer in RabbitMQ; messages requeued indefinitely until queue TTL fires.
- Mitigation: In the message handler, check `getConnection(token)` and nack-with-requeue if the connection is gone. Queue TTL (5 min default) bounds the worst-case duration.

- Risk: amqplib channel-level errors (e.g., queue redeclared with different arguments) crash the channel
- Impact: All consumers on the shared channel are lost; new consumers cannot be started until reconnect.
- Mitigation: Attach `channel.on('error', ...)` handler to log and trigger reconnect (same path as connection error). Use `assertQueue` which is idempotent only when arguments match exactly — ensure queue TTL config is consistent across restarts.

- Risk: Integration test reliability — timing dependency on RabbitMQ message delivery
- Impact: Flaky tests if message delivery takes longer than the assertion window.
- Mitigation: Use polling with a reasonable timeout (2 s) rather than fixed sleep in integration tests. Gate tests on RabbitMQ availability.

- Risk: `@types/amqplib` type definitions lag amqplib API changes
- Impact: TypeScript compilation errors if amqplib is updated.
- Mitigation: Pin both `amqplib` and `@types/amqplib` to specific minor versions in `package.json`. Check compatibility when upgrading.

- Risk: Reconnect loop re-establishing consumers iterates `connections` Map — if the Map is large, this is blocking
- Impact: Negligible for the controlled single-instance environment; not a scaling concern per architecture constraints.
- Mitigation: No action required; single-process constraint from `CLAUDE.md` makes this acceptable.

---

## 16) Confidence

Confidence: High — requirements are fully specified in the change brief and gateway brief, the codebase is small and well-understood, the integration points are clearly identified with line-level evidence, and all design questions have been resolved autonomously per the brief's Q&A section.
