# Code Review — RabbitMQ Transport for SSEGateway

Reviewed: unstaged changes relative to `main` (2026-03-21)
Changed files: `src/rabbitmq.ts` (new), `src/config.ts`, `src/callback.ts`, `src/connections.ts`, `src/routes/sse.ts`, `src/routes/internal.ts`, `src/routes/health.ts`, `src/index.ts`, `__tests__/unit/rabbitmq.test.ts` (new), `__tests__/unit/rabbitmq_reconnect.test.ts` (new), `__tests__/integration/rabbitmq.test.ts` (new), `__tests__/utils/mockServer.ts`, `package.json`, and five pre-existing integration test files updated to include new Config fields.

---

## 1) Summary & Decision

**Readiness**

The implementation is thorough and well-structured. Every area called out in the plan is addressed. The module boundary (`src/rabbitmq.ts`) is clean, the orphaned-consumer guard is in place, reconnect backoff is capped correctly, and AMQP consumer cleanup is wired in at all three disconnect paths. One Blocker stands out: the `nack(msg, false, true)` (requeue) used when a consumer tag is absent from the reverse map will cause infinite requeue loops for messages that arrive after a disconnect clears the map. This is reachable in normal operation and cannot be fixed without changing the requeue flag. Three additional Major issues — a TOCTOU window between `getChannel()` check and `assertQueue` that can cause a mid-setup crash, the `reestablishConsumers` path silently skipping re-binding (routing keys are lost on reconnect), and the integration test module state problem from mixing `connectRabbitMQ` with module-singleton state across `beforeEach` — are covered below. These must be resolved before shipping.

**Decision**

`NO-GO` — The infinite nack/requeue loop on missing consumer tag (Blocker) and the missing re-bind on reconnect (Major, silent data loss) must be fixed. The TOCTOU channel-loss crash (Major) and test state isolation issue (Major) should also be addressed in the same pass.

---

## 2) Conformance to Plan (with evidence)

**Plan alignment**

- `§1 Intent` — additive, optional transport ↔ `src/config.ts:59` — `rabbitmqUrl = process.env.RABBITMQ_URL || null`; all existing paths unchanged when null.
- `§2 src/rabbitmq.ts new file` ↔ `src/rabbitmq.ts:1-498` — full module with connection management, reconnect backoff, per-connection queue lifecycle.
- `§2 src/config.ts` ↔ `src/config.ts:14-17,58-84` — `rabbitmqUrl` and `rabbitmqQueueTtlMs` added with documented defaults and validation.
- `§2 src/callback.ts` ↔ `src/callback.ts:147-174` — `response.text()` parsed; `requestId` and `bindings` extracted into `CallbackResult`.
- `§2 src/connections.ts` ↔ `src/connections.ts:31-34` — `amqpQueueName?` and `amqpConsumerTag?` added as optional fields.
- `§2 src/routes/sse.ts — after buffer flush` ↔ `src/routes/sse.ts:211-238` — AMQP queue setup placed after `connectionRecord.eventBuffer = []` on line 209, exactly as specified.
- `§2 src/routes/sse.ts — handleDisconnect` ↔ `src/routes/sse.ts:308-316` — consumer cancellation before `removeConnection`.
- `§2 src/routes/internal.ts` ↔ `src/routes/internal.ts:208-216, 263-271` — consumer cancellation in both `handleEventAndClose` error path and `handleServerClose`.
- `§2 src/routes/health.ts` ↔ `src/routes/health.ts:46-48` — warning log when configured but not connected.
- `§2 src/index.ts` ↔ `src/index.ts:30-34, 72-75` — `connectRabbitMQ` at startup, `shutdownRabbitMQ` before `server.close`.
- `§5 Algorithms — orphaned-consumer guard` ↔ `src/rabbitmq.ts:165-178` — implemented; checks `getConnection(token)` after `consume` resolves and cancels immediately if absent.
- `§5 channel.on('error') handler` ↔ `src/rabbitmq.ts:371-374` — attached immediately after channel creation.
- `§5 reestablishConsumers on reconnect` ↔ `src/rabbitmq.ts:448-497` — iterates `connections` Map and calls `ch.consume` for each record with `amqpQueueName`.
- `§6 Invariant: reverse map entry and consumer tag set atomically` ↔ `src/rabbitmq.ts:181` — `consumerTagToToken.set` in the same synchronous block as `return consumerTag`.
- `§1 Single AMQP connection, single shared channel, prefetch 10` ↔ `src/rabbitmq.ts:30-33, 377` — one connection, one channel, `ch.prefetch(10)`.

