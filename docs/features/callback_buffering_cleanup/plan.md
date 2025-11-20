# Implementation Plan: Callback Buffering Cleanup

## 0) Research Log & Findings

### Areas Researched

1. **Event Buffering Implementation** (`src/routes/sse.ts`, `src/routes/internal.ts`, `src/connections.ts`)
   - Located debug log statement at `src/routes/sse.ts:165` that needs removal/refinement
   - Found flush() call at `src/routes/internal.ts:159-163` that doesn't work with Express
   - Confirmed core buffering mechanism is correctly implemented with `ready` flag and `eventBuffer`
   - Verified event ordering: callback response event → buffered events → heartbeats

2. **Test Coverage** (`__tests__/integration/send.test.ts`)
   - Existing tests focus on standard send/close scenarios
   - No tests for race condition scenarios where events arrive during callback
   - MockServer utility supports callback response body configuration via `setResponseBody()`
   - Test infrastructure is ready for new buffering tests

3. **Documentation** (`CLAUDE.md`)
   - Line 101 states "No event buffering/reordering" as an absolute rule
   - This needs updating to document the buffering exception during callback window

### Key Findings

- The race condition fix is **already implemented correctly** with early connection registration
- Event buffer mechanism works as intended: events arriving before headers are sent get buffered
- Only cleanup and documentation work remains - no functional changes needed
- The flush() call is a no-op in Express but doesn't cause errors - needs comment explaining behavior
- Debug logging needs to be removed or converted to INFO level for production

### Conflicts & Resolutions

- **CLAUDE.md vs Implementation**: Documentation claims "no event buffering" but implementation has necessary buffering during callback window
  - **Resolution**: Update CLAUDE.md to document this as an intentional exception, explaining why it's required for the race condition

---

## 1) Intent & Scope

**User intent**

Clean up and refine the event buffering implementation that addresses the race condition where Python sends events during SSE connection establishment. Remove debug artifacts, fix non-functional flush() call, add comprehensive test coverage, and update documentation to reflect the buffering exception.

**Prompt quotes**

- "Remove debug logging" - The DEBUG log statement in `src/routes/sse.ts:165`
- "Fix flush() call" - The attempted `flush()` call in `src/routes/internal.ts:159-163` doesn't work with Express
- "Add test coverage for the race condition scenarios"
- "Update CLAUDE.md to document this buffering exception"

**In scope**

- Convert debug log statement at `src/routes/sse.ts:165` to INFO level with reduced verbosity (log presence of event/close, not full JSON)
- Improve flush() comment at `src/routes/internal.ts:167-172` to explain that defensive check is harmless despite Express not exposing flush()
- Add integration tests for event buffering during callback window, including failure modes
- Update CLAUDE.md line 101 with footnote and add new subsection after line 172 documenting buffering exception with clear bounds
- Verify existing buffering implementation works correctly and that eventBuffer is cleared after flush

**Out of scope**

- Modifying core buffering logic (already implemented correctly)
- Changing connection lifecycle or callback behavior
- Performance optimization or refactoring beyond cleanup
- Adding buffering to other parts of the system

**Assumptions / constraints**

- Core buffering implementation is correct and requires no functional changes
- Test infrastructure (MockServer, supertest) supports callback response body testing
- CLAUDE.md is the primary source of truth for architectural decisions
- Debug logging was temporary and should not ship to production

---

## 2) Affected Areas & File Map

### Source Files

- **Area**: `src/routes/sse.ts:165`
- **Why**: Contains debug log statement that should be converted to INFO level without full JSON
- **Evidence**: `src/routes/sse.ts:165` - `logger.info(\`DEBUG: Callback result for token=${token}...\`);`
- **Action**: Convert to: `logger.info(\`Callback response for token=${token}: hasEvent=${!!responseBody?.event} hasClose=${!!responseBody?.close}\`);`

- **Area**: `src/routes/internal.ts:167-172`
- **Why**: Contains defensive flush() call that is a no-op in Express - clarify with improved comment
- **Evidence**: `src/routes/internal.ts:167-172` - Conditional flush() call checks for method existence; Express doesn't expose flush() but defensive code doesn't harm

### Test Files

- **Area**: `__tests__/integration/send.test.ts`
- **Why**: Needs new test section for buffering scenarios during callback window
- **Evidence**: `__tests__/integration/send.test.ts` - Existing tests cover standard send/close but not buffering race conditions

### Documentation

- **Area**: `CLAUDE.md:101`
- **Why**: States "No event buffering/reordering" which needs footnote to reference exception
- **Evidence**: `CLAUDE.md:101` - "**No event buffering/reordering**" in the "What This Service Does NOT Do" section
- **Action**: Add asterisk and footnote: "No event buffering/reordering* (*except during callback window - see Connection Lifecycle below)"

