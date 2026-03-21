# Plan Review: RabbitMQ Transport for SSE Gateway

---

### 1) Summary & Decision

**Readiness**

The plan is detailed, well-researched, and demonstrates solid understanding of the existing codebase. Every integration point is identified with file-and-line evidence, design decisions are recorded in the research log, and the algorithm descriptions are precise enough to guide a competent implementer. Three issues require attention before implementation begins: (1) an unresolved contradiction between the gateway brief and the change brief on whether the `data` field in AMQP messages is a pre-serialized string or a JSON object — the plan asserts the string interpretation but the normative gateway brief specifies an object, and this choice directly affects the message handler implementation and the DA integration contract; (2) a missing orphaned-consumer cleanup path when client disconnect races with the in-flight `channel.consume` resolution — the plan acknowledges the race but leaves the consumer dangling indefinitely rather than cancelling it after the async queue-setup block completes; (3) the `channel.on('error')` handling required to prevent a channel-level error from silently dropping all consumers without triggering reconnect is called out in the risks section but is absent from the algorithm and file-map sections.

**Decision**
`GO-WITH-CONDITIONS` — the plan is implementable as written but the three issues above must be resolved in the plan before the implementation slice that touches `src/rabbitmq.ts` and `src/routes/sse.ts` begins.

---

### 2) Conformance & Fit (with evidence)

**Conformance to refs**

- `change_brief.md` — Pass — `plan.md:55-97` — Additive transport, HTTP `/internal/send` unchanged, all config variables present, graceful shutdown ordered correctly, soft readiness dependency all match the brief.
- `change_brief.md:34` (data format) — Conditional Pass — `plan.md:43, 200-206` — Plan resolves the contradiction in favour of "pre-serialized string" at research-log finding 11; this conflicts with the normative gateway brief (see Major finding below).
- `gateway_brief.md:3-7` — Pass — `plan.md:55-63` — HTTP-only fallback when `RABBITMQ_URL` absent is correctly specified.
- `gateway_brief.md:47-58` — Pass — `plan.md:274-285` — Queue lifecycle (assertQueue, bind, consume, cancel, no-delete on disconnect) matches the brief exactly.
- `gateway_brief.md:108` — Pass — `plan.md:240-241` — `/readyz` soft dependency correctly preserved.
- `gateway_brief.md:113-116` — Pass — `plan.md:309-319` — Shutdown ordering (cancel consumers, close channel, close connection, then HTTP server) is correct.
- `gateway_brief.md:155` (message format) — **Fail** — `plan.md:43, 200-206` — Gateway brief specifies `"data": { ... }` (JSON object); plan treats it as a pre-serialized string. This is the unresolved contradiction; the plan closes it unilaterally without confirming against the gateway brief.
- `CLAUDE.md` (callback window) — Pass — `plan.md:23, 274-285` — AMQP consumption wired after `eventBuffer = []` at `src/routes/sse.ts:203`, matching the "Start AMQP consumption AFTER callback window closes" constraint.
- `CLAUDE.md` (single process, in-memory) — Pass — `plan.md:40-41, 95` — Module-level singleton matches existing `connections` Map pattern; no clustering introduced.
- `CLAUDE.md` (dependencies in `dependencies` not `devDependencies`) — Pass — `plan.md:47, 139-140` — `amqplib` and `@types/amqplib` correctly placed in `dependencies`.

**Fit with codebase**