**Gaps / deviations**

- `§5 — reestablishConsumers MUST re-bind routing keys, not just re-consume` — `src/rabbitmq.ts:468-480` calls `ch.assertQueue` then `ch.consume`, but never calls `ch.bindQueue` for any routing keys. On reconnect a new channel gets a fresh exchange state; the queue's existing bindings may still exist in RabbitMQ (they survive AMQP reconnect as long as the queue itself survives), but this is broker-version-dependent and undocumented behaviour. More critically, the `ConnectionRecord` does not store the original `bindings` list, so re-binding is impossible without them. The plan at `§5 step 4` says "re-establish consumers" and `bindQueue` is idempotent — the intent was to re-bind. This is at minimum an omission risk.

- `§6 Invariant: consumer tag and reverse map removed atomically` — In the write-failure path of `createMessageHandler` (`src/rabbitmq.ts:306,317`), `consumerTagToToken.delete` and `removeConnection` are separated by two `await` calls (`ch.cancel` and `sendDisconnectCallback`). Another incoming message for the same tag could arrive in the gap between the delete and the connection removal, find no token in the reverse map, and nack-with-requeue unnecessarily. This is a minor race, not a data-loss risk, but it deviates from the plan's atomicity requirement.

- `§1 — "Queue name computation" unit tests test only string template literals, not the actual module code` — `__tests__/unit/rabbitmq.test.ts:211-230` asserts template string behaviour against inline expressions rather than calling any exported function. While the queue name is derived inline in `src/routes/sse.ts:219`, these tests provide no coverage of whether the running code uses the right formula. Low severity, but the test value is marginal.

---

## 3) Correctness — Findings (ranked)

- Title: **Blocker — Infinite nack/requeue loop when consumer tag is absent from reverse map**
- Evidence: `src/rabbitmq.ts:269-277`
  ```typescript
  const token = consumerTagToToken.get(msg.fields.consumerTag);
  if (!token) {
    logger.warn(`AMQP message for unknown consumer tag: tag=${msg.fields.consumerTag}`);
    ch.nack(msg, false, true);   // <-- requeue=true
    return;
  }
  ```
- Impact: When a client disconnects, `handleDisconnect` calls `cancelConsumer` which removes the entry from `consumerTagToToken` synchronously at `src/rabbitmq.ts:198`. However, because `cancelConsumer` awaits `ch.cancel` and the broker may deliver an in-flight message before the cancel is acknowledged, the handler runs with the tag already removed from the map. The handler nacks with `requeue=true`, which returns the message to the queue. If the connection is also gone from the `connections` Map, the orphaned consumer (or any consumer that re-consumes the same queue on reconnect) will deliver the same message again, hitting the same code path forever. The only exit is queue TTL expiry (up to 5 minutes, 10 messages deep under prefetch). Under load this is a runaway nack loop.
- Fix: Change `ch.nack(msg, false, true)` at line 275 to `ch.nack(msg, false, false)` (requeue=false, discard). The message was destined for a now-gone consumer. Discarding is the correct behaviour; requeue is only appropriate for transient write failures where the client may reconnect.
- Confidence: High

  Step-by-step failure:
  1. SSE client disconnects.
  2. `handleDisconnect` removes entry from `consumerTagToToken` (sync).
  3. `cancelConsumer` awaits `ch.cancel(tag)`.
  4. Before broker processes cancel, broker delivers message for that tag.
  5. Handler fires: `consumerTagToToken.get(tag)` → undefined.
  6. `ch.nack(msg, false, true)` requeueing the message.
  7. Broker redelivers. Go to step 5. Loop.

---

- Title: **Major — TOCTOU crash: channel becomes null between `getChannel()` guard and `assertQueue`**
- Evidence: `src/routes/sse.ts:213-233`
  ```typescript
  if (callbackResult.bindings?.length && callbackResult.requestId && getChannel() && config.callbackUrl) {
    const queueName = `sse.conn.${callbackResult.requestId}`;
    try {
      const messageHandler = createMessageHandler(config.callbackUrl);
      const consumerTag = await setupConnectionQueue(   // <-- awaits here
        token, queueName, callbackResult.bindings, config, messageHandler
      );
  ```
  Inside `setupConnectionQueue`:
  ```typescript
  const ch = getChannel();   // src/rabbitmq.ts:142
  if (!ch) { return null; }
  await ch.assertQueue(...);  // channel may have become null/closed here
  ```
