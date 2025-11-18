# Plan Review: Send & Close Operations

## 1) Summary & Decision

**Readiness**

The plan is comprehensive, well-researched, and demonstrates strong understanding of the SSEGateway architecture. It correctly identifies the key implementation areas (SSE formatting, internal endpoint, close operations), provides detailed error handling strategies, and includes thorough test coverage. The plan's assumptions about Express response flushing and Node.js stream behavior align with documented APIs. The incremental implementation slices are well-structured and independently testable. The research log shows proper analysis of the existing codebase patterns for callbacks, connection management, and disconnect handling.

**Decision**

`GO` — The plan meets all requirements from the change brief, aligns with product specifications, and provides sufficient implementation detail. Minor clarifications about Express 5 API usage are noted but do not block implementation.

---

## 2) Conformance & Fit (with evidence)

**Conformance to refs**

- `change_brief.md` — Pass — `plan.md:9-24,136-145` — Plan correctly captures all required fields in SendRequest payload structure: token (required), event with optional name and required data, and optional close boolean. Unknown fields correctly documented as ignored.

- `change_brief.md` — Pass — `plan.md:26-30,169-178,247-261` — SSE event formatting matches specification exactly: event name line (optional), data split on newlines with `data:` prefix per line, blank line ending, immediate flush.

- `change_brief.md` — Pass — `plan.md:33-45,263-276` — Close operation correctly implements event-first ordering ("If both event and close: send event FIRST, then close"), disconnect callback with reason "server_closed", and Map cleanup.

- `change_brief.md` — Pass — `plan.md:47-50,338-360` — Error handling covers all specified cases: 404 for unknown token, 400 for invalid types, write failure triggers disconnect with reason "error".

- `product_brief.md` — Pass — `plan.md:169-178` — SSE format conforms to full SSE spec requirements from product_brief.md:146-159: optional event name line, multi-line data splitting, blank line termination.

- `product_brief.md` — Pass — `plan.md:209-212` — Disconnect callback payload matches product_brief.md:182-192 exactly: action, reason, token, request (url, headers).

- `AGENTS.md / CLAUDE.md` — Pass — `plan.md:45-46,247-248,308` — Plan correctly relies on Node.js event loop for serialization per CLAUDE.md:19 "Event Loop Ordering: All events for a token are automatically serialized".

- `AGENTS.md / CLAUDE.md` — Pass — `plan.md:91,177,231,360` — Immediate flushing requirement from CLAUDE.md:20 "Immediate Flushing: Every SSE write must flush immediately" is consistently referenced throughout the plan.

**Fit with codebase**

- `src/connections.ts` — `plan.md:110-113,226` — Plan correctly assumes getConnection() returns ConnectionRecord | undefined (verified at src/connections.ts:64-66). ConnectionRecord.res provides Response object for SSE writes (src/connections.ts:14-15). heartbeatTimer field exists and is properly typed as NodeJS.Timeout | null (src/connections.ts:23-24).

- `src/callback.ts` — `plan.md:114-116,209-212` — Plan correctly identifies sendDisconnectCallback() signature at src/callback.ts:96-117 with reason parameter accepting "server_closed" and "error" values (type defined at src/callback.ts:18). Best-effort callback behavior (no retries, log only) matches existing implementation at src/callback.ts:109-116.

- `src/routes/sse.ts` — `plan.md:118-120` — Plan references existing disconnect handling pattern for close operation. Verified that handleDisconnect pattern exists but full implementation details would need review of complete file (only read first 100 lines).

- `src/server.ts` — `plan.md:106-108,583-594` — Plan correctly identifies Express app factory pattern at src/server.ts:19 createApp(config). Mounting pattern uses router registration (src/server.ts:26-31) which plan follows for new internal router. JSON middleware already configured (src/server.ts:23).

---

## 3) Open Questions & Ambiguities

- Question: Does Express 5 Response object provide a flush() method with the expected signature?
- Why it matters: The plan assumes res.flush() is available for immediate SSE flushing (plan.md:91,231,360). If Express 5 doesn't expose flush() or has different semantics, the implementation will fail to meet the immediate flushing requirement.
- Needed answer: Verify Express 5 Response API documentation or inspect actual Response object at runtime. Alternative: use Node.js http.ServerResponse flushHeaders() method if Express doesn't expose flush(). This can be resolved during implementation of Slice 1-2.