- **Area**: `CLAUDE.md` after line 172 (after "Disconnect Reasons" section)
- **Why**: Need new subsection documenting buffering exception with clear bounds and rationale
- **Evidence**: Current documentation doesn't explain the callback window buffering behavior
- **Action**: Add new subsection "### Callback Window Buffering" explaining race condition, time bounds (max 5s), and ordering guarantees

---

## 3) Data Model / Contracts

No data model or contract changes required. Existing structures remain:

- **Entity**: `ConnectionRecord` (no changes)
- **Shape**: Already includes `ready: boolean` and `eventBuffer: Array<{name?: string; data: string; close?: boolean}>`
- **Evidence**: `src/connections.ts:13-31` - Interface already supports buffering

- **Entity**: `/internal/send` response (minor documentation clarification)
- **Shape**: Returns `{ status: 'buffered' }` when event arrives before connection ready
- **Evidence**: `src/routes/internal.ts:118` - Response format already implemented

---

## 4) API / Integration Surface

No API changes. Existing behavior is preserved and documented:

- **Surface**: `POST /internal/send`
- **Inputs**: `{ token: string, event?: { name?: string, data: string }, close?: boolean }`
- **Outputs**: `{ status: 'ok' }` or `{ status: 'buffered' }` or error responses
- **Errors**: 404 (unknown token), 400 (validation), 500 (write failure)
- **Evidence**: `src/routes/internal.ts:60-133` - Implementation already handles buffering

- **Surface**: Callback response body
- **Inputs**: Python backend returns `{ event?: { name?: string, data: string }, close?: boolean }`
- **Outputs**: Events sent immediately after headers, buffered events flushed after
- **Errors**: Connection cleanup on write failure
- **Evidence**: `src/routes/sse.ts:163-202` - Callback response handling with buffering

---

## 5) Algorithms & State Machines

### Flow: SSE Connection Establishment with Buffering

**Steps:**
1. Client connects via `GET /*` - token generated, connection record created with `ready: false`
2. Connection added to Map **before** callback (enables `/internal/send` during callback)
3. Connect callback sent to Python backend (5s timeout)
4. **During callback**: `/internal/send` requests buffer events in `eventBuffer` array
5. Callback returns (success or failure)
   - **If failure**: Connection removed, error returned, buffered events discarded
   - **If success**: Headers sent, `ready` flag set to `true`
6. Callback response body processed (event and/or close directives) - sent first
7. Buffered events flushed in order (preserving arrival order)
8. `eventBuffer` cleared, heartbeat timer started

**States:**
- `ready: false` → connection exists but headers not sent (buffering mode)
- `ready: true` → headers sent, events written directly to stream
- `disconnected: true` → client disconnected during callback (cleanup flag)

**Hotspots:**
- Race condition window between connection registration and header sending (10-500ms typically)
- Event ordering must be preserved: callback event → buffered events → heartbeats
- Write failures during buffer flush require full cleanup

**Evidence**: `src/routes/sse.ts:79-223` - Complete connection lifecycle with buffering

---

## 6) Derived State & Invariants

- **Derived value**: `ready` flag
  - **Source**: Set to `true` after `res.flushHeaders()` succeeds at `src/routes/sse.ts:161`
  - **Writes / cleanup**: Controls whether events are buffered or written directly
  - **Guards**: Checked before every event write at `src/routes/internal.ts:114`
  - **Invariant**: Once `ready: true`, must never revert to `false` (one-way transition)
  - **Evidence**: `src/routes/sse.ts:161`, `src/routes/internal.ts:114`

- **Derived value**: `eventBuffer` contents
  - **Source**: Populated by `/internal/send` requests arriving before `ready: true`
  - **Writes / cleanup**: Flushed after callback response event, then cleared
  - **Guards**: Only written when `ready: false`, only read when `ready: true`
  - **Invariant**: Buffer must be cleared after flush to prevent duplicate sends
  - **Evidence**: `src/routes/internal.ts:117`, `src/routes/sse.ts:205-223`

- **Derived value**: `disconnected` flag
  - **Source**: Set by 'close' event handler if client disconnects during callback
  - **Writes / cleanup**: Prevents header sending and Map insertion after callback
  - **Guards**: Checked before header send at `src/routes/sse.ts:142`
  - **Invariant**: Once `disconnected: true`, connection must not become active
  - **Evidence**: `src/routes/sse.ts:84`, `src/routes/sse.ts:142-148`

---

## 7) Consistency, Transactions & Concurrency

- **Transaction scope**: No database transactions - all operations are in-memory Map updates
- **Atomic requirements**:
  - Connection record creation → Map insertion is atomic (synchronous)
  - Buffer flush → clear is atomic (single event loop tick)
  - Heartbeat timer creation → record update is atomic