- Impact: If RabbitMQ drops the connection between the `getChannel()` check and the `ch.assertQueue` call, `amqpChannel` is set to null by `handleConnectionLoss` (sync) but `ch` is a local reference to the now-closed channel object. `ch.assertQueue` will reject with an AMQP error. This is caught by the `try/catch` at `src/routes/sse.ts:233` which logs a warn and continues in HTTP-only mode — so the connection is not lost. However, the reject propagates as a thrown error in `setupConnectionQueue`, the AMQP library may also emit additional events, and the `consumerTagToToken` reverse map entry is never added. This is caught, but it means the try/catch at `sse.ts:233` is doing more work than documented. The real risk is `assertQueue` throwing an uncaught error in `reestablishConsumers`, where there is no equivalent try/catch for the `getChannel()` re-check inside the loop (`src/rabbitmq.ts:461`).
- Fix: Inside `reestablishConsumers`, move the `const ch = amqpChannel` check inside the loop body before each `assertQueue` call, not just the break check. Alternatively, snapshot `ch` once before the loop and verify it is still the same object before each step.
- Confidence: Medium

---

- Title: **Major — `reestablishConsumers` does not re-bind routing keys**
- Evidence: `src/rabbitmq.ts:468-480`
  ```typescript
  await ch.assertQueue(record.amqpQueueName, { ... });
  const consumeResult = await ch.consume(record.amqpQueueName, messageHandler);
  ```
  No call to `ch.bindQueue` anywhere in `reestablishConsumers`.
- Impact: RabbitMQ queue bindings are properties of the queue in the broker. After a full broker restart (queue deleted), `assertQueue` creates a new empty queue with no bindings. Messages published to routing keys that match the old bindings will not be routed to the queue. The SSE stream stays open and looks healthy, but AMQP events are silently dropped. Under normal AMQP reconnect (broker did not restart), bindings survive because the queue was not deleted — but this relies on undocumented broker behaviour and the queue TTL. The `ConnectionRecord` does not store the `bindings` list, making re-binding impossible without a schema change.
- Fix: Add `bindings?: string[]` to `ConnectionRecord` alongside `amqpQueueName`. Populate it at `src/routes/sse.ts:229-231` when setting `amqpQueueName`. In `reestablishConsumers`, call `ch.bindQueue(record.amqpQueueName, 'sse.events', key)` for each entry before consuming.
- Confidence: High

---

- Title: **Major — Integration test module-singleton state shared across tests**
- Evidence: `__tests__/integration/rabbitmq.test.ts:170-171`
  ```typescript
  await connectRabbitMQ(config);
  ```
  The `rabbitmq` module holds module-level singletons (`amqpConnection`, `amqpChannel`, `connected`, `reconnectDelayMs`, `consumerTagToToken`). `shutdownRabbitMQ` in `afterEach` at line 189 resets the connection but does not reset `reconnectDelayMs` or `shutdownRequested`. If a test causes `scheduleReconnect` to fire after `shutdownRabbitMQ` is called but before the next `connectRabbitMQ`, the reconnect timer will run `doConnect` with the previous config, potentially interfering with the next test.
  Also: `__tests__/unit/rabbitmq.test.ts:238-280` (Section 3) uses real RabbitMQ connections without `jest.resetModules()`, meaning `connectRabbitMQ` from the same module instance accumulates state. The `beforeEach` only calls `shutdownRabbitMQ`, which does not reset `reconnectDelayMs`.
- Impact: Flaky tests in CI when RabbitMQ reconnect timer fires between test teardown and the next test's setup, leaving stale consumers or a mid-connect state. Not a runtime correctness issue but a test reliability risk.
- Fix: Add `reconnectDelayMs = 1000` and `shutdownRequested = false` reset to `shutdownRabbitMQ`, or export a `resetModuleState()` test helper that tests call in `afterEach`. The reconnect timer is the concrete risk; a `clearTimeout` on any pending reconnect handle during shutdown would close this gap.
- Confidence: Medium

