# Implementation Plan: Heartbeats & Polish

## 0) Research Log & Findings

**Codebase Structure Analysis:**
- SSE connect flow fully implemented in `src/routes/sse.ts` with connection lifecycle management
- Send/close operations fully implemented in `src/routes/internal.ts` with SSE event formatting
- Connection state management in `src/connections.ts` with ConnectionRecord including `heartbeatTimer` field (currently null)
- Callback infrastructure in `src/callback.ts` supports all three disconnect reasons: "client_closed", "server_closed", "error"
- SSE event formatting utility in `src/sse.ts` follows full SSE specification
- Logger in `src/logger.ts` provides plain text logging with [INFO] and [ERROR] severity prefixes
- Configuration in `src/config.ts` includes `heartbeatIntervalSeconds` (default: 15 seconds)
- Integration test infrastructure exists with MockServer utility for callback testing

**Heartbeat Implementation Requirements:**
- Heartbeats use SSE comment format: `: heartbeat\n` (line starts with colon, followed by space and text)
- Must flush immediately after writing heartbeat (same as events)
- Timer created when connection is established (after successful connect callback)
- Timer stored in ConnectionRecord.heartbeatTimer field (currently null placeholder)
- Timer cleared when connection is disconnected (already implemented in disconnect handlers)
- Heartbeats are invisible to Python backend (no callback, purely internal)
- Interval controlled by config.heartbeatIntervalSeconds

**Current Disconnect Handling:**
- `src/routes/sse.ts:169-210` - handleDisconnect() for client-initiated disconnect with reason "client_closed"
- `src/routes/internal.ts:185-216` - handleServerClose() for server-initiated close with reason "server_closed"
- `src/routes/internal.ts:139-161` - Write failure handling with disconnect callback reason "error"
- All three handlers already clear heartbeatTimer with conditional check: `if (connection.heartbeatTimer) clearTimeout(connection.heartbeatTimer)`

**Logging Coverage Audit:**
- Server startup: `src/index.ts` logs startup with port and environment config - COMPLETE
- New connections: `src/routes/sse.ts:76` logs with token and URL - COMPLETE
- Connect callback results: `src/callback.ts:147-152` logs success/failure - COMPLETE
- Event sends: `src/routes/internal.ts:136-138` logs with token, event name, data length - COMPLETE
- Connection closes: `src/routes/sse.ts:188` and `src/routes/internal.ts:204` log closes - COMPLETE
- Errors: Logged throughout with [ERROR] prefix - COMPLETE
- FINDING: All logging requirements from product_brief.md are already satisfied

**Error Handling Audit:**
- Connect callback failures: Properly logged and handled with appropriate status codes - COMPLETE
- Write failures: Caught, logged, trigger disconnect with reason "error" - COMPLETE
- Disconnect callback failures: Logged only, no retries (best-effort) - COMPLETE
- Invalid /internal/send requests: Return 400 with validation errors logged - COMPLETE
- Unknown tokens: Return 404 with info log - COMPLETE
- FINDING: All error paths are already handled gracefully

**Integration Testing:**
- Existing tests cover: connect flow, callback rejection, client disconnect, event sending, server close
- FINDING: Need to add heartbeat-specific tests and multi-connection concurrency tests
- Test utilities available: MockServer for callback testing, SSE stream parsing

**Key Architectural Findings:**
- Node.js setInterval is preferred over recursive setTimeout for periodic tasks
- Response write operations can throw if stream is closed
- Heartbeat timer must be created AFTER connection is added to Map (not during preliminary record)
- Heartbeat writes should catch errors (connection may close between timer fire and write)
- Express response object provides write() method for SSE output

**Conflicts & Resolutions:**
- No conflicts identified - heartbeat implementation fits cleanly into existing architecture
- Heartbeat timer field already exists in ConnectionRecord interface
- All disconnect handlers already have timer cleanup code (conditional on non-null)
- Only change needed: implement actual heartbeat logic instead of null placeholder

---

## 1) Intent & Scope

**User intent**

Implement the periodic heartbeat system for active SSE connections to keep long-lived connections alive, and finalize the SSEGateway service by completing error handling polish, verifying logging coverage, and adding comprehensive integration tests for end-to-end functionality including concurrent connections.

**Prompt quotes**

"Send heartbeat comment for each active SSE connection: `: heartbeat\n`"

"Use interval from `HEARTBEAT_INTERVAL_SECONDS` environment variable (default: 15 seconds)"

"Create timer when connection is established, Store timer in ConnectionRecord, Clear timer when connection is disconnected"

"Complete logging coverage: Server startup, New connections, Callback results, Event sends, Connection closes, All errors"

"Create integration tests: Full connection lifecycle, Multiple concurrent connections, Heartbeat timing verification"

**In scope**