- **Retry / idempotency**:
  - No retries for callback failures (best-effort design)
  - `/internal/send` is idempotent for unknown tokens (returns 404)
  - Event sends are not idempotent (multiple sends = duplicate events)
- **Ordering / concurrency controls**:
  - Node.js event loop guarantees serial execution per connection token
  - No explicit locks needed - all operations for a token are serialized
  - Buffer flush happens in single event loop tick (preserves order)
- **Evidence**: `src/routes/sse.ts:79-97` - Synchronous connection registration, `src/routes/sse.ts:205-223` - Synchronous buffer flush

---

## 8) Errors & Edge Cases

- **Failure**: Event arrives before connection ready (during callback)
- **Surface**: `POST /internal/send`
- **Handling**: Event buffered in `eventBuffer`, returns 200 with `status: 'buffered'`
- **Guardrails**: Buffer is only used during callback window (max 5s timeout)
- **Evidence**: `src/routes/internal.ts:114-120` - Buffering logic

- **Failure**: Client disconnects during callback (before headers sent)
- **Surface**: Express 'close' event listener
- **Handling**: `disconnected: true` flag prevents header send, connection removed from Map
- **Guardrails**: Flag checked before header send, no disconnect callback sent
- **Evidence**: `src/routes/sse.ts:91-93`, `src/routes/sse.ts:142-148`, `src/routes/sse.ts:304-314`

- **Failure**: Write fails during buffer flush
- **Surface**: `handleEventAndClose()` throws Error
- **Handling**: Heartbeat timer cleared, connection removed, disconnect callback sent with reason "error"
- **Guardrails**: Try-catch wraps buffer flush, cleanup is atomic
- **Evidence**: `src/routes/sse.ts:207-221`, `src/routes/internal.ts:186-207`

- **Failure**: Callback response body contains event and close
- **Surface**: Callback response handler
- **Handling**: Event sent first, then close (critical ordering)
- **Guardrails**: `handleEventAndClose()` enforces order, tests verify
- **Evidence**: `src/routes/sse.ts:183-196`, `src/routes/internal.ts:151-214`

- **Failure**: Multiple events buffered during slow callback
- **Surface**: `/internal/send` called multiple times before ready
- **Handling**: All events buffered in order, flushed after callback response event
- **Guardrails**: Array preserves insertion order, synchronous flush prevents reordering
- **Evidence**: `src/routes/internal.ts:117`, `src/routes/sse.ts:205-223`

---

## 9) Observability / Telemetry

- **Signal**: Buffered event log message
- **Type**: Structured log (INFO level)
- **Trigger**: When `/internal/send` receives event for connection with `ready: false`
- **Labels / fields**: `token`, `ready` flag
- **Consumer**: Operations debugging, connection lifecycle monitoring
- **Evidence**: `src/routes/internal.ts:116` - Existing log message

- **Signal**: Debug log removal (cleanup task)
- **Type**: Log statement removal
- **Trigger**: N/A (removing debug artifact)
- **Labels / fields**: Was logging callback result details including full response body
- **Consumer**: No consumer in production (debug only)
- **Evidence**: `src/routes/sse.ts:165` - Debug log to be removed

- **Signal**: Event send log messages
- **Type**: Structured log (INFO level)
- **Trigger**: When event written to SSE stream (includes buffered events)
- **Labels / fields**: `token`, `event` name, `dataLength`, `url`
- **Consumer**: Event delivery tracking, debugging
- **Evidence**: `src/routes/internal.ts:180-185` - Existing log

---

## 10) Background Work & Shutdown

- **Worker / job**: Heartbeat timer (per connection)
- **Trigger cadence**: Interval-based, starts after buffer flush completes
- **Responsibilities**: Send SSE comment every 15s (configurable) to keep connection alive
- **Shutdown handling**: Timer cleared on disconnect, server close, or write error
- **Evidence**: `src/routes/sse.ts:226-254` - Heartbeat timer creation, `src/routes/internal.ts:192`, `src/routes/sse.ts:285-287` - Timer cleanup

No global background workers or shutdown hooks required - all state is per-connection.

---

## 11) Security & Permissions

Not applicable - this change is internal cleanup only, no security surface changes.

- Authentication/authorization continues to be handled by NGINX/Python (not SSEGateway)
- No sensitive data logging changes (debug log removal reduces logging exposure)
- No rate limiting changes

---

## 12) UX / UI Impact

Not applicable - this is backend-only cleanup. No user-facing changes.

Client behavior remains identical:
- Clients still receive events in correct order
- Connection establishment timing unchanged
- Error responses unchanged

---

## 13) Deterministic Test Plan

