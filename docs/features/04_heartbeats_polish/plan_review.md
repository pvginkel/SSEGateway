# Plan Review: Heartbeats & Polish

## 1) Summary & Decision

**Readiness**

The updated plan has successfully addressed all three major concerns from the initial review. The plan now includes empirical verification that clearTimeout/clearInterval are interchangeable in Node.js (lines 580-582), explicit clarification of the Express flush mechanism with reference to X-Accel-Buffering header and small-write behavior (lines 243-250), and a concrete logging policy decision to omit routine heartbeat sends to prevent log spam (lines 380-386, 592-595). The plan is comprehensive, technically sound, and demonstrates strong understanding of Node.js timer APIs, SSE specification, and Express streaming behavior. All implementation details are clearly specified with appropriate error handling, test coverage, and observability. The research log shows thorough codebase analysis and the plan correctly identifies that logging and error handling are already complete. The approach is well-structured with clear implementation slices and minimal risk.

**Decision**

GO — All previous concerns resolved with evidence. Plan is complete, implementable, and low-risk. The three previously identified blocking issues (timer API clarity, flush mechanism, logging policy) have been thoroughly addressed with technical evidence and clear decisions.

## 2) Conformance & Fit (with evidence)

**Conformance to refs**

- `CLAUDE.md` "Immediate Flushing: Every SSE write must flush immediately" — Pass — `plan.md:243-250` — Plan explicitly addresses flush mechanism: "Express Response.write() does not buffer small writes. Combined with X-Accel-Buffering: no header (set during connection establishment in sse.ts:144), heartbeat comment is transmitted immediately without explicit flush() call." This correctly identifies that Express doesn't expose flush() method and relies on socket auto-flush for small writes with appropriate headers.

- `CLAUDE.md` "Heartbeat format: `: heartbeat\n`" — Pass — `plan.md:173-177` — "Shape: `: heartbeat\n`" with correct explanation that it's SSE comment syntax (colon, space, text, newline) invisible to EventSource API.

- `CLAUDE.md` "Don't retry failed callbacks - log and move on" — Pass — `plan.md:283-284` — "Heartbeat write failures do not affect connection state (disconnect handled by 'close' event). Failures are logged but do not trigger manual disconnect."

- `product_brief.md:253-256` heartbeat format — Pass — `plan.md:89` — `: heartbeat\n` matches specification exactly.

- `product_brief.md:260-265` heartbeat interval — Pass — `plan.md:203-206` — Uses config.heartbeatIntervalSeconds with validation already in config.ts.

- `product_brief.md:267-272` heartbeat behavior — Pass — `plan.md:196-201` — "Sent for each active SSE connection, Flushed immediately, Not visible to Python" all correctly addressed.

- `change_brief.md:10-15` heartbeat requirements — Pass — `plan.md:85-99` all requirements in scope.

- `change_brief.md:18-23` error handling requirements — Pass — `plan.md:327-367` comprehensive error handling with try-catch, logging, and defensive checks.

**Fit with codebase**

- `src/connections.ts:24` heartbeatTimer field — `plan.md:163-169` — Correctly identifies field already exists as `NodeJS.Timeout | null`, plan only replaces null placeholder with actual timer. No interface changes needed. Perfect fit.

- `src/routes/sse.ts:180-182` timer cleanup — `plan.md:258-266` — Plan identifies existing clearTimeout needs semantic correction to clearInterval, but acknowledges both work correctly (verified in lines 580-582). Good fit with minor semantic improvement.

- `src/routes/internal.ts:195-198` timer cleanup — `plan.md:134-136` — No changes needed, already implements cleanup. Good fit.

- `src/callback.ts:18` DisconnectReason type — `plan.md:137-139` — Already supports "error" reason, no changes needed. Perfect fit.

- `src/sse.ts` formatting utility — `plan.md:141-143` — Correctly identifies heartbeats don't use formatSseEvent(), written directly to stream as comments. Perfect fit.

- Logging infrastructure — `plan.md:30-46` — Research log confirms all logging requirements already satisfied. No changes needed. Perfect fit.

## 3) Open Questions & Ambiguities

No open questions remain. The updated plan has resolved all ambiguities identified in the initial review:

1. **clearTimeout vs clearInterval (RESOLVED)** — Plan now includes empirical test evidence (line 582) that both APIs are interchangeable in Node.js. Semantic preference stated clearly.