- Implementing heartbeat sending logic in `src/routes/sse.ts` after successful connection establishment
- Creating heartbeat timer using setInterval with config.heartbeatIntervalSeconds
- Writing heartbeat comments to SSE stream: `: heartbeat\n`
- Flushing immediately after heartbeat write
- Handling heartbeat write failures gracefully (connection may be closing)
- Storing timer in ConnectionRecord.heartbeatTimer field (replaces null placeholder)
- Integration tests for heartbeat timing and delivery
- Integration tests for multiple concurrent connections with heartbeats
- Integration tests for full connection lifecycle (connect → event → heartbeat → close)
- Integration tests for memory cleanup verification (no timer leaks)
- Documenting that all logging requirements are satisfied (already complete in codebase)
- Documenting that all error handling is complete (already complete in codebase)

**Out of scope**

- Modifying existing disconnect handlers (already correctly clear timers)
- Modifying callback infrastructure (already supports all disconnect reasons)
- Modifying SSE event formatting (heartbeats are comments, not events)
- Modifying logging infrastructure (already complete and satisfies all requirements)
- Adding new error handling paths (existing error handling is comprehensive)
- Heartbeat customization per connection (uniform interval for all connections)
- Heartbeat acknowledgment from clients (one-way, no response expected)

**Assumptions / constraints**

- config.heartbeatIntervalSeconds is configured and valid (validated in config.ts)
- Heartbeat writes to response stream can fail if connection closes between timer fire and write
- setInterval is appropriate for periodic heartbeat task (Node.js standard)
- Heartbeat timer cleanup is idempotent (clearInterval on null or undefined is safe)
- Response.write() is synchronous or throws synchronously on failure
- X-Accel-Buffering: no header ensures heartbeats reach client immediately
- Multiple connections operate independently (each has own timer)
- Timer IDs are unique per connection (Node.js guarantees this)

---

## 2) Affected Areas & File Map

- Area: `src/routes/sse.ts` (modification)
- Why: Add heartbeat timer creation and sending logic after successful connection establishment
- Evidence: `src/routes/sse.ts:151-153` - connection added to Map after callback succeeds, this is where timer should be created

- Area: `src/connections.ts` (no changes)
- Why: ConnectionRecord interface already has heartbeatTimer field with correct type (NodeJS.Timeout | null)
- Evidence: `src/connections.ts:24` - heartbeatTimer field already defined

- Area: `src/routes/internal.ts` (no changes)
- Why: handleServerClose() already clears heartbeat timer correctly
- Evidence: `src/routes/internal.ts:195-198` - conditional clearTimeout already implemented

- Area: `src/callback.ts` (no changes)
- Why: Already supports "error" disconnect reason, no changes needed
- Evidence: `src/callback.ts:18` - DisconnectReason type includes "error"

- Area: `src/sse.ts` (no changes)
- Why: Heartbeats are SSE comments (`: heartbeat\n`), not events - no formatting utility needed
- Evidence: Heartbeats don't use formatSseEvent(), written directly to stream

- Area: `__tests__/integration/heartbeat.test.ts` (new file)
- Why: Integration tests for heartbeat functionality including timing, multi-connection, and cleanup
- Evidence: New file - change_brief.md line 35 "Full connection lifecycle (connect → send event → heartbeat → close)"

- Area: `__tests__/integration/concurrency.test.ts` (new file)
- Why: Integration tests for multiple concurrent connections with independent heartbeats
- Evidence: New file - change_brief.md line 36 "Multiple concurrent connections"

- Area: `__tests__/utils/sseStreamReader.ts` (new file)
- Why: Utility to capture and parse SSE stream output including comments (heartbeats) for testing
- Evidence: New file - needed to verify heartbeat comments are received by client

---

## 3) Data Model / Contracts

- Entity / contract: ConnectionRecord.heartbeatTimer
- Shape:
```typescript
interface ConnectionRecord {
  heartbeatTimer: NodeJS.Timeout | null;  // Changed from always-null to actual timer
}
```
- Refactor strategy: Replace null placeholder with actual setInterval timer ID. No interface changes needed - type already supports NodeJS.Timeout. All cleanup code already handles both null and non-null cases with conditional check.
- Evidence: `src/connections.ts:24` already defines field as `NodeJS.Timeout | null`

- Entity / contract: Heartbeat SSE comment format
- Shape:
```
: heartbeat\n
```
- Refactor strategy: New wire format. Single line starting with colon (SSE comment syntax), followed by space and text "heartbeat", ending with newline. Not visible to EventSource API (comments are filtered out), purely for keep-alive.
- Evidence: product_brief.md:253-256 defines heartbeat format, change_brief.md:10 specifies exact format

- Entity / contract: No callback payload changes
- Shape: Existing ConnectCallbackPayload and DisconnectCallbackPayload remain unchanged
- Refactor strategy: Heartbeats are internal only - no Python backend notification. Disconnect callback already supports "error" reason for write failures.
- Evidence: change_brief.md:16 "Heartbeats are not visible to Python (no callback)"

---

## 4) API / Integration Surface

- Surface: No new API endpoints
- Inputs: N/A
- Outputs: N/A
- Errors: N/A
- Evidence: Heartbeats are internal implementation detail, no external API changes

