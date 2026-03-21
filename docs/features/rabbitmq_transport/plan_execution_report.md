# Plan Execution Report: RabbitMQ Transport for SSE Gateway

## Status

**DONE** — The plan was implemented successfully. All 5 slices are complete, all tests pass, and all code review findings have been resolved.

## Summary

Added RabbitMQ as an additive, optional event delivery transport to the SSE Gateway. When `RABBITMQ_URL` is configured, the gateway creates a named AMQP queue per SSE connection, binds it to routing keys returned by the connect callback, and forwards messages from the queue to the SSE stream. The existing HTTP `/internal/send` endpoint is completely unchanged.

### What was implemented

- **Slice 1 — Dependencies and config**: Added `amqplib` and `@types/amqplib` to dependencies. Extended `Config` with `rabbitmqUrl` and `rabbitmqQueueTtlMs`.
- **Slice 2 — `src/rabbitmq.ts`**: Complete AMQP connection management module with reconnect backoff (1s→30s cap), single connection + channel, prefetch 10, exchange assertion, per-connection queue lifecycle, consumer tracking via reverse map, and graceful shutdown.
- **Slice 3 — Callback body parsing**: Extended `CallbackResult` to parse `requestId` and `bindings` from the connect callback response body.
- **Slice 4 — Per-connection AMQP lifecycle**: After buffer flush, assert queue, bind routing keys, start consuming. Consumer cancellation wired into all three disconnect paths (client disconnect, server close, write failure).
- **Slice 5 — Health warning and tests**: `/readyz` logs warning when RabbitMQ configured but not connected. Full unit and integration test suites.

### Files created
- `src/rabbitmq.ts` — AMQP connection management, queue lifecycle, message handler
- `__tests__/unit/rabbitmq.test.ts` — 23 unit tests
- `__tests__/unit/rabbitmq_reconnect.test.ts` — 3 reconnect/backoff unit tests
- `__tests__/integration/rabbitmq.test.ts` — 8 integration tests

### Files modified
- `package.json` — Added amqplib and @types/amqplib
- `src/config.ts` — Two new config fields
- `src/callback.ts` — Response body parsing for requestId and bindings
- `src/connections.ts` — Added amqpQueueName, amqpConsumerTag, amqpBindings to ConnectionRecord
- `src/routes/sse.ts` — AMQP setup after buffer flush, consumer cancel in handleDisconnect
- `src/routes/internal.ts` — Consumer cancel in handleEventAndClose and handleServerClose
- `src/routes/health.ts` — Warning log for RabbitMQ status
- `src/index.ts` — connectRabbitMQ at startup, async shutdown with shutdownRabbitMQ
- `__tests__/utils/mockServer.ts` — Extended with rabbitmqResponse support
- All existing integration test files — Added new Config fields to test configs

## Code Review Summary

**Initial decision**: NO-GO — 1 Blocker, 3 Major, 2 Minor issues identified.

All issues were resolved:

| Severity | Issue | Resolution |
|----------|-------|------------|
| Blocker | Infinite nack/requeue loop for unknown consumer tags | Changed `nack(msg, false, true)` to `nack(msg, false, false)` at 3 sites (parse failure, unknown tag, disconnected token). Write failure retains `requeue=true`. |
| Major | `reestablishConsumers` missing `bindQueue` on reconnect | Added `amqpBindings` to `ConnectionRecord`; `reestablishConsumers` now re-binds all routing keys before consuming. |
| Major | Reconnect timer leak and stale backoff in `shutdownRabbitMQ` | Track reconnect timer handle; `shutdownRabbitMQ` clears timer and resets `reconnectDelayMs`. |
| Major | Test state isolation from module singleton | Addressed by timer cleanup and state reset in `shutdownRabbitMQ`. |
| Minor | Stale `amqpConsumerTag` on records after connection loss | `handleConnectionLoss` now nulls out `amqpConsumerTag` on all records. |
| Minor | Redundant try/catch around `cancelConsumer` calls | Removed 3 redundant try/catch wrappers; `cancelConsumer` never throws. |
| Style | MockServer type cast workaround | Changed type to `RabbitMQResponseBody | null`, removed unsafe cast. |
| — | amqplib early-delivery race (discovered during fix verification) | Added wrapper handler in `setupConnectionQueue` that auto-registers consumer tag in reverse map on first message delivery, preventing race between `ch.consume` resolution and synchronous message delivery. |
| — | Double-reconnect from error+close events | Added `reconnecting` guard flag to prevent `handleConnectionLoss` from firing twice. |

**Final decision after fixes**: All issues resolved. Build passes, all tests pass.

## Verification Results

### Build
```
> tsc
(clean — no TypeScript errors)
```

### Tests
```
Test Suites: 9 passed, 9 total
Tests:       13 skipped, 109 passed, 122 total
```

- 26 unit tests (callback parsing, queue name, module state, queue lifecycle, message handler, reconnect backoff, channel error, no-config degradation)
- 8 integration tests (publish-to-SSE, message ordering, routing key filtering, mixed HTTP+AMQP, HTTP-only fallback ×2, queue reuse, consumer cancel on disconnect)
- 13 skipped tests are pre-existing (unrelated to this feature)

## Outstanding Work & Suggested Improvements

- **Integration test for reconnect under load**: No test simulates a broker drop while SSE connections are active and verifies delivery resumes after reconnect. The unit tests verify backoff mechanics but not the full end-to-end reconnect-and-redelivery path.
- **Dead letter for parse-failed messages**: Parse-failed messages are now discarded (`nack requeue=false`). If observability of malformed messages is needed, a dead-letter exchange could be added (currently out of scope per plan).
- **Non-string `bindings` array elements**: The callback body parser accepts `bindings` as-is without filtering non-string elements. The DA backend is trusted, but a defensive filter could be added.
- **`publishChannel` in integration tests**: The test publisher's channel could potentially see errors from the queue reuse test's timing, though this is currently handled.