- `src/callback.ts:144-148` — `plan.md:26, 110-113` — `sendCallback` returns `{ success: true, statusCode }` with no body read; plan correctly identifies this and extends the success branch. The change is minimal and does not break existing callers that only check `success`.
- `src/connections.ts:13-31` — `plan.md:114-116, 183-198` — `ConnectionRecord` extension with two optional fields is additive and safe; existing literal constructors in `src/routes/sse.ts:89-96` need no changes.
- `src/routes/sse.ts:182-234` — `plan.md:119-120, 274-285` — Buffer-flush and heartbeat-start location is confirmed by reading the actual file (lines 182-234 match the plan's claim). AMQP setup is inserted after line 203.
- `src/routes/sse.ts:254-313` — `plan.md:120, 299-307` — `handleDisconnect` is a standalone `async function`; the plan's cancellation steps fit naturally after `clearInterval(record.heartbeatTimer)`.
- `src/routes/internal.ts:197-218` — `plan.md:122-124` — `handleEventAndClose` write-failure path clears heartbeat and calls `removeConnection` then disconnect callback; AMQP cancel must be inserted in the same block before `removeConnection`.
- `src/routes/internal.ts:236-267` — `plan.md:122-124` — `handleServerClose` does the same; identical insertion point.
- `src/index.ts:56-75` — `plan.md:134-136, 309-319` — `setupGracefulShutdown` is a synchronous function that calls `server.close(callback)`. `shutdownRabbitMQ()` is async, so `shutdown` must become `async` or use `.then()`; the plan does not address this change to the function signature. Minor gap.
- `src/server.ts:11-46` — `plan.md:131-133` — Plan notes no signature change to `createApp` is needed because the singleton is imported directly. This is consistent with the existing `connections` Map pattern. Correct.
- `__tests__/integration/sse.test.ts:8-13` — `plan.md:148, 552-554` — The plan correctly flags that existing integration tests use supertest, which may not stream; the note about using `EventSource` or `sseStreamReader` is constructive (the repo already has `__tests__/utils/sseStreamReader.ts`).

---

### 3) Open Questions & Ambiguities

- Question: Is the `data` field in AMQP messages a pre-serialized JSON string (as in HTTP `/internal/send`) or a JSON object (as stated in the gateway brief "Shared conventions" section, `gateway_brief.md:155`)?
- Why it matters: Determines whether the message handler calls `JSON.stringify(msg.data)` before passing to `formatSseEvent`, or passes it verbatim. If the DA backend publishes an object and the gateway treats it as a string, clients will receive `[object Object]` as the data payload.
- Needed answer: Confirm the authoritative wire format with the DA team or by reading the DA publisher code. Update the plan's research-log finding 11 and the AMQP message body contract in section 3 accordingly.

- Question: How should `setupGracefulShutdown` in `src/index.ts` be modified to await `shutdownRabbitMQ()` before calling `server.close()`?
- Why it matters: `shutdownRabbitMQ()` is async (cancels consumers, closes channel, closes connection). The current `shutdown` function is synchronous. Without `await`, AMQP teardown races with HTTP server close.
- Needed answer: The plan should specify whether `shutdown` becomes `async` (and how the process-signal handler is wired) or whether a `.then(() => server.close(...))` chain is used.

- Question: For the orphaned consumer race (client disconnects while `channel.consume` is in-flight), should the post-`consume` resolution check `getConnection(token)` and immediately call `channel.cancel(consumerTag)` if the connection is gone?
- Why it matters: Without this check, the consumer persists in RabbitMQ until TTL expiry, requeuing every delivered message indefinitely.
- Needed answer: The plan should add this check explicitly to the per-connection AMQP setup algorithm (section 5, flow 2, after step 5).

---

### 4) Deterministic Backend Coverage (new/changed behavior only)

- Behavior: `sendCallback` response-body parsing (`src/callback.ts`)
- Scenarios:
  - Given a 2xx response with `{"request_id":"r1","bindings":["connection.r1"]}`, When resolved, Then `callbackResult.requestId === "r1"` and `callbackResult.bindings` equals `["connection.r1"]`. (`__tests__/unit/rabbitmq.test.ts`)
  - Given a 2xx response with empty body or non-JSON, When resolved, Then `success: true`, `requestId` and `bindings` are undefined. (`__tests__/unit/rabbitmq.test.ts`)
  - Given a non-2xx response, When resolved, Then `requestId` and `bindings` are undefined, `success: false`. (`__tests__/unit/rabbitmq.test.ts`)
- Instrumentation: No new log signals; existing callback-success log is preserved.
- Persistence hooks: None (in-memory only).
- Gaps: None. Coverage is explicit. `plan.md:504-511`
- Evidence: `plan.md:504-511`

- Behavior: AMQP connection lifecycle and reconnect (`src/rabbitmq.ts`)
- Scenarios:
  - Given RabbitMQ is unreachable at startup, When gateway starts, Then `[WARN] RabbitMQ not connected` is logged and all SSE connections proceed HTTP-only. (`__tests__/unit/rabbitmq.test.ts` — mock `amqplib.connect` to throw)
  - Given a live connection that drops, When `connection.on('close')` fires, Then `connected = false` and reconnect loop starts. (integration test or unit with mock)
- Instrumentation: `[INFO] RabbitMQ connected`, `[WARN] RabbitMQ connection lost, reconnecting in <n>s` signals planned at `plan.md:413-426`.
- Persistence hooks: None.
- Gaps: No explicit unit test scenario for the reconnect backoff capping at 30 s. The integration test plan (`plan.md:556-561`) covers reconnect from the SSE-client perspective but not the backoff-cap behavior. Minor gap — add a unit test that verifies delay sequence (1 s, 2 s, 4 s, ..., 30 s, 30 s).
- Evidence: `plan.md:259-272, 466-470`

- Behavior: Per-connection AMQP queue setup and teardown (`src/routes/sse.ts`, `src/rabbitmq.ts`)
- Scenarios:
  - Given callback returns `bindings` and RabbitMQ is connected, When buffer flush completes, Then queue `sse.conn.<requestId>` is asserted, bound, and consumer started; `amqpConsumerTag` is set on `ConnectionRecord`. (`__tests__/unit/rabbitmq.test.ts` with mock channel)
  - Given `assertQueue` throws, When setup runs, Then `[WARN]` is logged and connection continues HTTP-only; no crash. (`__tests__/unit/rabbitmq.test.ts`)
  - Given a `ConnectionRecord` with `amqpConsumerTag`, When `handleDisconnect` runs, Then `channel.cancel(tag)` is called. (`__tests__/unit/rabbitmq.test.ts`)
  - Given `handleDisconnect` runs and `getChannel()` returns null, When cancel is attempted, Then no error is thrown. (`__tests__/unit/rabbitmq.test.ts`)
- Instrumentation: `[INFO] AMQP consumer started`, `[INFO] AMQP consumer cancelled` at `plan.md:427-439`.
- Persistence hooks: None (queue persists in RabbitMQ under TTL; gateway does not manage it after disconnect).
- Gaps: The cancel-from-`handleEventAndClose`-write-failure path and cancel-from-`handleServerClose` path are covered by the algorithm descriptions but have no explicit unit-test scenario listed in section 13. Should be added.
- Evidence: `plan.md:521-538`

- Behavior: AMQP message forwarding to SSE stream (`src/rabbitmq.ts`)
- Scenarios: All four scenarios at `plan.md:522-527` cover the happy path, bad JSON, write failure, and unknown consumer tag. All are explicit.
- Instrumentation: `[INFO] AMQP event sent: token=<token> event=<name>` at `plan.md:441-446`.
- Persistence hooks: None.
- Gaps: No scenario for a message where `event` field is missing but `data` is present (partial validity). Low risk given the controlled DA environment but worth a defensive nack-with-log test.
- Evidence: `plan.md:521-529`

- Behavior: Integration — full publish-to-SSE flow
- Scenarios: Full flow, reconnect/drain, routing-key filtering, mixed-mode, HTTP-only fallback all present at `plan.md:548-582`.
- Instrumentation: All log signals are covered.
- Persistence hooks: n/a
- Gaps: The plan notes that the existing `supertest`-based integration test pattern may not stream long enough (`plan.md:553-554`), and recommends `EventSource` or raw TCP. The repo already has `__tests__/utils/sseStreamReader.ts` — the plan should explicitly reference this utility rather than treating it as an open gap.
- Evidence: `plan.md:548-582`

---

### 5) Adversarial Sweep

**Major — Unresolved `data` field type contradiction breaks the DA integration contract**
**Evidence:** `gateway_brief.md:155` — `"data": { ... }` (JSON object); `plan.md:43, 200-206` — plan asserts pre-serialized string; `change_brief.md:34` — "pre-serialized string". The two normative references disagree.
**Why it matters:** If the DA backend publishes `{ "event": "task_update", "data": { "progress": 0.5 } }` (object) and the gateway passes it verbatim to `formatSseEvent`, it will call `.toString()` on the object and clients will receive `[object Object]`. Conversely, if the DA backend publishes a string and the gateway tries to `JSON.stringify` it, clients receive double-encoded JSON. Either error is silent and would produce incorrect output in production.
**Fix suggestion:** Before closing the research log, the plan author must confirm the wire format against the DA publisher implementation (slice 017 backend code). Update section 0 finding 11 and section 3 AMQP message body contract with the confirmed type and add a test case for the other variant (e.g., "given an object `data`, gateway converts to string before forwarding").
**Confidence:** High

**Major — Orphaned consumer when client disconnects during in-flight `channel.consume`**
**Evidence:** `plan.md:397-401` — "The disconnect handler skips AMQP cancel. The just-created consumer (when consume resolves) will immediately find the connection gone; the message handler's token lookup will return null and nack-with-requeue." The plan explicitly leaves the consumer alive.
**Why it matters:** Once `channel.consume` resolves after the disconnect, the consumer exists in RabbitMQ but has no matching `ConnectionRecord`. The reverse Map has no entry for it (it was never inserted). Every message delivered to the queue will be nacked-with-requeue, creating a tight nack loop until the queue TTL fires (default 5 minutes). With prefetch=10, up to 10 messages cycle continuously during that window.
**Fix suggestion:** In the per-connection AMQP setup block in `src/routes/sse.ts`, after `channel.consume` resolves and before setting `record.amqpConsumerTag`, check `getConnection(token)`. If the connection has been removed (disconnect raced), immediately call `channel.cancel(consumerTag)` and return without setting any fields. Add this step to section 5, flow 2, after step 5.
**Confidence:** High

**Major — `channel.on('error')` handler absent from algorithm and file-map**
**Evidence:** `plan.md:621-624` (risks section) — "amqplib channel-level errors (e.g., queue redeclared with different arguments) crash the channel — attach `channel.on('error', ...)` handler." This is listed as a risk/mitigation but never appears in the section 5 algorithm ("AMQP connection and reconnect lifecycle"), the section 2 file map for `src/rabbitmq.ts`, or the test plan.
**Why it matters:** A channel-level error (mismatched queue parameters, consumer tag collision, etc.) closes the amqplib channel silently — the `connection.on('error')` handler does not fire, so the reconnect loop is never triggered. All existing consumers are lost and the `getChannel()` returns a closed channel. The gateway continues running with no indication that AMQP delivery has stopped.
**Fix suggestion:** In section 5 reconnect algorithm step 2, add: "Attach `channel.on('error', handler)` that logs `[ERROR]`, sets `connected = false`, and triggers the same reconnect backoff as `connection.on('error')`." In section 2 `src/rabbitmq.ts` entry, note the channel error handler. Add a unit test: given `channel.emit('error', new Error('PRECONDITION_FAILED'))`, then reconnect is triggered.
**Confidence:** High

**Minor — `setupGracefulShutdown` signature must become async but plan does not specify the change**
**Evidence:** `plan.md:309-319` — `shutdownRabbitMQ()` is `async`; `src/index.ts:56-75` — `shutdown` inner function is currently synchronous and calls `server.close(callback)`.
**Why it matters:** Without `await shutdownRabbitMQ()`, AMQP teardown is fire-and-forget and races with the 10-second forced-exit timer. In practice the AMQP close completes in <1 s, so this rarely causes problems, but it is architecturally incorrect and could leave messages unacked under load.
**Fix suggestion:** In section 2 `src/index.ts` entry, note that `shutdown` becomes `async () => Promise<void>`, `shutdownRabbitMQ()` is awaited before `server.close()`. The process-signal handlers `process.on('SIGTERM', shutdown)` already support async callbacks in Node.js 20.
**Confidence:** High

**Minor — Integration tests reference `EventSource` or raw TCP but `sseStreamReader.ts` already exists**
**Evidence:** `plan.md:553-554` — "Consider using EventSource from eventsource npm package or parsing the raw TCP stream." `__tests__/utils/sseStreamReader.ts` exists in the repo.
**Why it matters:** The plan leaves an artificial open question that is already answered by the existing test infrastructure. This could cause a developer to introduce a new test dependency unnecessarily.
**Fix suggestion:** Replace the gap note with a reference to `__tests__/utils/sseStreamReader.ts` as the streaming client to use for integration tests.
**Confidence:** High

---

### 6) Derived-Value & Persistence Invariants

- Derived value: `amqpConsumerTag` on `ConnectionRecord`
  - Source dataset: Returned by `channel.consume(queueName, handler)` after successful `assertQueue` and `bindQueue`; only populated when `callbackResult.bindings` is non-empty and `getChannel()` is non-null.
  - Write / cleanup triggered: Set synchronously after `channel.consume` resolves; removed when `removeConnection(token)` deletes the entire record. Reverse Map entry must be removed atomically in the same synchronous block.
  - Guards: Queue setup errors skip setting the field; `getConnection(token)` check after `channel.consume` resolves prevents setting on a disconnected record.
  - Invariant: If `amqpConsumerTag` is set on a `ConnectionRecord`, a matching entry exists in the reverse Map with the same tag as key and the same token as value.
  - Evidence: `plan.md:325-330`

- Derived value: `consumerTag → token` reverse Map in `src/rabbitmq.ts`
  - Source dataset: Populated on successful `channel.consume`; keyed by consumer tag string.
  - Write / cleanup triggered: Entry removed on consumer cancel (disconnect, server close, write failure). Entire Map cleared and rebuilt on AMQP reconnect.
  - Guards: On reconnect, rebuild only for connections where `record.amqpQueueName` is set and `getConnection(token)` returns a live record.
  - Invariant: Every entry in the reverse Map has a corresponding live `ConnectionRecord` in `connections` whose `amqpConsumerTag` equals that key. Stale entries (from the orphaned-consumer race) violate this invariant — see Major finding 2.
  - Evidence: `plan.md:332-337`

- Derived value: `connected` boolean in `src/rabbitmq.ts`
  - Source dataset: Set `true` on successful exchange assertion; set `false` on `connection.on('error'|'close')` and on `channel.on('error')` (once fix from finding 3 is applied).
  - Write / cleanup triggered: Controls all AMQP operation gate-checks via `getChannel()`.
  - Guards: Flag read and `channel.consume` call occur in the same async continuation, preventing TOCTOU — valid because Node.js is single-threaded.
  - Invariant: `connected === false` implies `getChannel()` returns `null` and no new AMQP operations are initiated.
  - Evidence: `plan.md:339-344`

- Derived value: Queue name `sse.conn.<request_id>` in RabbitMQ (external state)
  - Source dataset: `callbackResult.requestId` from connect callback response body.
  - Write / cleanup triggered: Queue asserted in RabbitMQ via `assertQueue`; not deleted by gateway. TTL (`x-expires = rabbitmqQueueTtlMs`) drives expiry.
  - Guards: `requestId` must be a non-empty string; absent or empty skips AMQP entirely.
  - Invariant: Queue name is stable across reconnects for the same logical client session. `assertQueue` is idempotent when queue parameters match; a mismatch raises a channel-level error — covered by the `channel.on('error')` fix above.
  - Evidence: `plan.md:346-351`

---

### 7) Risks & Mitigations (top 3)

- Risk: `data` field type contradiction between gateway brief (JSON object) and change brief (pre-serialized string) — if resolved incorrectly, all AMQP-delivered events will be malformed on the client.
- Mitigation: Confirm against DA backend publisher code before implementing the message handler. Update plan section 0 finding 11 and section 3 AMQP message body contract with the confirmed format. Add a unit test covering both cases so a future format change is caught immediately.
- Evidence: `gateway_brief.md:155`; `plan.md:43, 200-206`

- Risk: Channel-level errors silently drop all consumers without triggering the reconnect loop — the gateway appears healthy while delivering no AMQP events.
- Mitigation: Attach `channel.on('error', handler)` that sets `connected = false` and triggers the same reconnect path as `connection.on('error')`. Add this to the algorithm, file map, and test plan. This is the most operationally dangerous gap because it is silent: no log error, no `/readyz` change, just dead delivery.
- Evidence: `plan.md:621-624` (risk listed but not closed); `plan.md:259-272` (algorithm omits channel-error handler)

- Risk: Integration test stream-consumption pattern is left as an open question despite an existing `sseStreamReader.ts` utility.
- Mitigation: Reference `__tests__/utils/sseStreamReader.ts` in the integration test plan at `plan.md:553-554`. Confirm it handles the keep-alive AMQP delivery timing (polling with 2 s timeout as noted at `plan.md:627`).
- Evidence: `plan.md:553-554`; `__tests__/utils/sseStreamReader.ts`

---

### 8) Confidence

Confidence: Medium — The plan is structurally complete and well-grounded in the codebase, but three Major issues (data-type contradiction, orphaned-consumer race, missing channel-error handler) must be resolved before implementation. Once those are addressed, confidence rises to High.