---

- Title: **Minor — `cancelConsumer` in `cancelConsumer` does not skip noop when already removed**
- Evidence: `src/rabbitmq.ts:196-211`
  ```typescript
  export async function cancelConsumer(consumerTag: string): Promise<void> {
    consumerTagToToken.delete(consumerTag);
    const ch = amqpChannel;
    if (!ch) { return; }
    try {
      await ch.cancel(consumerTag);
    } ...
  }
  ```
  If `cancelConsumer` is called twice for the same tag (e.g., from both the write-failure path in `createMessageHandler` and from `handleDisconnect`), the second `ch.cancel` call will be sent to the broker for an already-cancelled consumer. This is harmless in practice (amqplib returns an error caught by the try/catch) but generates a spurious warn log.
- Fix: No code change strictly required; the try/catch already absorbs it. Consider tracking cancelled tags in a Set to make the double-cancel noop in logs, or rely on the existing log as an indicator of a double-cancel scenario worth investigating.
- Confidence: High

---

- Title: **Minor — `handleConnectionLoss` does not null out `amqpConsumerTag` on existing `ConnectionRecord`s**
- Evidence: `src/rabbitmq.ts:405-418` — `handleConnectionLoss` clears `consumerTagToToken` but does not iterate `connections` to null out `amqpConsumerTag` fields.
- Impact: After reconnect, `reestablishConsumers` replaces `record.amqpConsumerTag` with the new tag. But if a disconnect event arrives between `handleConnectionLoss` (which cleared the reverse map) and `reestablishConsumers` (which rebuilds it), `handleDisconnect` will call `cancelConsumer(record.amqpConsumerTag)` with the old stale tag. `cancelConsumer` will delete from the (already empty) reverse map (noop) and then call `ch.cancel(staleTag)` on the new channel — which may fail with a "consumer not found" error, generating a noisy warn log.
- Fix: After clearing `consumerTagToToken` in `handleConnectionLoss`, iterate `connections` and set `record.amqpConsumerTag = undefined` for each record. This prevents stale cancel calls during the reconnect window.
- Confidence: Medium

---

## 4) Over-Engineering & Refactoring Opportunities

- Hotspot: Three-site copy-paste of AMQP consumer cancel with try/catch and warn logging
- Evidence: `src/routes/sse.ts:308-316`, `src/routes/internal.ts:208-216`, `src/routes/internal.ts:263-271` — identical 9-line blocks
- Suggested refactor: The `cancelConsumer` function in `rabbitmq.ts` already encapsulates the try/catch; callers only need `await cancelConsumer(record.amqpConsumerTag)`. The outer try/catch at each call site is redundant because `cancelConsumer` never throws. Remove the try/catch wrappers at the three call sites, relying on `cancelConsumer`'s internal error handling.
- Payoff: Removes ~24 lines of duplicated error-handling boilerplate; future changes to cancel logic are made in one place.

---

- Hotspot: `createMessageHandler` is a factory that closes over `callbackUrl` but also reaches into module-level `amqpChannel` and `consumerTagToToken` directly
- Evidence: `src/rabbitmq.ts:232-330` — the returned handler references `amqpChannel` (line 241) and `consumerTagToToken` (line 269, 306) via closure over module-level variables rather than through the exported `getChannel()` / `getTokenForConsumerTag()` API.
- Suggested refactor: Replace direct references to module-level variables inside the handler with calls to the exported helpers (`getChannel()`, `getTokenForConsumerTag(tag)`). This is a single-file change and makes the handler independently unit-testable without depending on module state.
- Payoff: Improves testability and makes the boundary between the handler and the module clearer.

---

- Hotspot: `reestablishConsumers` receives `config` only for `rabbitmqQueueTtlMs` and `callbackUrl`, but accesses the module-level `connections` Map directly
- Evidence: `src/rabbitmq.ts:448-497` — `connections` imported directly from `connections.ts`; `config` passed for two fields.
- Suggested refactor: Acceptable for this codebase given the module-singleton pattern. No change needed, but document the coupling in a comment if `reestablishConsumers` grows.
- Payoff: Low — not worth changing.

---

## 5) Style & Consistency