- Surface: SSE stream output (modified - adds heartbeat comments)
- Inputs: N/A (timer-driven, not request-driven)
- Outputs: SSE comment lines written to active connection streams: `: heartbeat\n`
- Errors:
  - Write failure (connection closed) → caught and ignored (connection cleanup handled by disconnect handler)
  - Timer continues to fire after disconnect → prevented by clearInterval in disconnect handlers
- Evidence: product_brief.md:267-272 "Behaviour: Sent for each active SSE connection, Flushed immediately, Not visible to Python"

- Surface: Configuration (existing - no changes)
- Inputs: HEARTBEAT_INTERVAL_SECONDS environment variable (default: 15, validated in config.ts)
- Outputs: Used to set setInterval period for heartbeat timers
- Errors: Invalid values already logged and defaulted to 15 in config.ts
- Evidence: `src/config.ts:42-52` validates heartbeat interval

---

## 5) Algorithms & State Machines

- Flow: Heartbeat Timer Creation
- Steps:
  1. Connection successfully established (connect callback returned 2xx, disconnected flag is false)
  2. SSE headers set and response status sent (stream is open)
  3. Connection added to Map with token as key
  4. Create heartbeat timer using setInterval with callback that sends heartbeat comment
  5. Interval period: `config.heartbeatIntervalSeconds * 1000` milliseconds
  6. Timer callback: write `: heartbeat\n` to connection.res, wrap in try-catch to handle write failures
  7. If write succeeds: do not log (routine sends omitted to prevent log spam)
  8. If write fails: log error at ERROR level, do nothing else (disconnect handler will clean up when 'close' event fires)
  9. Store timer ID in connection.heartbeatTimer field (replaces null)
  10. Log heartbeat timer creation with token and interval at INFO level
- States / transitions: Timer state: not-created → active → cleared. Timer cleared on disconnect by existing handlers.
- Hotspots:
  - setInterval continues firing until explicitly cleared (must ensure clearInterval called on all disconnect paths)
  - Write failures can occur if connection closes between timer fire and write (must catch exceptions)
  - Multiple connections each have independent timers (no coordination needed)
  - Timer fires on interval regardless of other activity (independent of event sends)
- Evidence: product_brief.md:250-272 heartbeat behavior, change_brief.md:13-15 timer lifecycle