- Question: Is res.write() synchronous or does it return immediately with backpressure indication via boolean return value?
- Why it matters: The plan's error detection strategy (plan.md:231-232,299-301) assumes write() throws synchronously on stream close OR returns false. If write() behavior differs, error detection may not work as designed.
- Needed answer: Review Node.js Writable stream documentation for write() behavior when stream is closed. Test with closed stream to verify synchronous throw vs boolean return. This affects Slice 2 implementation.

- Question: Should the plan explicitly handle the case where event.name is an empty string (not undefined)?
- Why it matters: The plan documents event.name as optional (plan.md:140,247-250) but doesn't specify behavior for empty string "". SSE spec treats empty event name differently from omitted event name.
- Needed answer: Clarify whether empty string should be treated as omitted (no event line) or written as `event: \n`. This is a minor edge case that can be decided during Slice 1 implementation. Recommend: treat empty string same as undefined (skip event line).

---

## 4) Deterministic Backend Coverage (new/changed behavior only)

- Behavior: POST /internal/send - send event to active connection
- Scenarios:
  - Given active SSE connection in Map, When POST /internal/send with token and event {name, data}, Then response 200 OK, And event written as `event: <name>\ndata: <data>\n\n`, And res.flush() called, And event logged (`__tests__/integration/send.test.ts::test_send_event_with_name`)
  - Given active connection, When POST with event {data} only (no name), Then event written as `data: <data>\n\n`, And response 200 OK (`__tests__/integration/send.test.ts::test_send_event_without_name`)
  - Given active connection, When POST with multiline data "Line1\nLine2", Then written as `data: Line1\ndata: Line2\n\n` (`__tests__/integration/send.test.ts::test_send_multiline_data`)
  - Given active connection, When POST with empty data "", Then written as `data: \n\n` (`__tests__/integration/send.test.ts::test_send_empty_data`)
- Instrumentation: Event send logged at INFO level with token, event name (if present), data length, url (plan.md:403-407)
- Persistence hooks: None - all state in-memory
- Gaps: No explicit test scenario for very large event data (megabytes) to verify memory behavior, but plan.md:616-618 acknowledges this as deferred optimization
- Evidence: plan.md:499-507,546-554

- Behavior: POST /internal/send - close connection (server-initiated)
- Scenarios:
  - Given active connection, When POST with close: true (no event), Then response 200 OK, And disconnect callback sent with reason "server_closed", And connection removed from Map, And response stream ended, And close logged (`__tests__/integration/send.test.ts::test_close_only`)
  - Given active connection, When POST with event AND close: true, Then event sent FIRST, Then connection closed, Then disconnect callback sent, And response 200 OK (`__tests__/integration/send.test.ts::test_send_and_close`)
- Instrumentation: Server close logged at INFO level with token, reason "server_closed", url (plan.md:409-414)
- Persistence hooks: None - in-memory Map cleanup via removeConnection()
- Gaps: None
- Evidence: plan.md:509-515

- Behavior: POST /internal/send - error handling (unknown token, invalid payload, write failure)
- Scenarios:
  - Given no connection for token, When POST /internal/send, Then response 404 with {"error": "Token not found"} (`__tests__/integration/send.test.ts::test_unknown_token`)
  - Given missing token field, When POST /internal/send, Then response 400 (`__tests__/integration/send.test.ts::test_missing_token`)
  - Given token not string, When POST, Then response 400 (`__tests__/integration/send.test.ts::test_invalid_token_type`)
  - Given event without event.data, When POST, Then response 400 (`__tests__/integration/send.test.ts::test_missing_event_data`)
  - Given close not boolean, When POST, Then response 400 (`__tests__/integration/send.test.ts::test_invalid_close_type`)
  - Given malformed JSON, When POST, Then Express returns 400 automatically (no explicit test needed)
  - Given response stream closed (race), When POST event, Then write throws, And disconnect callback sent with reason "error", And connection removed from Map, And response 500 (`__tests__/integration/send.test.ts::test_write_failure_error_disconnect` - noted as difficult to test in integration, may need unit test with mock)
- Instrumentation: Write failure logged at ERROR level with token, error message, url (plan.md:416-421). Invalid request logged at ERROR level (plan.md:423-428). Token not found logged at INFO level as expected condition (plan.md:430-435)
- Persistence hooks: Error disconnect removes connection from Map via removeConnection()
- Gaps: Write failure scenario noted as difficult to test in integration (plan.md:542-543), may require unit test with mocked response object
- Evidence: plan.md:517-544