- Pattern: `nack(msg, false, true)` used inconsistently — some cases should be `requeue=false`
- Evidence: `src/rabbitmq.ts:264, 275, 283, 324` — all four nack sites use `requeue=true`. Lines 264, 275, and 283 cover parse failure, missing consumer tag, and missing connection respectively — all cases where the message cannot be processed by any current consumer and requeue will cause infinite redelivery.
- Impact: Infinite redelivery loops for unprocessable messages (parse errors, disconnected clients). Depends on broker-level dead-letter or queue TTL to eventually clear.
- Recommendation: Use `nack(msg, false, false)` (discard) for the three "unprocessable" paths (lines 264, 275, 283). Reserve `nack(msg, false, true)` only for the write-failure path at line 324, where the client may reconnect and consume the message via a fresh consumer.

---

- Pattern: `mockServer.ts` type cast workaround for optional field
- Evidence: `__tests__/utils/mockServer.ts:62` — `rabbitmqResponse: config.rabbitmqResponse ?? null as unknown as RabbitMQResponseBody`
- Impact: The `as unknown as RabbitMQResponseBody` double-cast hides a type error (assigning `null` to a field typed as `RabbitMQResponseBody`). Should be typed as `RabbitMQResponseBody | null`.
- Recommendation: Change `MockServerConfig.rabbitmqResponse` to `rabbitmqResponse?: RabbitMQResponseBody | null` and remove the cast. The null check at `mockServer.ts:207` already handles `null` correctly.

---

- Pattern: `(connectionRecord.res as any).flush()` uses `any` cast
- Evidence: `src/rabbitmq.ts:293-295`
- Impact: Matches the pattern used in the rest of the codebase for flush (acceptable given the Express response type does not expose `flush`). Minor.
- Recommendation: Extract a `flushResponse(res)` helper once across the codebase to avoid the repeated `as any` cast. Not blocking.

---

## 6) Tests & Deterministic Coverage

- Surface: `src/callback.ts` — body parsing
- Scenarios:
  - Given a 2xx response with valid JSON, When `sendConnectCallback` is called, Then `requestId` and `bindings` are populated (`__tests__/unit/rabbitmq.test.ts:84-103`)
  - Given empty body, When called, Then both fields are undefined (`:105-122`)
  - Given non-JSON body, When called, Then graceful fallback (`:124-141`)
  - Given non-2xx, When called, Then fields absent (`:143-162`)
  - Given `text()` throws, When called, Then success=true, fields undefined (`:185-203`)
- Hooks: `jest.spyOn(globalThis, 'fetch')` — clean, no module reset needed.
- Gaps: No test for `bindings` containing non-string elements (should be filtered, not crash). Present implementation does a type guard at `src/callback.ts:164`, but no test verifies rejection of `{ bindings: [1, 2, 3] }`.
- Evidence: `__tests__/unit/rabbitmq.test.ts:79-204`

---

- Surface: `src/rabbitmq.ts` — connection state and queue lifecycle
- Scenarios:
  - `isConnected() === true` and channel non-null after connect (`__tests__/unit/rabbitmq.test.ts:250-257`)
  - `isConnected() === false` when URL is null (`:259-266`)
  - `isConnected() === false` when URL unreachable (`:268-279`)
  - `setupConnectionQueue` returns consumer tag and registers in reverse map (`:301-327, 329-357`)
  - Orphaned-consumer guard returns null when token absent (`:359-379`)
  - `setupConnectionQueue` returns null when channel null (`:381-387`)
  - Handler acks on valid message delivery (`:438-497`)
  - Handler nacks on invalid JSON (`:499-522`)
  - Handler nacks on unknown consumer tag (`:524-547`)
  - Handler noop on null message (`:549-557`)
  - Handler nacks and sends disconnect callback on write failure (`:559-618`)
- Hooks: Real RabbitMQ; `connections.clear()` + `shutdownRabbitMQ()` in `before/afterEach`.
- Gaps:
  - No test for `reestablishConsumers` (reconnect path rebuilding consumers for active connections). This is a Major omission — the reconnect flow is tested by `rabbitmq_reconnect.test.ts` for backoff and channel error, but the consumer re-establishment after a reconnect is not exercised.
  - No test verifying that the `nack(msg, false, true)` on unknown consumer tag does not cause a requeue loop (the Blocker identified above).
  - No test for the `shutdownRabbitMQ` consumer-cancellation loop.