### Surface: Event Buffering During Callback Window

**Scenarios:**

- **Given** SSE connection initiated and callback in progress, **When** `/internal/send` sends event before headers sent, **Then** event is buffered and API returns `{ status: 'buffered' }`, and event is delivered after headers sent, **And** `eventBuffer` is cleared after flush

- **Given** multiple events sent during callback window (3+ events), **When** callback completes successfully, **Then** all buffered events are delivered in order after callback response event, **And** `eventBuffer.length === 0` after flush

- **Given** callback response includes event and buffered events exist, **When** connection becomes ready, **Then** callback event is sent first, then buffered events in FIFO order, then heartbeats start

- **Given** 2+ events buffered and callback fails with 403, **When** connection is rejected, **Then** buffered events are discarded without writing to stream, **And** no disconnect callback sent, **And** connection removed from Map

- **Given** 2+ events buffered and client disconnects during callback (via abort), **When** disconnect detected before headers sent, **Then** buffered events are discarded without writes, **And** connection cleanup completes, **And** `disconnected: true` flag prevents header send

- **Given** buffered event with close flag and NO subsequent buffered events, **When** buffer is flushed, **Then** event is sent and connection is closed with reason "server_closed"

- **Given** callback response has event+close (no buffered events), **When** processing response, **Then** callback event sent, then connection closed immediately with reason "server_closed"

- **Given** buffered event with close=true followed by another buffered event, **When** buffer is flushed, **Then** verify first event sent, close executed, second event discarded (connection already closed)

**Fixtures / hooks:**

- Use existing `MockServer` utility with `setResponseBody()` to configure callback response with event/close
- Use existing `setDelay()` method to simulate slow callback (increase buffering window to 200-300ms)
- Leverage existing `connections` Map inspection for state verification including `ready` flag and `eventBuffer` length
- Use `mockServer.clearCallbacks()` to isolate disconnect callback testing
- Assert `connections.get(token)?.ready === false` before sending buffered events to ensure race condition window

**Gaps:**

- Not testing extreme scenarios (100+ buffered events) - justification: Node.js event loop serialization + 5s callback timeout makes this unlikely in practice (max ~50 events at 100ms intervals)
- Not testing connection drops during buffer flush - justification: covered by existing write failure tests in send.test.ts
- Not testing callback timeout (>5s) with buffered events - justification: timeout handling is tested elsewhere, buffering cleanup would follow same path as callback failure

**Evidence**: `__tests__/integration/send.test.ts` - Existing test patterns, `__tests__/utils/mockServer.ts` - Test utilities

---

## 14) Implementation Slices

Since this is a small cleanup change, implement in a single slice:

- **Slice**: Cleanup and Test Coverage
- **Goal**: Improve logging/comments, document behavior, add comprehensive tests
- **Touches**:
  - `src/routes/sse.ts:165` (convert debug log to INFO level without full JSON)
  - `src/routes/internal.ts:167-172` (improve flush() comment to explain defensive code)
  - `__tests__/integration/send.test.ts` (add new describe block "Event buffering during callback window" with 8 scenarios)
  - `CLAUDE.md:101` (add footnote to "No event buffering")
  - `CLAUDE.md` (add new subsection "Callback Window Buffering" after line 172)
- **Dependencies**: None - all changes are independent and backwards compatible
- **Implementation notes**:
  - Verify line numbers at implementation time (may have drifted)
  - Test callback failure scenario with `mockServer.setStatusCode(403)` + `setDelay(100)`
  - Test client disconnect with `req.abort()` during delay window
  - Assert `eventBuffer.length === 0` after successful flush in all tests

---

## 15) Risks & Open Questions

### Risks

- **Risk**: Converting debug log to INFO level might still log too much or too little
- **Impact**: Either continued log noise or insufficient debugging capability
- **Mitigation**: Log only presence of event/close directives without full JSON: `logger.info(\`Callback response for token=${token}: hasEvent=${!!responseBody?.event} hasClose=${!!responseBody?.close}\`)` - provides visibility without exposing potentially sensitive data

- **Risk**: Test timing issues with async callback delays
- **Impact**: Flaky tests if events arrive after callback completes
- **Mitigation**: Use sufficient delay in tests (200-300ms), verify `ready: false` before sending events

- **Risk**: Documentation update might be overlooked by developers
- **Impact**: Future devs might be confused by buffering behavior
- **Mitigation**: Document buffering exception prominently in CLAUDE.md with clear rationale

### Open Questions

None - all implementation details are clear from existing code and change brief.

---

## 16) Confidence

**Confidence: High** — Core implementation is already correct and working. This is pure cleanup (remove debug log, add comment, write tests, update docs) with no functional changes. Test infrastructure supports all required scenarios.