- Behavior: SSE event formatting utility (formatSseEvent function)
- Scenarios:
  - Given event name "message" and data "Hello", When formatSseEvent(), Then output `event: message\ndata: Hello\n\n` (`__tests__/unit/sse.test.ts::test_format_with_name_and_data`)
  - Given undefined name and data "Hello", When formatSseEvent(), Then output `data: Hello\n\n` (`__tests__/unit/sse.test.ts::test_format_data_only`)
  - Given name and multiline data "A\nB\nC", When formatSseEvent(), Then output `event: <name>\ndata: A\ndata: B\ndata: C\n\n` (`__tests__/unit/sse.test.ts::test_format_multiline`)
  - Given empty string data, When formatSseEvent(), Then output `data: \n\n` (`__tests__/unit/sse.test.ts::test_format_empty_data`)
  - Given data "\n\n" (only newlines), When formatSseEvent(), Then output `data: \ndata: \ndata: \n\n` (`__tests__/unit/sse.test.ts::test_format_only_newlines`)
- Instrumentation: None - pure utility function, no logging
- Persistence hooks: None
- Gaps: None - comprehensive coverage of SSE spec edge cases
- Evidence: plan.md:546-554

- Behavior: Heartbeat timer cleanup on server close
- Scenarios:
  - Given connection with heartbeatTimer set, When server close triggered, Then clearTimeout(heartbeatTimer) called (`__tests__/integration/send.test.ts::test_close_clears_heartbeat_timer` - deferred until heartbeat feature implemented)
  - Given heartbeatTimer is null, When close triggered, Then no error occurs (`__tests__/integration/send.test.ts::test_close_with_null_heartbeat`)
- Instrumentation: None - timer cleanup is silent
- Persistence hooks: Timer cleanup via clearTimeout, connection removal from Map
- Gaps: Full test deferred until heartbeat feature implemented (plan.md:569-570), current test only verifies null-safe handling
- Evidence: plan.md:564-571

---

## 5) Adversarial Sweep (must find ≥3 credible issues or declare why none exist)

**Minor — SSE event name newline validation not addressed**

**Evidence:** `plan.md:386-391` — "Event name contains newline (malformed input)" section states: "Decision: document that event names must not contain newlines, Python backend responsible for validation." No validation in gateway, relies on Python.

**Why it matters:** If Python backend sends event name with embedded newline (e.g., "message\ntype"), the SSE output will be malformed: `event: message\ntype\ndata: ...\n\n` which violates SSE spec (event name must be single line). Client SSE parsers may misinterpret this as multiple lines. While the plan acknowledges this and delegates validation to Python, there's no documentation artifact specified (no update to API docs or Python interface contract).

**Fix suggestion:** Add to plan.md section 11 (Security & Permissions) or section 4 (API / Integration Surface) an explicit note that `/internal/send` assumes Python backend pre-validates event.name to not contain newlines. Add corresponding comment in code at formatSseEvent() function. Alternatively, add single-line validation in gateway: `if (name && name.includes('\n')) return 400` with error message. Low implementation cost, prevents undefined behavior.

**Confidence:** Medium — The issue is real but impact is low (Python is trusted source per architecture). Could surface as debug issue if Python has bug.

---

**Minor — Response flush() API availability assumption not verified**

**Evidence:** `plan.md:91,231,360,600-603` — Plan assumes `res.flush()` method exists on Express 5 Response object but notes this as Risk #1: "If res.flush() is not available or has different signature, immediate flushing may not work correctly."

**Why it matters:** Express 5 Response object is a wrapper around Node.js http.ServerResponse. Standard http.ServerResponse provides `flushHeaders()` but not `flush()`. Express may not expose a flush() method. If flush() is unavailable, the plan's flushing strategy fails. SSE events may be buffered by Node.js/OS, violating the immediate flush requirement (CLAUDE.md:20, product_brief.md:400).