- Evidence: `__tests__/unit/rabbitmq.test.ts:232-620`, `__tests__/unit/rabbitmq_reconnect.test.ts`

---

- Surface: `src/rabbitmq.ts` — reconnect backoff and channel error
- Scenarios:
  - Reconnect delay caps at 30s after multiple failures (`__tests__/unit/rabbitmq_reconnect.test.ts:28-62`)
  - Channel error sets `connected=false` and triggers reconnect (`:69-123`)
  - Connection error sets `connected=false` (`:125-174`)
- Hooks: `jest.unstable_mockModule` + `jest.useFakeTimers()`.
- Gaps: Timer not explicitly cleared in test teardown (`jest.useRealTimers()` is called but no `shutdownRabbitMQ`), leaving potential for module-level reconnect timers to leak across tests in the same worker.
- Evidence: `__tests__/unit/rabbitmq_reconnect.test.ts`

---

- Surface: Integration — full publish-to-SSE flow
- Scenarios:
  - Single message delivered end-to-end (`__tests__/integration/rabbitmq.test.ts:206-245`)
  - Multiple messages delivered in order (`:251-284`)
  - Routing key isolation between two connections (`:290-327`)
  - Mixed HTTP + AMQP events on same stream (`:333-370`)
  - HTTP-only mode when no bindings returned (`:376-403`)
  - HTTP-only mode when `rabbitmqUrl=null` (`:409-460`)
  - Queue reuse on second SSE connection with same request_id (`:466-519`)
  - Consumer cancelled on SSE client disconnect (`:525-549`)
- Hooks: Real RabbitMQ; `connectRabbitMQ`/`shutdownRabbitMQ` in `before/afterEach`; `MockServer` for callback simulation.
- Gaps:
  - No integration test for the reconnect path (simulating broker drop while SSE connections are open, then verifying delivery resumes).
  - No test for a connection that disconnects while AMQP queue setup is in-flight (the orphaned-consumer scenario under real broker latency).
  - The disconnect consumer-cancel test (`Test 8`) verifies `connections.size === 0` but does not verify the broker-side consumer was actually cancelled (no assertion on remaining consumer count in RabbitMQ).
- Evidence: `__tests__/integration/rabbitmq.test.ts:135-550`

---

## 7) Adversarial Sweep

- Title: **Blocker (from §3) — Infinite nack/requeue loop reproduced**
- Evidence: `src/rabbitmq.ts:269-276` as described above.
- Failure reasoning:
  1. `cancelConsumer` deletes from `consumerTagToToken` at line 198 (sync).
  2. Broker delivers one in-flight message before processing the cancel.
  3. Handler sees `consumerTagToToken.get(tag) === undefined`.
  4. `ch.nack(msg, false, true)` — message goes back to queue.
  5. No consumer is registered in `consumerTagToToken`, so every redelivery follows step 3-4. Loop.
- Fix: `nack(msg, false, false)` at line 275.
- Confidence: High

---

- Title: **Major (from §3) — Missing re-bind in `reestablishConsumers` — silent AMQP event loss after full broker restart**
- Evidence: `src/rabbitmq.ts:448-497` — no `ch.bindQueue` calls.
- Failure reasoning:
  1. Broker restarts (queue deleted from memory).
  2. Gateway reconnects; `reestablishConsumers` calls `assertQueue` (creates new empty queue), `consume`.
  3. Producer publishes to routing key. Exchange has no binding → message dropped.
  4. SSE stream stays open; client receives nothing. No error logged.
- Fix: Store `bindings` in `ConnectionRecord`; re-bind in `reestablishConsumers`.
- Confidence: High

---

- Title: **Probe: connection `close` event fires twice (connection error + close both fire)**
- Evidence: `src/rabbitmq.ts:352-362` — both `conn.on('error')` and `conn.on('close')` call `handleConnectionLoss`.
- Failure reasoning: When the TCP connection is lost, amqplib emits `error` then `close`. Both handlers call `handleConnectionLoss`, which calls `scheduleReconnect`. Two reconnect timers are scheduled with the same delay.
- Why code held up: `doConnect` sets `connected = true` on success, and subsequent `scheduleReconnect` calls check `shutdownRequested` but not `connected`. However, `doConnect` is idempotent in practice because the second reconnect either also succeeds (and resets state correctly) or fails (and schedules a third). The double-reconnect is wasteful but not incorrect in single-threaded Node.js. Worth hardening with a `reconnecting: boolean` guard, but not a correctness blocker.
- Confidence: Medium