- Flow: Heartbeat Send Operation
- Steps:
  1. setInterval timer fires (every config.heartbeatIntervalSeconds seconds)
  2. Callback closure has access to token and ConnectionRecord
  3. Check if connection still exists in Map (defensive - should always exist if timer is active)
  4. If connection not in Map: return early (shouldn't happen - timer should be cleared on disconnect)
  5. If connection exists: try to write heartbeat comment
  6. Format: `: heartbeat\n` (single line)
  7. Call connection.res.write(': heartbeat\n')
  8. Write may return false (backpressure) or throw (stream closed)
  9. If write returns false: log INFO level backpressure message but continue (heartbeat is best-effort, client will catch up or disconnect)
  10. Flushing: Express Response.write() does not buffer small writes. Combined with X-Accel-Buffering: no header (set during connection establishment in sse.ts:144), heartbeat comment is transmitted immediately without explicit flush() call. Express Response doesn't expose flush() method - relies on Node.js socket auto-flush for small writes.
  11. Catch any exceptions from write: log error at ERROR level, do not call disconnect handler (let 'close' event handle cleanup)
- States / transitions: No state changes - read-only operation that writes to stream
- Hotspots:
  - write() can throw if stream closed (must catch)
  - Timer callback must not throw uncaught exceptions (could crash Node process)
  - Heartbeat send is best-effort (failures are acceptable)
  - No need to flush explicitly if X-Accel-Buffering is set (but doesn't hurt)
- Evidence: CLAUDE.md line 49 "Immediate Flushing: Every SSE write must flush immediately", product_brief.md:270 "Flushed immediately"

- Flow: Heartbeat Timer Cleanup (no changes to existing logic)
- Steps:
  1. Connection disconnect detected (client close, server close, or error)
  2. Disconnect handler retrieves ConnectionRecord from Map
  3. Check if heartbeatTimer is not null: `if (connection.heartbeatTimer) clearInterval(connection.heartbeatTimer)`
  4. Clear timer using clearInterval (not clearTimeout - setInterval uses clearInterval)
  5. Remove connection from Map
  6. Continue with rest of disconnect handling (callback, logging)
- States / transitions: Timer cleared atomically before Map removal
- Hotspots:
  - clearInterval must use timer ID from ConnectionRecord (not token)
  - clearInterval on null/undefined is safe (no-op) but conditional check is clearer
  - Timer cleanup must happen before Map removal to prevent race condition
- Evidence: Existing code in `src/routes/sse.ts:180-182` and `src/routes/internal.ts:195-198` already implements cleanup correctly (but uses clearTimeout - needs correction to clearInterval)

---

## 6) Derived State & Invariants

- Derived value: Heartbeat timer ID in ConnectionRecord
  - Source: Unfiltered - created by setInterval(), stored in ConnectionRecord.heartbeatTimer
  - Writes / cleanup: Set once when connection established, cleared once when connection closes
  - Guards: Timer created only after connection added to Map (ensures connection exists), timer cleared before Map removal (ensures cleanup happens)
  - Invariant: If connection exists in Map, then heartbeatTimer is not null and timer is active. If connection removed from Map, timer is cleared and no longer fires.
  - Evidence: `src/connections.ts:24` heartbeatTimer field, product_brief.md:321-322 ConnectionRecord structure

- Derived value: Heartbeat write success/failure
  - Source: Filtered - connection.res.write() may fail if stream closed or client slow
  - Writes / cleanup: No state changes on failure, error logged only
  - Guards: Try-catch around write operation, failures are expected and acceptable
  - Invariant: Heartbeat write failures do not affect connection state (disconnect handled by 'close' event). Failures are logged but do not trigger manual disconnect.
  - Evidence: change_brief.md:18-23 error handling requirements, CLAUDE.md line 110 "Don't retry failed callbacks - log and move on"

- Derived value: Heartbeat interval timing
  - Source: Unfiltered - config.heartbeatIntervalSeconds from environment variable
  - Writes / cleanup: Used to set setInterval period, no state changes
  - Guards: Validated in config.ts (minimum 1 second, default 15), immutable after config load
  - Invariant: All connections use same heartbeat interval (uniform configuration). Timer fires with approximate accuracy (Node.js event loop may introduce jitter but keeps average rate).
  - Evidence: `src/config.ts:42-52` validation, product_brief.md:260-265 heartbeat interval

- Derived value: Connection existence during heartbeat timer callback
  - Source: Filtered - connection may be removed from Map between timer fire and callback execution
  - Writes / cleanup: Timer callback checks Map before attempting write (defensive)
  - Guards: getConnection(token) returns undefined if connection removed, callback returns early
  - Invariant: Timer callback never writes to non-existent connection. Defensive check prevents accessing stale ConnectionRecord.
  - Evidence: Race condition possible if disconnect happens between timer fire and callback execution (milliseconds), defensive check required

---

## 7) Consistency, Transactions & Concurrency

- Transaction scope: No database transactions. Heartbeat operations are in-memory writes to response streams. Timer creation and cleanup are synchronous JavaScript operations.
- Atomic requirements:
  - Timer creation must happen after connection added to Map (ensures connection exists when timer fires)
  - Timer cleanup must happen before connection removed from Map (ensures timer cleared before disconnect callback)
  - Heartbeat write and error handling must be atomic (try-catch ensures exceptions don't propagate)
  - Multiple connections' heartbeats are independent (no coordination required)
- Retry / idempotency:
  - No retries for heartbeat write failures (best-effort design)
  - Timer continues firing until explicitly cleared (no automatic retry of failed writes)
  - clearInterval is idempotent (calling multiple times has no effect after first clear)
  - Timer callback checks Map before writing (idempotent against race conditions)
- Ordering / concurrency controls:
  - Node.js event loop serializes timer callbacks (no concurrent execution per connection)
  - Multiple connections' timers fire independently (may interleave but no shared state)
  - setInterval uses Node.js timer queue (precise ordering not guaranteed but approximate rate maintained)
  - No locks needed due to single-threaded event loop
  - Write operations to different connections can interleave (each has own response stream)
- Evidence: CLAUDE.md line 45 "Event Loop Ordering: All events for a token are automatically serialized", product_brief.md:268 "Sent for each active SSE connection"

---

## 8) Errors & Edge Cases

- Failure: Heartbeat write throws exception (stream closed or broken)
- Surface: setInterval timer callback in connection establishment code
- Handling: Catch exception in timer callback, log error with token and error message (ERROR level), do not call disconnect handler (let 'close' event handle cleanup naturally), timer continues firing (will be cleared by disconnect handler when 'close' fires)
- Guardrails: Try-catch wraps res.write() call, exception never propagates to timer system (would crash Node), defensive check for connection existence before write
- Evidence: change_brief.md:18-21 "Catch and log all gateway errors, Close connections on error if applicable"

- Failure: Timer callback executes after connection removed from Map (race condition)
- Surface: Heartbeat timer callback
- Handling: Check if getConnection(token) returns undefined, if so return early from callback without attempting write, log warning (INFO level - expected race condition), timer will be cleared by disconnect handler after callback returns
- Guardrails: Defensive Map lookup before write, early return prevents accessing stale ConnectionRecord, race window is milliseconds (very rare)
- Evidence: Race condition possible between timer fire and disconnect handler execution

- Failure: setInterval fails to create timer (resource exhaustion, highly unlikely)
- Surface: Timer creation in connection establishment
- Handling: setInterval returns undefined or throws (very rare), if happens log error, connection remains open without heartbeat (degraded but functional), no disconnect triggered
- Guardrails: Check if timer creation succeeds, store null if fails (safe - disconnect handlers check for null)
- Evidence: setInterval failure is extremely rare but possible under resource pressure

- Failure: Heartbeat write returns false (backpressure from slow client)
- Surface: connection.res.write() return value in timer callback
- Handling: Log INFO message about backpressure but continue (heartbeat is best-effort), do not treat as error or close connection, client will catch up when ready or disconnect if too slow
- Guardrails: Check write() return value, distinguish between false (backpressure) and exception (stream closed), backpressure is expected behavior
- Evidence: Node.js Writable stream write() returns false when buffer is full but doesn't indicate fatal error

- Failure: Config heartbeat interval is too short (1 second minimum enforced)
- Surface: config.ts validation during server startup
- Handling: Already handled - config.ts validates minimum 1 second, logs error and uses default 15 if invalid
- Guardrails: Validation prevents absurdly high frequency heartbeats (would spam logs and consume CPU)
- Evidence: `src/config.ts:47` validates heartbeat interval >= 1

- Failure: clearInterval called with null (timer was never created or already cleared)
- Surface: Disconnect handlers in sse.ts and internal.ts
- Handling: clearInterval(null) is safe no-op in Node.js, but existing code uses conditional check `if (timer)` which is clearer, no changes needed to existing code
- Guardrails: Conditional check before clearInterval, defensive programming
- Evidence: Existing disconnect handlers already implement conditional clear

- Failure: Connection closes between timer creation and first heartbeat fire
- Surface: Race condition during connection establishment cleanup
- Handling: Timer created and stored in Map, 'close' event fires immediately, disconnect handler clears timer before first heartbeat fires, no heartbeat sent (normal case)
- Guardrails: Timer cleared in disconnect handler regardless of whether any heartbeats were sent, no resource leak
- Evidence: Disconnect handler clears timer unconditionally (if not null)

---

## 9) Observability / Telemetry

- Signal: Heartbeat timer creation log
- Type: Structured log message (plain text, INFO level)
- Trigger: When heartbeat timer is created after successful connection establishment
- Labels / fields: token (UUID), interval (seconds), url (for context)
- Consumer: Log aggregation, debugging heartbeat setup issues
- Evidence: New log line, helps verify heartbeat system is active

- Signal: Heartbeat send log (OMITTED to avoid log spam)
- Type: N/A - heartbeat sends are not logged at INFO level
- Trigger: N/A
- Labels / fields: N/A
- Consumer: Not applicable - heartbeat timer creation and write failures provide sufficient debugging information
- Evidence: Decision: OMIT routine heartbeat send logs to prevent log spam. With default 15s interval and 100 connections, logging every heartbeat would generate 400 lines/minute (24K lines/hour). Timer creation log (once per connection) and write failure logs (ERROR level) provide adequate observability.

- Signal: Heartbeat write failure log
- Type: Structured log message (plain text, ERROR level)
- Trigger: When connection.res.write() throws exception during heartbeat send
- Labels / fields: token, error message, url
- Consumer: Error alerting, debugging connection issues, distinguishing from normal disconnect
- Evidence: New log line, helps identify write failures vs normal closes

- Signal: Heartbeat timer cleanup log (optional)
- Type: Structured log message (plain text, INFO level)
- Trigger: When clearInterval is called during disconnect (optional - may be omitted as cleanup is logged elsewhere)
- Labels / fields: token
- Consumer: Debugging timer cleanup, verifying no leaks
- Evidence: Optional - disconnect handlers already log cleanup, heartbeat-specific log may be redundant

- Signal: Existing logging (no changes needed)
- Type: All existing logging requirements from product_brief.md are satisfied
- Trigger: Various (startup, connections, callbacks, events, closes, errors)
- Labels / fields: Varies by log type
- Consumer: Production monitoring, debugging
- Evidence: Codebase audit confirmed all product_brief.md logging requirements are implemented: server startup (`src/index.ts`), connections (`src/routes/sse.ts:76`), callbacks (`src/callback.ts:147-152`), events (`src/routes/internal.ts:136-138`), closes (`src/routes/sse.ts:188`, `src/routes/internal.ts:204`), errors (throughout codebase)

---

## 10) Background Work & Shutdown

- Worker / job: Heartbeat timer per connection
- Trigger cadence: Periodic - fires every config.heartbeatIntervalSeconds seconds for each active connection
- Responsibilities: Write heartbeat comment to SSE stream, catch write failures, log errors, maintain connection keep-alive
- Shutdown handling: During graceful shutdown (SIGTERM/SIGINT), existing shutdown handler in index.ts calls server.close() which terminates all SSE connections. Each terminated connection triggers 'close' event. Disconnect handler clears heartbeat timer using clearInterval before removing from Map. All timers cleaned up automatically as part of connection cleanup.
- Evidence: `src/index.ts:56-75` existing shutdown handler, product_brief.md:301-305 restart behavior, timers cleared in disconnect handlers

- Worker / job: No new background workers
- Trigger cadence: N/A
- Responsibilities: Heartbeat is the only periodic task, implemented as per-connection setInterval timer
- Shutdown handling: Timer cleanup is part of connection cleanup (no separate shutdown logic needed)
- Evidence: Single-process, single-threaded architecture per CLAUDE.md line 38

---

## 11) Security & Permissions

- Concern: Heartbeat data leakage
- Touchpoints: SSE stream writes
- Mitigation: Heartbeats are SSE comments (`: heartbeat\n`) which are invisible to EventSource API (browser automatically filters out comments). No sensitive data included in heartbeat. Static text only.
- Residual risk: None - heartbeats contain no user data or connection metadata
- Evidence: product_brief.md:253-256 heartbeat format, SSE spec defines comments are invisible to JavaScript

- Concern: Heartbeat frequency DoS
- Touchpoints: config.heartbeatIntervalSeconds validation
- Mitigation: Minimum interval enforced in config.ts (1 second). Default is 15 seconds which is reasonable for keep-alive. Prevents configuration of absurdly high frequency (e.g., every millisecond).
- Residual risk: Low - even 1 second interval is acceptable for SSE keep-alive, high enough frequency to prevent timeouts but low enough to avoid spam
- Evidence: `src/config.ts:47` validates minimum 1 second

- Concern: Timer resource exhaustion (many connections)
- Touchpoints: Timer creation for each connection
- Mitigation: Node.js can handle thousands of timers efficiently. Each timer has minimal overhead. Single-instance deployment limits total connections. If resource limits reached, connection establishment will fail at OS level (file descriptor limits) before timer limits.
- Residual risk: Low - timer overhead is negligible compared to connection overhead
- Evidence: product_brief.md:69-73 "Thousands of concurrent SSE connections" is target load

- Concern: No additional security concerns
- Touchpoints: N/A
- Mitigation: Heartbeats are internal keep-alive mechanism, no external API changes, no new attack surface
- Residual risk: None
- Evidence: Feature is purely internal implementation detail

---

## 12) UX / UI Impact

Not applicable - this is a backend service with no user interface. Heartbeats are invisible to clients using EventSource API (SSE comments are filtered out by browser).

Operational experience considerations:
- SSE connections stay alive longer (prevent proxy timeouts, network NAT timeouts)
- Improved reliability for long-lived connections (clients don't need to reconnect as often)
- Connection health is maintained proactively (network equipment sees activity, keeps connection open)
- No visible impact to client applications (heartbeats are comments, not events)

---

## 13) Deterministic Test Plan

- Surface: Heartbeat timer creation and storage
- Scenarios:
  - Given successful SSE connection established (connect callback returns 200), When connection is added to Map, Then heartbeat timer is created using setInterval, And timer period is config.heartbeatIntervalSeconds * 1000 milliseconds, And timer ID is stored in ConnectionRecord.heartbeatTimer field (not null), And timer creation is logged with token and interval
  - Given heartbeat timer is created, When connection exists in Map, Then heartbeatTimer field is not null, And timer fires periodically
- Fixtures / hooks: Spy on setInterval to capture timer creation, verify timer ID is stored in ConnectionRecord, use short interval (1 second) for faster tests
- Gaps: None
- Evidence: change_brief.md:13-14 "Create timer when connection is established, Store timer in ConnectionRecord"

- Surface: Heartbeat sending to SSE stream
- Scenarios:
  - Given active SSE connection with heartbeat timer, When timer fires after interval, Then heartbeat comment `: heartbeat\n` is written to response stream, And write is successful (no exception), And heartbeat send is optionally logged
  - Given multiple heartbeat intervals pass, When timer fires multiple times, Then each heartbeat is sent independently, And heartbeats appear in SSE stream at regular intervals
  - Given short heartbeat interval (1 second for testing), When 3 seconds pass, Then at least 2 heartbeats are received by client (accounting for initial delay and timing jitter)
- Fixtures / hooks: Use sseStreamReader utility to capture SSE output including comments, set config.heartbeatIntervalSeconds to 1 for faster tests, verify heartbeat comments appear in stream, count heartbeats over time period
- Gaps: Precise timing is difficult to test (Node.js timer jitter) - use approximate counts with tolerance
- Evidence: change_brief.md:10-12 "Send heartbeat comment for each active SSE connection: `: heartbeat\n`, Use interval from HEARTBEAT_INTERVAL_SECONDS, Flush immediately after writing heartbeat"

- Surface: Heartbeat timer cleanup on disconnect
- Scenarios:
  - Given active SSE connection with heartbeat timer, When client disconnects (abort request), Then 'close' event fires, And disconnect handler clears heartbeat timer using clearInterval, And timer no longer fires, And token is removed from Map
  - Given connection closed via /internal/send with close: true, When server close is triggered, Then heartbeat timer is cleared in handleServerClose, And disconnect callback sent with reason "server_closed"
  - Given heartbeat write failure triggers error disconnect, When write throws exception, Then disconnect callback sent with reason "error", And timer is cleared during cleanup
- Fixtures / hooks: Spy on clearInterval to verify timer cleanup, wait after disconnect to verify no more heartbeats sent, verify Map.has(token) returns false after cleanup
- Gaps: None - existing disconnect handlers already tested, just verify timer cleanup happens
- Evidence: change_brief.md:15 "Clear timer when connection is disconnected"

- Surface: Multiple concurrent connections with independent heartbeats
- Scenarios:
  - Given 10 concurrent SSE connections established, When all connections are active, Then each connection has its own heartbeat timer (10 timers total), And each timer fires independently, And heartbeats are sent to all connections
  - Given multiple connections with different establishment times, When heartbeat intervals pass, Then each connection receives heartbeats at its own cadence (timers not synchronized), And no interference between connections
  - Given one connection closes, When its timer is cleared, Then other connections' timers continue firing, And heartbeats continue on remaining connections
- Fixtures / hooks: Create 10 connections in parallel, verify each has non-null timer in Map, capture heartbeats from multiple streams simultaneously, verify independent timing
- Gaps: None
- Evidence: change_brief.md:36 "Multiple concurrent connections"

- Surface: Heartbeat write failure handling
- Scenarios:
  - Given active connection with heartbeat timer, When response stream is closed (simulate by ending response), And timer fires after close, Then res.write() throws exception, And exception is caught in timer callback, And error is logged with token, And timer continues firing (will be cleared by disconnect handler), And no crash or uncaught exception
  - Given connection closing during heartbeat write, When write operation is in progress, And 'close' event fires, Then write may fail or succeed (race condition), And disconnect handler clears timer regardless, And cleanup completes successfully
- Fixtures / hooks: Mock or end response stream before timer fires, spy on logger.error to verify error logged, verify process doesn't crash, verify timer cleanup happens
- Gaps: Simulating exact timing of write failure vs close event is difficult - use mocked response or closed stream
- Evidence: change_brief.md:18-21 "Catch and log all gateway errors, Close connections on error if applicable"

- Surface: Full connection lifecycle with heartbeat
- Scenarios:
  - Given client establishes SSE connection, When connect callback succeeds, Then connection is added to Map, And heartbeat timer is created, And client receives heartbeat comments periodically, When Python sends event via /internal/send, Then client receives event (not a heartbeat), When Python sends close: true, Then final event sent (if present), And disconnect callback sent with reason "server_closed", And heartbeat timer cleared, And response stream ended
  - Given connection with active heartbeats, When multiple events sent between heartbeats, Then events and heartbeats are interleaved in SSE stream, And events use `data:` lines, And heartbeats use `: heartbeat\n` comments
- Fixtures / hooks: End-to-end test using supertest for SSE connection and /internal/send requests, sseStreamReader to capture full stream output, verify order and format of events vs heartbeats
- Gaps: None - comprehensive lifecycle test
- Evidence: change_brief.md:35 "Full connection lifecycle (connect → send event → heartbeat → close)"

- Surface: Memory cleanup verification (no timer leaks)
- Scenarios:
  - Given 100 connections established and then closed, When all connections disconnect, Then all timers are cleared (100 clearInterval calls), And connections Map is empty, And no active timers remain (check Node.js timer list if possible)
  - Given connections established and server shutdown, When server.close() is called, Then all connections terminate, And all timers cleared during disconnect handling, And no timers remain active after shutdown
- Fixtures / hooks: Create and close many connections in loop, spy on clearInterval to count calls, verify connections Map size is 0, use Node.js internal APIs or process monitoring to detect timer leaks (difficult but ideal)
- Gaps: Difficult to verify timer cleanup at Node.js runtime level - rely on clearInterval spy and functional testing (no memory growth over repeated tests)
- Evidence: change_brief.md:50 "Memory cleanup is verified (no leaks from timers or connection records)"

- Surface: Edge case - connection closes during timer creation (race condition)
- Scenarios:
  - Given connect callback succeeds, When connection added to Map, And client disconnects immediately (milliseconds), And heartbeat timer creation is in progress, Then either: (1) timer created and immediately cleared by disconnect handler, OR (2) timer creation completes after disconnect (unlikely), And no timer leak occurs, And cleanup completes successfully
- Fixtures / hooks: Very fast connect-disconnect cycle (abort immediately after request starts), verify cleanup happens correctly, may be difficult to reliably trigger race condition
- Gaps: Race condition is very narrow window (microseconds) - test may not reliably trigger it, but defensive code should handle both orderings
- Evidence: Timer cleanup is idempotent and defensive (checks for null before clear)

---

## 14) Implementation Slices

- Slice: 1 - Heartbeat timer creation and sending logic
- Goal: Implement heartbeat timer in SSE connection establishment flow
- Touches: `src/routes/sse.ts` (modify) - add heartbeat timer creation after connection added to Map (around line 151), implement timer callback that writes `: heartbeat\n` to connection.res with try-catch, store timer ID in connectionRecord.heartbeatTimer, log timer creation
- Dependencies: None - uses existing ConnectionRecord interface and config. Can be implemented and manually tested with curl or browser.

- Slice: 2 - Heartbeat write error handling
- Goal: Ensure heartbeat write failures are caught and logged gracefully
- Touches: `src/routes/sse.ts` (modify) - add try-catch around res.write() in timer callback, log errors with token and error message, add defensive check for connection existence in Map before write
- Dependencies: Requires slice 1 (timer creation). Can be tested by closing connection and observing error logs.

- Slice: 3 - Timer cleanup verification (correctness check)
- Goal: Verify existing disconnect handlers correctly use clearInterval (not clearTimeout)
- Touches: `src/routes/sse.ts` and `src/routes/internal.ts` (review and potentially fix) - existing code uses clearTimeout, should use clearInterval for setInterval timers, change if needed
- Dependencies: Requires slice 1 (timer creation using setInterval). Both clearTimeout and clearInterval work in practice but clearInterval is semantically correct.

- Slice: 4 - Integration tests for heartbeat functionality
- Goal: Comprehensive test coverage for heartbeat timing, delivery, and cleanup
- Touches: `__tests__/integration/heartbeat.test.ts` (new) - test heartbeat timer creation, heartbeat sending to stream, timer cleanup on disconnect, write failure handling, use 1-second interval for fast tests
- Dependencies: Requires slices 1-3 (complete heartbeat implementation). Needs sseStreamReader utility for capturing heartbeats.

- Slice: 5 - Integration tests for concurrent connections
- Goal: Verify multiple connections work independently with separate heartbeat timers
- Touches: `__tests__/integration/concurrency.test.ts` (new) - test 10+ concurrent connections, verify each has own timer, verify independent heartbeat timing, verify cleanup when some connections close
- Dependencies: Requires slices 1-3 (complete implementation) and slice 4 (sseStreamReader utility). Can reuse test utilities from slice 4.

- Slice: 6 - SSE stream reader utility for tests
- Goal: Test utility to capture and parse SSE stream including comments (heartbeats)
- Touches: `__tests__/utils/sseStreamReader.ts` (new) - implement streaming SSE parser that captures comments and data lines, provide API for tests to wait for heartbeats, count heartbeats, verify format
- Dependencies: None - pure utility. Should be implemented early (before slice 4) to enable integration tests.

---

## 15) Risks & Open Questions

- Risk: setInterval timer drift over long connection durations
- Impact: Heartbeats may not fire at exact intervals (Node.js event loop jitter, system load)
- Mitigation: setInterval maintains average rate even with jitter. Heartbeat timing doesn't need to be precise (approximate is fine for keep-alive). If drift becomes issue, use setTimeout with manual rescheduling to calculate next fire time. For now, setInterval is sufficient.

- Risk: Heartbeat write backpressure with slow clients
- Impact: connection.res.write() may return false if client is slow to consume data
- Mitigation: Heartbeats are best-effort - continue even if write returns false. Client will eventually disconnect if too slow. Log INFO message but don't treat as error. Backpressure handling already exists for event sends (same approach).

- Risk: clearTimeout vs clearInterval confusion
- Impact: Existing code uses clearTimeout(connection.heartbeatTimer) but should use clearInterval for setInterval timers
- Mitigation: VERIFIED: clearTimeout and clearInterval are interchangeable in Node.js - both can clear timers created by either setTimeout or setInterval. Test evidence: `node -e "const t = setInterval(() => console.log('tick'), 1000); setTimeout(() => { clearTimeout(t); console.log('cleared with clearTimeout'); process.exit(0); }, 2500);"` successfully clears setInterval timer with clearTimeout. However, semantically clearInterval is clearer for code readability. Slice 3 will change existing clearTimeout to clearInterval for semantic correctness, but this is not a functional bug - existing code works correctly.

- Risk: Test timing flakiness with heartbeat intervals
- Impact: Integration tests relying on precise timing may be flaky (heartbeat may fire 1-2 times instead of 3 due to jitter)
- Mitigation: Use shorter intervals for tests (1 second instead of 15). Use approximate counts with tolerance (e.g., expect at least N heartbeats in T seconds, not exactly N). Add generous timeouts for test assertions. Accept some jitter in test expectations.

- Risk: Memory leak from timers if clearInterval not called
- Impact: Timers continue firing forever, holding references to ConnectionRecords, preventing garbage collection
- Mitigation: Existing disconnect handlers already clear timers conditionally. Verify all disconnect paths (client close, server close, error) call clearInterval. Add integration test to verify Map is empty after many connect/disconnect cycles. Monitor memory usage in production.

- Risk: Heartbeat log spam if logged on every send
- Impact: High-frequency heartbeat sends (every 15 seconds * number of connections) could generate excessive log volume (100 connections = 400 lines/min = 24K lines/hour)
- Mitigation: DECISION MADE: OMIT routine heartbeat send logs entirely (see Section 9, Observability). Log only: (1) timer creation at INFO level (once per connection), (2) write failures at ERROR level, (3) timer cleanup is covered by existing disconnect logs. This provides adequate observability without log spam. Heartbeat functionality can be verified through timer creation logs and absence of write failure logs.

---

## 16) Confidence

Confidence: High — Requirements are clearly specified in change_brief.md and product_brief.md with exact heartbeat format and behavior. Existing codebase already has heartbeatTimer field in ConnectionRecord and timer cleanup logic in disconnect handlers. Implementation is straightforward: create setInterval timer and write SSE comment. Node.js setInterval and timer APIs are well-documented and stable. Integration test infrastructure already exists with MockServer and SSE testing utilities. Only new work is timer creation logic and test utilities for capturing heartbeats. All error handling and logging infrastructure already in place. Low risk of breaking existing functionality since heartbeats are additive feature.