2. **Flush mechanism (RESOLVED)** — Plan provides explicit explanation (lines 243-250) of Express write behavior, X-Accel-Buffering header, and socket auto-flush for small writes.

3. **Logging policy (RESOLVED)** — Plan makes concrete decision (lines 380-386, 592-595) to omit routine heartbeat sends, includes quantitative justification (24K lines/hour for 100 connections), and identifies sufficient alternative observability (timer creation logs, write failure logs).

## 4) Deterministic Backend Coverage (new/changed behavior only)

- Behavior: Heartbeat timer creation
- Scenarios:
  - Given successful SSE connection established (connect callback returns 200), When connection is added to Map, Then heartbeat timer is created using setInterval, And timer period is config.heartbeatIntervalSeconds * 1000 milliseconds, And timer ID is stored in ConnectionRecord.heartbeatTimer field (not null), And timer creation is logged with token and interval (`__tests__/integration/heartbeat.test.ts`)
  - Given heartbeat timer is created, When connection exists in Map, Then heartbeatTimer field is not null, And timer fires periodically (`__tests__/integration/heartbeat.test.ts`)
- Instrumentation: Timer creation logged at INFO level with token and interval (line 223)
- Persistence hooks: None (in-memory only, timer cleared on disconnect)
- Gaps: None
- Evidence: `plan.md:468-474`

- Behavior: Heartbeat sending to SSE stream
- Scenarios:
  - Given active SSE connection with heartbeat timer, When timer fires after interval, Then heartbeat comment `: heartbeat\n` is written to response stream, And write is successful (no exception), And heartbeat send is not logged (policy decision) (`__tests__/integration/heartbeat.test.ts`)
  - Given multiple heartbeat intervals pass, When timer fires multiple times, Then each heartbeat is sent independently, And heartbeats appear in SSE stream at regular intervals (`__tests__/integration/heartbeat.test.ts`)
  - Given short heartbeat interval (1 second for testing), When 3 seconds pass, Then at least 2 heartbeats are received by client (accounting for initial delay and timing jitter) (`__tests__/integration/heartbeat.test.ts`)
- Instrumentation: Write failures logged at ERROR level with token and error message (line 388-392). Routine sends not logged (lines 380-386).
- Persistence hooks: None (in-memory stream writes)
- Gaps: None
- Evidence: `plan.md:476-483`

- Behavior: Heartbeat timer cleanup on disconnect
- Scenarios:
  - Given active SSE connection with heartbeat timer, When client disconnects (abort request), Then 'close' event fires, And disconnect handler clears heartbeat timer using clearInterval, And timer no longer fires, And token is removed from Map (`__tests__/integration/heartbeat.test.ts`)
  - Given connection closed via /internal/send with close: true, When server close is triggered, Then heartbeat timer is cleared in handleServerClose, And disconnect callback sent with reason "server_closed" (`__tests__/integration/heartbeat.test.ts`)
  - Given heartbeat write failure triggers error disconnect, When write throws exception, Then disconnect callback sent with reason "error", And timer is cleared during cleanup (`__tests__/integration/heartbeat.test.ts`)
- Instrumentation: Disconnect logs already exist (lines 188, 204 in sse.ts and internal.ts). Optional heartbeat-specific cleanup log mentioned (lines 394-399) but may be omitted as redundant.
- Persistence hooks: None (cleanup of in-memory timer)
- Gaps: None
- Evidence: `plan.md:485-492`

- Behavior: Multiple concurrent connections with independent heartbeats
- Scenarios:
  - Given 10 concurrent SSE connections established, When all connections are active, Then each connection has its own heartbeat timer (10 timers total), And each timer fires independently, And heartbeats are sent to all connections (`__tests__/integration/concurrency.test.ts`)
  - Given multiple connections with different establishment times, When heartbeat intervals pass, Then each connection receives heartbeats at its own cadence (timers not synchronized), And no interference between connections (`__tests__/integration/concurrency.test.ts`)
  - Given one connection closes, When its timer is cleared, Then other connections' timers continue firing, And heartbeats continue on remaining connections (`__tests__/integration/concurrency.test.ts`)
- Instrumentation: Existing connection logs (per-connection logging)
- Persistence hooks: None (independent in-memory timers)
- Gaps: None
- Evidence: `plan.md:494-501`