---

- Title: **Probe: `cancelConsumer` called from `shutdownRabbitMQ` and from disconnect handler concurrently during shutdown**
- Evidence: `src/rabbitmq.ts:74-84` — `shutdownRabbitMQ` iterates `consumerTagToToken` and cancels all. If a client disconnects while `shutdownRabbitMQ` is running, `handleDisconnect` also calls `cancelConsumer(record.amqpConsumerTag)`.
- Why code held up: Both callers remove from `consumerTagToToken` first (line 198 and line 84). The second `ch.cancel` call fails with "consumer not found" and is caught by the try/catch. No state corruption. The double-cancel generates a warn log during shutdown, which is acceptable.
- Confidence: High

---

- Title: **Probe: `reestablishConsumers` modifies `connections` entries during iteration**
- Evidence: `src/rabbitmq.ts:476-480` — `record.amqpConsumerTag = newTag` mutates a `ConnectionRecord` while iterating `for...of connections`. JavaScript Map `for...of` iterates a snapshot of keys inserted before iteration begins; mutation of values (not keys) during iteration is safe.
- Why code held up: No structural mutation of the Map (no `.set`/`.delete` on new keys during iteration). Value mutation is safe. The only risk would be if `handleDisconnect` called `removeConnection(token)` during an `await` inside the loop, but since Node.js is single-threaded and the `await` yields only to I/O completions (not to other synchronous code in the same turn), this is serialized correctly.
- Confidence: High

---

## 8) Invariants Checklist

- Invariant: Every active AMQP consumer has a corresponding entry in `consumerTagToToken` and a `ConnectionRecord` in `connections`.
  - Where enforced: `src/rabbitmq.ts:181` — `consumerTagToToken.set` after `ch.consume` returns; orphan guard at line 165-178 removes consumers for gone connections before returning.
  - Failure mode: If `handleConnectionLoss` fires between `consume` resolving and `consumerTagToToken.set` — impossible in single-threaded Node.js because there is no `await` between them.
  - Protection: Node.js event-loop serialization; orphan guard.
  - Evidence: `src/rabbitmq.ts:161-187`

---

- Invariant: AMQP queue setup occurs strictly after the callback window closes (after `eventBuffer` is cleared and `ready = true`).
  - Where enforced: `src/routes/sse.ts:209-238` — `connectionRecord.eventBuffer = []` at line 209; AMQP block starts at line 211.
  - Failure mode: If the AMQP setup block is moved before the buffer flush, AMQP events could arrive and be written to the SSE stream before buffered HTTP events are flushed, violating ordering.
  - Protection: Code placement enforced by structure; `CLAUDE.md` documents the required ordering.
  - Evidence: `src/routes/sse.ts:190-238`

---

- Invariant: When `connected = false`, `getChannel()` returns `null` and no new `assertQueue`/`bindQueue`/`consume` operations are initiated.
  - Where enforced: `src/rabbitmq.ts:112-114` — `getChannel()` checks `connected` flag; `src/routes/sse.ts:214` — `getChannel()` guard before entering AMQP setup.
  - Failure mode: TOCTOU — `connected` flips to false after the guard check but before `setupConnectionQueue`'s internal `getChannel()` check. Raises an error on `assertQueue`, caught by try/catch at `sse.ts:233`.
  - Protection: Try/catch fallback to HTTP-only mode. The race is handled defensively.
  - Evidence: `src/rabbitmq.ts:112-114`; `src/routes/sse.ts:213-237`

---

- Invariant: All three SSE connection termination paths (client disconnect, server close, write failure) cancel the AMQP consumer and remove from the reverse map.
  - Where enforced: `src/routes/sse.ts:308-316` (client disconnect), `src/routes/internal.ts:263-271` (server close), `src/routes/internal.ts:208-216` + `src/rabbitmq.ts:305-311` (write failure in HTTP path and AMQP path respectively).
  - Failure mode: A disconnect path that skips consumer cancel leaves an orphaned consumer in the broker, delivering messages to a closed stream indefinitely.
  - Protection: All three paths confirmed in diff; write-failure in `createMessageHandler` also cleans up directly.
  - Evidence: Confirmed in diff review above.

