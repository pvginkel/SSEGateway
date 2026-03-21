# Change Brief: RabbitMQ Transport for SSE Gateway

## Summary

Add RabbitMQ as an additive event delivery transport to the SSE Gateway. When `RABBITMQ_URL` is configured, the gateway creates a named AMQP queue per SSE connection, binds it to routing keys returned by the connect callback, and forwards messages from the queue to the SSE stream.

## Context

The Design Assistant (DA) backend has been updated (slice 017) to:
1. Publish SSE events to a RabbitMQ topic exchange (`sse.events`) instead of HTTP POST to `/internal/send`
2. Return a `bindings` array and `request_id` in the connect callback response

The gateway must now consume from RabbitMQ queues and forward messages to SSE streams.

## Requirements

### Functional

1. **New config variables**: `RABBITMQ_URL` (optional, enables RabbitMQ when set) and `RABBITMQ_QUEUE_TTL_MS` (default 300000ms).

2. **AMQP connection management** (`src/rabbitmq.ts`):
   - Single AMQP connection + single shared channel
   - Declare `sse.events` topic exchange (durable) on startup
   - Reconnect with backoff on connection loss
   - Prefetch set to 10

3. **Connect callback response parsing**: Parse `request_id` (string) and `bindings` (string array) from the callback response body on success. Add these as optional fields to `CallbackResult`.

4. **Per-connection queue lifecycle**:
   - After successful connect callback, if `bindings` is present and non-empty and RabbitMQ is connected:
     - Assert queue `sse.conn.<request_id>` (not exclusive, not auto-delete, `x-expires` = TTL)
     - Bind to `sse.events` exchange for each routing key in `bindings`
     - Start consuming AFTER the callback window closes (`ready: true` and buffer flushed)
   - Messages: parse JSON body `{ "event": "event_name", "data": "..." }`, write to SSE stream, ack on success, nack with requeue on write failure
   - On disconnect: cancel consumer, do NOT delete queue (TTL handles cleanup)

5. **HTTP `/internal/send` unchanged**: Continues to work for all projects. Close is exclusively an HTTP operation.

6. **ConnectionRecord updates**: Add optional `amqpQueueName` and `amqpConsumerTag` fields.

7. **Readiness check**: Log warning if RabbitMQ configured but not connected. Do NOT make it a hard readiness dependency.

8. **Graceful shutdown**: Cancel all AMQP consumers, close channel and connection before closing HTTP connections.

### Design Decisions (from Q&A)

- `request_id` is distinct from gateway `token` — it comes from the callback response, originates from the client URL
- Reconnect reuses queues because DA backend returns same `request_id` for same client
- Don't unbind on disconnect — allows reconnecting clients to drain buffered messages
- `data` field in RabbitMQ messages is pre-serialized string (same as HTTP `/internal/send`)
- Nack with `requeue: true` on write failure
- Single channel is acceptable for the controlled environment
- On AMQP connection loss: leave SSE connections open, log warning, reconnect with backoff, re-establish consumers
- No close signal via RabbitMQ — close is HTTP-only

### Out of Scope

- Dynamic binding updates after connection
- Message persistence/durability
- Dead letter queues
- Multiple exchanges

## Reference

- Gateway brief: `/work/DesignAssistant/docs/slices/017_sse_rabbitmq_transport/gateway_brief.md`
- Shared conventions: exchange `sse.events` (topic, durable), queue naming `sse.conn.<request_id>`, message format `{ "event": "event_name", "data": "..." }`