**Fix suggestion:** Research Express 5 API before implementation starts (during Slice 1). If flush() unavailable, use one of these alternatives: (1) Call `res.flushHeaders()` after setting SSE headers, then rely on `res.write()` auto-flush behavior for small writes, or (2) Access underlying socket via `res.socket` and call `socket.uncork()`, or (3) Set response header `X-Accel-Buffering: no` to disable buffering (already done in SSE endpoint per product_brief.md:100). Document the chosen approach in plan.md section 5 (Algorithms) and verify with integration test that events arrive immediately at client.

**Confidence:** High — This is a concrete API assumption that may be incorrect. High likelihood of issue during implementation if not verified upfront.

---

**Minor — Disconnect callback error handling during close may mask failures**

**Evidence:** `plan.md:393-397,621-623` — "Disconnect callback fails during close operation" documents: "sendDisconnectCallback already handles failures internally (logs only, never throws), await ensures cleanup waits but doesn't fail on error." Risk section states: "This is acceptable per design (best-effort callbacks, no retries)."

**Why it matters:** If disconnect callback fails during server-initiated close (e.g., Python backend unreachable), the plan proceeds with cleanup and returns 200 OK to Python. Python receives 200 (success) but never receives the disconnect callback notification. Python's internal state may be inconsistent (thinks connection is still open). Subsequent /internal/send to same token will get 404, but Python has no way to know the connection closed.

**Fix suggestion:** While the plan correctly follows the best-effort callback design, the 200 response to /internal/send (close: true) could be misleading. Consider these options: (1) Keep current design but document explicitly in API contract that 200 means "gateway processed close" not "Python received callback" (add to plan.md section 4), or (2) Return 202 Accepted instead of 200 OK to indicate async processing, or (3) Change close response to include callback status: `{"status": "ok", "callback_sent": true/false}`. Option 1 is simplest and aligns with existing best-effort design. Add explicit documentation.

**Confidence:** Medium — This is a design choice rather than bug, but the subtlety could cause operational confusion. Python developers may assume 200 = callback delivered.

---

**Checks attempted (additional):**

- Transaction safety: Verified close operation cleanup is atomic (timer clear, Map remove, stream end) with no rollback needed (plan.md:313-332). No persistent state to corrupt.
- Concurrency: Verified Node.js event loop serialization assumption is correct per architecture (CLAUDE.md:19) - no race conditions within single token (plan.md:304-308,327-332).
- Error propagation: Checked that write failures trigger full cleanup (plan.md:299-301,350-360) - connection not left in inconsistent state.
- Memory leaks: Verified heartbeat timer cleanup in close flow (plan.md:266,449-451) - no leaked timers. Map.delete() ensures no leaked connection records.
- Test coverage: Cross-referenced all change_brief.md success criteria with test scenarios in plan.md section 13 - all covered.

**Why the plan holds:** The plan demonstrates strong defensive design: comprehensive error handling, explicit cleanup flows, acknowledgment of API uncertainties with mitigation strategies, and thorough test coverage. The issues found are minor clarifications rather than fundamental flaws.

---

## 6) Derived-Value & Persistence Invariants (stacked entries)

- Derived value: Formatted SSE event string
  - Source dataset: Filtered - event.name (optional, may be undefined/empty) and event.data (required, may be empty or multiline)
  - Write / cleanup triggered: Written to Response stream via res.write(), flushed via res.flush(), no persistence (ephemeral)
  - Guards: Data string split handles empty string (produces single empty data line), event name skipped if undefined, output always ends with `\n\n`
  - Invariant: Output is valid SSE format (per RFC): optional event line, one or more data lines, blank line termination. Every write followed by immediate flush. Data splitting on `\n` produces correct multi-line representation.
  - Evidence: plan.md:282-288,247-261

- Derived value: Connection existence in Map after close operation
  - Source dataset: Unfiltered - close operation triggered by Python backend via /internal/send request with close: true
  - Write / cleanup triggered: Map.delete(token) via removeConnection(), heartbeat timer cleared via clearTimeout(), Response.end() called, disconnect callback sent to Python
  - Guards: Close handler checks Map.has(token) before operations (idempotent if already removed), timer clear conditional on non-null (plan.md:266), disconnect callback wrapped in try-catch (best-effort)
  - Invariant: After close completes, token NOT in Map (connections.has(token) === false), response stream ended (client receives close), heartbeat timer cancelled (no leaked resources), Python backend notified (best-effort, may fail but logged). Idempotent: calling close on already-closed connection returns 404, no duplicate cleanup.
  - Evidence: plan.md:289-295,263-276