---

- Invariant: `shutdownRabbitMQ` completes before `server.close()` during graceful shutdown.
  - Where enforced: `src/index.ts:72-75` — `await shutdownRabbitMQ()` inserted before `server.close()`.
  - Failure mode: If `shutdownRabbitMQ` is not awaited, the HTTP server closes while consumers are still active; in-flight messages are nacked with channel closed underneath them.
  - Protection: `await` at line 74. The 10-second forced-shutdown timer provides a hard ceiling.
  - Evidence: `src/index.ts:63-84`

---

## 9) Questions / Needs-Info

- Question: Are RabbitMQ queue bindings guaranteed to survive an AMQP reconnect (channel/connection loss) when the broker does not restart?
- Why it matters: The current `reestablishConsumers` logic skips `bindQueue`. If bindings survive, this is safe. If they do not (e.g., due to a broker restart or queue eviction under memory pressure), messages are silently lost. The fix (storing `bindings` on `ConnectionRecord`) is small regardless; confirming broker behaviour affects urgency.
- Desired answer: Confirmation of the assumed RabbitMQ behaviour or a requirement to add re-binding defensively.

---

- Question: Should parse-failed AMQP messages be sent to a dead-letter exchange or discarded (`nack` with `requeue=false`)?
- Why it matters: The current code uses `nack(msg, false, true)` (requeue) for all failure paths including parse failures. A parse failure is permanent — requeuing it causes an infinite loop until queue TTL fires.
- Desired answer: Confirm that `nack(msg, false, false)` (discard) is the correct policy for parse-failed messages, and that a dead-letter exchange is out of scope (as stated in plan `§1 Out of scope`).

---

- Question: What is the expected behaviour when a `request_id` returned by the callback contains characters that are valid in RabbitMQ queue names but could collide across tenants (e.g., if two backends share the same SSEGateway instance)?
- Why it matters: Queue name is `sse.conn.<request_id>`. If `request_id` is predictable or backend-controlled, an adversary could assert a queue that collides with another client's queue. This is flagged as out of scope ("No authentication") but the question is whether `request_id` uniqueness is enforced upstream.
- Desired answer: Confirmation that `request_id` is a UUID generated by the Python backend per request, or that the single-tenant deployment assumption makes this moot.

---

## 10) Risks & Mitigations (top 3)

- Risk: Infinite nack/requeue loop on disconnect — any message in-flight at client disconnect will cycle indefinitely until queue TTL expires, consuming broker resources and producing continuous warn logs.
- Mitigation: Change `nack(msg, false, true)` to `nack(msg, false, false)` at `src/rabbitmq.ts:275` (and lines 264, 283 for completeness). One-line fix per call site.
- Evidence: Blocker finding in §3; `src/rabbitmq.ts:269-277`

---

- Risk: Silent AMQP event loss after broker restart — `reestablishConsumers` reconnects consumers but does not re-bind queues, causing routing failures that are invisible in logs.
- Mitigation: Store `bindings?: string[]` on `ConnectionRecord` at queue setup time; add `ch.bindQueue` loop in `reestablishConsumers` before `ch.consume`.
- Evidence: Major finding in §3; `src/rabbitmq.ts:448-497`

---

- Risk: Test-suite flakiness from module-singleton reconnect timer leaks — `shutdownRabbitMQ` does not cancel pending reconnect timers, allowing timers to fire between test cases and corrupt module state.
- Mitigation: Track the pending reconnect `setTimeout` handle (store return value of `setTimeout` at `src/rabbitmq.ts:433`) and call `clearTimeout` in `shutdownRabbitMQ` before returning. Also reset `reconnectDelayMs = 1000` in `shutdownRabbitMQ` to ensure backoff state is clean for the next test.
- Evidence: Major finding in §3; `src/rabbitmq.ts:423-441`; `__tests__/unit/rabbitmq_reconnect.test.ts`

---

## 11) Confidence

Confidence: High — all changed files were read in full, the plan was consulted for every algorithm and invariant, and each finding was traced to specific line numbers and reasoned through the Node.js single-threaded execution model. The two highest-severity findings (nack loop and missing re-bind) are independently reachable in production operation and are not speculative.