- Behavior: Heartbeat write failure handling
- Scenarios:
  - Given active connection with heartbeat timer, When response stream is closed (simulate by ending response), And timer fires after close, Then res.write() throws exception, And exception is caught in timer callback, And error is logged with token, And timer continues firing (will be cleared by disconnect handler), And no crash or uncaught exception (`__tests__/integration/heartbeat.test.ts`)
  - Given connection closing during heartbeat write, When write operation is in progress, And 'close' event fires, Then write may fail or succeed (race condition), And disconnect handler clears timer regardless, And cleanup completes successfully (`__tests__/integration/heartbeat.test.ts`)
- Instrumentation: ERROR level logs for write failures (lines 388-392)
- Persistence hooks: None (error handling only, no state changes)
- Gaps: None
- Evidence: `plan.md:503-509`

- Behavior: Full connection lifecycle with heartbeat
- Scenarios:
  - Given client establishes SSE connection, When connect callback succeeds, Then connection is added to Map, And heartbeat timer is created, And client receives heartbeat comments periodically, When Python sends event via /internal/send, Then client receives event (not a heartbeat), When Python sends close: true, Then final event sent (if present), And disconnect callback sent with reason "server_closed", And heartbeat timer cleared, And response stream ended (`__tests__/integration/heartbeat.test.ts` or similar lifecycle test)
  - Given connection with active heartbeats, When multiple events sent between heartbeats, Then events and heartbeats are interleaved in SSE stream, And events use `data:` lines, And heartbeats use `: heartbeat\n` comments (`__tests__/integration/heartbeat.test.ts`)
- Instrumentation: All lifecycle events logged (existing logging infrastructure)
- Persistence hooks: None (in-memory lifecycle)
- Gaps: None
- Evidence: `plan.md:511-517`

- Behavior: Memory cleanup verification (no timer leaks)
- Scenarios:
  - Given 100 connections established and then closed, When all connections disconnect, Then all timers are cleared (100 clearInterval calls), And connections Map is empty, And no active timers remain (check Node.js timer list if possible) (`__tests__/integration/concurrency.test.ts` or dedicated memory test)
  - Given connections established and server shutdown, When server.close() is called, Then all connections terminate, And all timers cleared during disconnect handling, And no timers remain active after shutdown (`__tests__/integration/shutdown.test.ts` or similar)
- Instrumentation: Cleanup logs for each disconnect (existing)
- Persistence hooks: None (verification test only)
- Gaps: Verifying timer cleanup at Node.js runtime level is difficult (plan acknowledges this in line 523-525), relies on clearInterval spy and functional testing. This is acceptable - internal Node.js timer state is not easily inspectable, spy-based verification is industry standard.
- Evidence: `plan.md:519-525`

## 5) Adversarial Sweep (must find ≥3 credible issues or declare why none exist)

After thorough adversarial review, no credible blocking or major issues remain. The updated plan has successfully addressed all concerns from the initial review. Below are the attempted checks and why the plan holds:

- Checks attempted: Timer API correctness (setInterval/clearInterval vs setTimeout/clearTimeout), flush mechanism verification, logging volume impact, race conditions between timer fire and disconnect, timer leak scenarios, write failure propagation, concurrent connection independence, Express stream behavior
- Evidence:
  - Timer API: `plan.md:580-582` provides empirical test evidence that clearTimeout/clearInterval are interchangeable
  - Flush mechanism: `plan.md:243-250` explicitly addresses Express write() behavior and X-Accel-Buffering header
  - Logging volume: `plan.md:592-595` provides quantitative analysis (24K lines/hour for 100 connections) and concrete decision to omit routine heartbeat logs
  - Race conditions: `plan.md:331-343` defensive Map lookup before write handles timer-fire-after-disconnect race
  - Timer leaks: `plan.md:254-266` existing disconnect handlers clear timers on all three disconnect paths
  - Write failures: `plan.md:327-330` try-catch prevents uncaught exceptions, no manual disconnect triggered
  - Concurrent connections: `plan.md:308-321` Node.js event loop serializes per-connection operations, no shared state between connections
  - Express stream behavior: `plan.md:243-250` correct understanding that Express doesn't expose flush() and relies on socket auto-flush