- Derived value: Write failure detection and error disconnect trigger
  - Source dataset: Filtered - res.write() or res.flush() throws exception OR returns false (backpressure indication)
  - Write / cleanup triggered: Exception caught, disconnect callback sent with reason "error", Map.delete(token) via removeConnection(), error logged, 500 response returned to Python
  - Guards: Try-catch wraps write and flush operations (plan.md:231-232), connection cleanup ensures Map entry removed even on error, Python receives 500 to detect failure
  - Invariant: Write failure results in complete cleanup (connection removed, callback sent, error logged). No partial state (e.g., token in Map but stream closed). Error disconnect uses reason "error" (not "client_closed" or "server_closed") to distinguish failure mode.
  - Evidence: plan.md:296-302,350-360

- Derived value: Event ordering per connection (serialization guarantee)
  - Source dataset: Filtered - multiple /internal/send requests for same token arriving concurrently
  - Write / cleanup triggered: No explicit write - relies on Node.js event loop to serialize operations
  - Guards: Single-threaded event loop (plan.md:327-329), synchronous Map.get() and res.write() calls, no async gaps between lookup and write
  - Invariant: Events for single token processed in arrival order. No interleaving of writes for same connection (e.g., event A starts writing, event B interrupts, event A completes). Event loop queue ensures FIFO processing per token.
  - Evidence: plan.md:304-308,327-332

- Derived value: Disconnect callback payload reason field
  - Source dataset: Filtered - derived from disconnect trigger: "server_closed" for explicit close, "error" for write failure, "client_closed" for client disconnect (existing feature, not modified in this plan)
  - Write / cleanup triggered: Disconnect callback POST to Python with action "disconnect" and derived reason
  - Guards: Reason value constrained to enum DisconnectReason = 'client_closed' | 'server_closed' | 'error' (src/callback.ts:18), TypeScript type safety prevents invalid values
  - Invariant: Every disconnect callback includes exactly one reason from enum. "server_closed" only sent when Python explicitly requests close (close: true). "error" only sent on write/flush failure. Reason accurately reflects disconnect cause.
  - Evidence: plan.md:209-212,264-265,299-301,src/callback.ts:18

**No filtered views driving unguarded persistent writes:** All writes are to ephemeral Response streams (no persistence). Map operations are in-memory (no persistence). Disconnect callbacks are best-effort HTTP requests (no persistent state change on failure). Guards are appropriate for in-memory state management (idempotent operations, conditional cleanup).

---

## 7) Risks & Mitigations (top 3)

- Risk: Express 5 Response flush() method may not exist, breaking immediate flush requirement
- Mitigation: Research Express 5 API documentation during Slice 1 implementation. If flush() unavailable, use alternative: (1) res.flushHeaders() after SSE headers set, (2) rely on res.write() auto-flush for small writes, or (3) access res.socket.uncork(). Add integration test to verify events arrive immediately at client (no buffering). Document chosen approach in code comments.
- Evidence: plan.md:600-603,91,231,360

- Risk: Write operation synchronicity assumptions may be incorrect, affecting error detection
- Mitigation: Review Node.js Writable stream documentation for res.write() behavior on closed streams. Test with intentionally closed stream to verify synchronous throw vs boolean return. If async, wrap write/flush in Promise and handle rejection. Adjust error handling in Slice 2 based on findings. Include unit test with mocked Response to verify error detection.
- Evidence: plan.md:604-607,299-301,350-360

- Risk: Close operation race condition if send and close requests arrive concurrently for same token
- Mitigation: Node.js event loop serialization guarantees requests processed in order (plan.md:327-329). However, if close completes while send is in-flight (already past token lookup), write will fail and trigger error disconnect. This is acceptable: write error handler provides fallback cleanup (plan.md:362-366). Add integration test for rapid send+close sequence to verify graceful handling. Document that concurrent send+close may result in error disconnect instead of clean server_closed.
- Evidence: plan.md:613-614,362-366

---

## 8) Confidence

Confidence: High — The plan is thorough, well-researched, and aligns with all normative references. Implementation slices are incremental and testable. Error handling is comprehensive. The only uncertainties (Express 5 flush API, write() synchronicity) are explicitly acknowledged with mitigation strategies. The plan demonstrates strong understanding of the existing codebase patterns and SSE specification requirements.