- Why the plan holds:
  1. **Timer management**: Plan uses Node.js standard APIs correctly (setInterval/clearInterval), cleanup happens on all disconnect paths (client_closed, server_closed, error), defensive checks prevent access to stale records
  2. **Flush semantics**: Plan correctly identifies Express streaming behavior, X-Accel-Buffering header prevents NGINX buffering, small writes auto-flush to socket
  3. **Logging policy**: Concrete decision with quantitative justification prevents log spam while maintaining adequate observability through timer creation and error logs
  4. **Error handling**: All write failures caught and logged, no retries (best-effort design), disconnect cleanup happens via 'close' event (no manual triggering)
  5. **Concurrency**: Single-threaded event loop provides automatic serialization per connection, multiple connections' timers are independent
  6. **Testing**: Comprehensive test scenarios cover all behaviors (creation, sending, cleanup, failure, concurrency, lifecycle, memory)

**Minor observations (not blocking):**

1. **Test timing tolerance** — Plan acknowledges (lines 584-587) that integration tests with timers may have jitter. Mitigation is appropriate: short intervals (1 second), approximate counts with tolerance, generous timeouts. This is industry-standard practice for timer-based tests.

2. **Memory leak detection limitation** — Plan acknowledges (lines 523-525) that verifying Node.js internal timer state is difficult. Reliance on clearInterval spy and functional testing (Map.size checks) is appropriate and industry-standard. Production monitoring mentioned as additional safeguard (line 590).

3. **Semantic clarity improvement** — Plan identifies (lines 549-551) that existing code uses clearTimeout but should use clearInterval for semantic correctness. Plan correctly notes this is not a functional bug (both work), but semantic clarity is valuable. Good attention to detail.

All three observations have appropriate mitigations or acknowledgments. None are blocking issues.

## 6) Derived-Value & Persistence Invariants (stacked entries)

- Derived value: Heartbeat timer ID in ConnectionRecord
  - Source dataset: Unfiltered - created by setInterval(), stored in ConnectionRecord.heartbeatTimer
  - Write / cleanup triggered: Set once when connection established (after added to Map), cleared once when connection closes (before removed from Map)
  - Guards: Timer created only after connection added to Map (ensures connection exists when timer fires), timer cleared before Map removal (ensures cleanup happens), defensive check in timer callback verifies connection still in Map before write
  - Invariant: If connection exists in Map, then heartbeatTimer is not null and timer is active. If connection removed from Map, timer is cleared and no longer fires. Timer callback never writes to non-existent connection.
  - Evidence: `plan.md:272-277`
  - Assessment: PASS — Proper guards ensure timer lifecycle matches connection lifecycle. No filtered dataset issues.

- Derived value: Heartbeat write success/failure
  - Source dataset: Filtered - connection.res.write() may fail if stream closed or client slow (backpressure)
  - Write / cleanup triggered: No state changes on failure, error logged only
  - Guards: Try-catch around write operation, failures are expected and acceptable, backpressure (write returns false) distinguished from fatal errors (exception thrown)
  - Invariant: Heartbeat write failures do not affect connection state (disconnect handled by 'close' event). Failures are logged but do not trigger manual disconnect. Best-effort delivery.
  - Evidence: `plan.md:279-284`
  - Assessment: PASS — Filtered source (write can fail) but no persistent writes/cleanup triggered on failure. Guard is try-catch with error logging. Best-effort design is appropriate for keep-alive mechanism. No risk of orphaned state.

- Derived value: Heartbeat interval timing
  - Source dataset: Unfiltered - config.heartbeatIntervalSeconds from environment variable, validated in config.ts
  - Write / cleanup triggered: Used to set setInterval period, no state changes
  - Guards: Validated in config.ts (minimum 1 second, default 15), immutable after config load
  - Invariant: All connections use same heartbeat interval (uniform configuration). Timer fires with approximate accuracy (Node.js event loop may introduce jitter but keeps average rate).
  - Evidence: `plan.md:286-291`
  - Assessment: PASS — Unfiltered immutable config, no writes/cleanup triggered. Guard is config validation.

- Derived value: Connection existence during heartbeat timer callback
  - Source dataset: Filtered - connection may be removed from Map between timer fire and callback execution
  - Write / cleanup triggered: Timer callback checks Map before attempting write (defensive), returns early if connection not found
  - Guards: getConnection(token) returns undefined if connection removed, callback returns early without write, race window is milliseconds (very rare)
  - Invariant: Timer callback never writes to non-existent connection. Defensive check prevents accessing stale ConnectionRecord. No exceptions thrown on race condition.
  - Evidence: `plan.md:293-298`
  - Assessment: PASS — Filtered source (race condition possible) but guard prevents any action on filtered-out connection. No writes/cleanup triggered if connection missing. Defensive programming is appropriate.

**Summary**: All four derived values have appropriate guards. No cases of filtered dataset driving persistent writes/cleanup without guards. Best-effort design for heartbeats means write failures don't trigger state changes, which is correct for keep-alive mechanism.

## 7) Risks & Mitigations (top 3)

- Risk: Test timing flakiness with heartbeat intervals
- Mitigation: Use shorter intervals for tests (1 second instead of 15), use approximate counts with tolerance (e.g., expect at least N heartbeats in T seconds, not exactly N), add generous timeouts for test assertions, accept some jitter in test expectations
- Evidence: `plan.md:584-587` explicitly acknowledges timing challenges and provides concrete mitigations

- Risk: Heartbeat log spam if logged on every send
- Mitigation: DECISION MADE (lines 592-595): OMIT routine heartbeat send logs entirely. Log only: (1) timer creation at INFO level (once per connection), (2) write failures at ERROR level, (3) timer cleanup covered by existing disconnect logs. Quantitative justification: 100 connections = 400 lines/min = 24K lines/hour with default 15s interval. Alternative observability is adequate.
- Evidence: `plan.md:592-595` provides quantitative analysis and concrete decision, `plan.md:380-386` specifies omission in observability section

- Risk: Memory leak from timers if clearInterval not called
- Mitigation: Existing disconnect handlers already clear timers conditionally on all three disconnect paths (client_closed, server_closed, error). Integration test will verify Map is empty after many connect/disconnect cycles. Production memory monitoring recommended. Defensive checks in timer callback prevent stale connection access.
- Evidence: `plan.md:588-590` identifies risk and mitigations, `plan.md:254-266` shows cleanup logic, `plan.md:519-525` includes memory cleanup verification test

## 8) Confidence

Confidence: High — The updated plan has successfully resolved all blocking concerns from the initial review with empirical evidence (clearTimeout/clearInterval test), technical clarification (Express flush mechanism with X-Accel-Buffering), and concrete decision with quantitative justification (logging policy). The plan demonstrates thorough understanding of Node.js timer APIs, SSE specification, Express streaming behavior, and production observability concerns. Implementation is straightforward (create setInterval timer, write SSE comment, handle errors), all infrastructure already exists (ConnectionRecord field, disconnect handlers, logging), and comprehensive test coverage is planned. Risk is minimal - heartbeats are additive feature with no changes to existing logic except storing non-null timer instead of null placeholder. Research log shows exhaustive codebase analysis. All six implementation slices are well-defined with clear dependencies.

---

## Final Assessment

**PREVIOUS REVIEW CONCERNS - ALL RESOLVED:**

1. **Major: clearTimeout vs clearInterval ambiguity** — RESOLVED with empirical test evidence (line 582) showing both APIs work interchangeably in Node.js, plus clear semantic preference for clearInterval
2. **Major: Flush mechanism undefined** — RESOLVED with explicit explanation (lines 243-250) of Express write() behavior, X-Accel-Buffering header, and socket auto-flush for small writes
3. **Major: Logging policy decision needed** — RESOLVED with concrete decision (lines 380-386, 592-595) to omit routine heartbeat sends, quantitative justification (24K lines/hour), and identification of sufficient alternative observability

**STRENGTHS:**

- Comprehensive research log with thorough codebase analysis (lines 3-62)
- All existing infrastructure identified correctly (ConnectionRecord field exists, cleanup logic exists, logging complete)
- Clear understanding that only heartbeat logic needs implementation - no interface changes needed
- Excellent error handling with try-catch, defensive checks, and best-effort design
- Comprehensive test coverage across 7 distinct test scenarios (timing, concurrency, lifecycle, failure, memory)
- Well-structured implementation slices with clear dependencies
- Proper risk identification with concrete mitigations
- Correct understanding of Node.js event loop serialization and timer APIs
- Appropriate logging policy with quantitative analysis

**RECOMMENDATION: GO**

The plan is ready for implementation. All technical concerns have been addressed with evidence. The implementation is low-risk, well-tested, and fits cleanly into the existing architecture.
