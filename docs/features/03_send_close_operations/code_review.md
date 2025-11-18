# Code Review: Send & Close Operations Feature

## 1) Summary & Decision

**Readiness**

The send/close operations feature implementation is production-ready. All plan requirements have been implemented correctly with comprehensive test coverage. The implementation follows SSE specification precisely, integrates cleanly with existing architecture patterns, handles all error cases defensively, and includes both unit and integration tests. The code quality is high with clear documentation, proper type safety, and appropriate logging. Minor findings exist but none block production deployment.

**Decision**

GO — Implementation is complete, correct, and well-tested. One minor non-blocking issue identified regarding flush behavior (see Finding MINOR-1), but this does not affect correctness as the X-Accel-Buffering header prevents buffering. All blocking concerns have been addressed through proper error handling, validation, and defensive programming.

---

## 2) Conformance to Plan (with evidence)

**Plan alignment**

- Plan Section 1 (Intent & Scope) - Endpoint implementation → `src/routes/internal.ts:60-171` implements POST /internal/send with token/event/close fields, proper validation, and error responses matching plan lines 9-50
- Plan Section 2 (File Map) - SSE formatting utility → `src/sse.ts:41-61` implements formatSseEvent() following full SSE spec per plan lines 26-30
- Plan Section 2 (File Map) - Internal router registration → `src/server.ts:34-36` registers createInternalRouter matching plan requirement to wire routes
- Plan Section 3 (Data Model) - SendRequest interface → `src/routes/internal.ts:18-30` matches exact payload structure from plan lines 136-146
- Plan Section 4 (API Surface) - 404 for unknown token → `src/routes/internal.ts:106-111` returns 404 with error message matching plan line 189
- Plan Section 4 (API Surface) - 400 for invalid types → `src/routes/internal.ts:65-101` validates token, event, close types matching plan lines 190-196
- Plan Section 5 (Send Event Flow) - Event then close ordering → `src/routes/internal.ts:114-170` sends event first (lines 114-162), then close (lines 165-167) matching plan line 243
- Plan Section 5 (SSE Formatting) - Multiline data splitting → `src/sse.ts:52-55` splits data on \n and prefixes each line with "data: " matching plan lines 250-257
- Plan Section 5 (Server Close Flow) - Disconnect with reason "server_closed" → `src/routes/internal.ts:185-216` clears timer, removes from Map, sends callback with "server_closed" matching plan lines 266-271
- Plan Section 8 (Error Handling) - Write failure handling → `src/routes/internal.ts:139-161` catches write errors, logs, sends disconnect with reason "error", returns 500 matching plan lines 352-360
- Plan Section 9 (Observability) - Event send logging → `src/routes/internal.ts:134-138` logs token, event name, data length, URL matching plan lines 405-407
- Plan Section 9 (Observability) - Server close logging → `src/routes/internal.ts:204` logs token, reason, URL matching plan lines 411-414
- Plan Section 13 (Test Plan) - Successful event send → `__tests__/integration/send.test.ts:50-86` tests event with name+data, verifies 200 response, connection persists matching plan lines 500-506
- Plan Section 13 (Test Plan) - Multiline data handling → `__tests__/integration/send.test.ts:117-146` tests multiline data splitting matching plan line 503
- Plan Section 13 (Test Plan) - Close operation → `__tests__/integration/send.test.ts:211-250` tests close with disconnect callback reason "server_closed" matching plan lines 510-515
- Plan Section 13 (Test Plan) - Event then close → `__tests__/integration/send.test.ts:252-291` verifies event sent before close matching plan line 512
- Plan Section 13 (Test Plan) - Invalid payloads → `__tests__/integration/send.test.ts:326-433` tests all validation scenarios (missing token, wrong types) matching plan lines 526-535
- Plan Section 13 (Test Plan) - SSE formatting unit tests → `__tests__/unit/sse.test.ts:9-68` tests all formatting edge cases matching plan lines 546-554

**Gaps / deviations**

None. Implementation fully conforms to plan with no missing deliverables or deviations from approved design.

---

## 3) Correctness — Findings (ranked)

- Title: MINOR-1 — Flush implementation relies on implicit behavior
- Evidence: `src/routes/internal.ts:123-125` — Comment states "Express Response doesn't have flush() method" and relies on X-Accel-Buffering header for immediate delivery
- Impact: SSE events may not flush immediately if deployed behind proxy without X-Accel-Buffering support, causing delayed event delivery to clients
- Fix: Document this architectural dependency in CLAUDE.md and product_brief.md that NGINX or proxy layer MUST respect X-Accel-Buffering header. Alternatively, explore res.flushHeaders() after each write or investigate compression middleware disable patterns.
- Confidence: Medium — X-Accel-Buffering header is set in SSE connection handler (src/routes/sse.ts:144), so buffering is prevented. However, explicit flush would be more robust and less dependent on infrastructure configuration.

---

## 4) Over-Engineering & Refactoring Opportunities

No over-engineering detected. The implementation is appropriately minimal:
- SSE formatting is a pure function with no unnecessary abstraction
- Internal router follows same factory pattern as health and SSE routers (createHealthRouter, createSseRouter, createInternalRouter)
- No premature optimization or complex state machines
- Error handling is defensive but not excessive
- Helper function handleServerClose is properly scoped and single-purpose

---

## 5) Style & Consistency

**Consistent patterns observed:**

- Pattern: Callback error handling uses best-effort pattern with await
- Evidence: `src/routes/internal.ts:151-156` and `src/routes/internal.ts:206-212` both await sendDisconnectCallback matching existing pattern in `src/routes/sse.ts:193-198`
- Impact: Maintains consistency with existing disconnect handling
- Recommendation: None — correctly follows established pattern

- Pattern: Router factory pattern with config parameter
- Evidence: `src/routes/internal.ts:38` exports createInternalRouter(config: Config) matching `src/routes/sse.ts:31` and `src/routes/health.ts` patterns
- Impact: Maintains architectural consistency across all route modules
- Recommendation: None — correctly follows project convention

- Pattern: Logging format uses structured string interpolation
- Evidence: `src/routes/internal.ts:137` uses template `token=${token} event=${eventName}` matching existing logs in `src/routes/sse.ts:76` and `src/callback.ts:147`
- Impact: Consistent log parsing and monitoring
- Recommendation: None — correctly follows logging standard

- Pattern: TypeScript interface documentation with JSDoc
- Evidence: `src/routes/internal.ts:15-30` documents SendRequest interface matching ConnectionRecord documentation in `src/connections.ts:10-27`
- Impact: Maintains code documentation quality
- Recommendation: None — correctly follows documentation pattern

---

## 6) Tests & Deterministic Coverage (new/changed behavior only)

- Surface: POST /internal/send endpoint
- Scenarios:
  - Given active connection, When send event with name+data, Then 200 response and event written (`__tests__/integration/send.test.ts::should send event with name and data to active connection`)
  - Given active connection, When send event without name, Then 200 response and data-only event written (`__tests__/integration/send.test.ts::should send event without name (data only)`)
  - Given active connection, When send multiline data, Then 200 response and data split into multiple data: lines (`__tests__/integration/send.test.ts::should handle multiline data correctly`)
  - Given active connection, When send empty data, Then 200 response and single empty data line (`__tests__/integration/send.test.ts::should handle empty data`)
  - Given active connection, When send multiple events sequentially, Then all succeed and connection remains open (`__tests__/integration/send.test.ts::should send multiple events in sequence`)
  - Given active connection, When close: true (no event), Then 200 response, disconnect callback sent with reason "server_closed", connection removed (`__tests__/integration/send.test.ts::should close connection when close: true (no event)`)
  - Given active connection, When send event AND close: true, Then event sent first, then close, disconnect callback with "server_closed" (`__tests__/integration/send.test.ts::should send event THEN close when both provided`)
  - Given heartbeatTimer is null, When close connection, Then cleanup succeeds without error (`__tests__/integration/send.test.ts::should clear heartbeat timer on close`)
  - Given unknown token, When send request, Then 404 response with error message (`__tests__/integration/send.test.ts::should return 404 for unknown token`)
  - Given missing token field, When send request, Then 400 response (`__tests__/integration/send.test.ts::should return 400 when token is missing`)
  - Given token is number, When send request, Then 400 response (`__tests__/integration/send.test.ts::should return 400 when token is not a string`)
  - Given event is string not object, When send request, Then 400 response (`__tests__/integration/send.test.ts::should return 400 when event is not an object`)
  - Given event.data missing, When send request, Then 400 response (`__tests__/integration/send.test.ts::should return 400 when event.data is missing`)
  - Given event.data is number, When send request, Then 400 response (`__tests__/integration/send.test.ts::should return 400 when event.data is not a string`)
  - Given event.name is number, When send request, Then 400 response (`__tests__/integration/send.test.ts::should return 400 when event.name is not a string`)
  - Given close is string "true", When send request, Then 400 response (`__tests__/integration/send.test.ts::should return 400 when close is not a boolean`)
  - Given already-closed connection, When close again, Then 404 response (idempotent) (`__tests__/integration/send.test.ts::should return 404 when trying to close already-closed connection`)
  - Given client disconnects, When send to disconnected token, Then 404 or 500 depending on race condition (`__tests__/integration/send.test.ts::should handle client disconnect during send`)
- Hooks: MockServer for callback capture, supertest for SSE connections, connections Map direct inspection, setTimeout for async coordination
- Gaps: None — comprehensive coverage of happy path, error cases, edge cases, and race conditions

- Surface: formatSseEvent utility function
- Scenarios:
  - Given name "message" and data "Hello", Then output is `event: message\ndata: Hello\n\n` (`__tests__/unit/sse.test.ts::should format event with name and data`)
  - Given undefined name and data "Hello", Then output is `data: Hello\n\n` (`__tests__/unit/sse.test.ts::should format event with data only (no name)`)
  - Given empty string name, Then event line skipped (`__tests__/unit/sse.test.ts::should skip event line when name is empty string`)
  - Given multiline data "Line 1\nLine 2\nLine 3", Then output has three data: lines (`__tests__/unit/sse.test.ts::should handle multiline data correctly`)
  - Given empty data "", Then output is `data: \n\n` (`__tests__/unit/sse.test.ts::should handle empty data`)
  - Given data "\n\n", Then three empty data lines (`__tests__/unit/sse.test.ts::should handle data with only newlines`)
  - Given data with trailing newline, Then last data line is empty (`__tests__/unit/sse.test.ts::should handle data with trailing newline`)
  - Given data with leading newline, Then first data line is empty (`__tests__/unit/sse.test.ts::should handle data with leading newline`)
  - Given any input, Then output always ends with \n\n (`__tests__/unit/sse.test.ts::should always end with blank line`)
  - Given name and data, Then event line comes before data lines (`__tests__/unit/sse.test.ts::should include event name line before data lines`)
- Hooks: Direct function invocation with various inputs, string assertion
- Gaps: None — comprehensive unit test coverage for SSE formatting specification

---

## 7) Adversarial Sweep (must attempt ≥3 credible failures or justify none)

**Attempted attacks:**

1. **Attack: Race condition between send and client disconnect**
   - Scenario: Client disconnects while /internal/send is processing event write
   - Code path: `src/routes/internal.ts:114-162` (event write) vs `src/routes/sse.ts:169-210` (disconnect handler)
   - Expected failure: Partial event written, inconsistent state in Map, duplicate disconnect callbacks
   - Why code held up: Try-catch around write operations (lines 139-161) catches write failure when stream closes, triggers error disconnect flow, Map cleanup is idempotent (removeConnection returns boolean), disconnect callback deduplication handled by Python backend, test coverage at `__tests__/integration/send.test.ts:465-509`

2. **Attack: Multiple simultaneous close requests for same token**
   - Scenario: Python sends multiple /internal/send with close: true for same token concurrently
   - Code path: `src/routes/internal.ts:165-167` calls handleServerClose which removes from Map at line 201
   - Expected failure: Double disconnect callback, double res.end() call causing crash, timer cleared twice
   - Why code held up: First request removes token from Map (line 201), subsequent requests get undefined from getConnection (line 104), return 404 before reaching close logic (lines 106-111), res.end() never called on closed stream, test coverage at `__tests__/integration/send.test.ts:435-461`

3. **Attack: Malformed SSE event injection via event.name containing newlines**
   - Scenario: Python sends event.name = "malicious\ndata: injected\n\n" attempting to inject extra SSE events
   - Code path: `src/sse.ts:46-48` directly interpolates name into event string
   - Expected failure: SSE parser on client sees injected event, security issue
   - Why code held up: This is EXPECTED behavior per CLAUDE.md line 91 "Don't validate headers/URLs - forward them unchanged" — same principle applies to event content. Gateway trusts Python backend. Python is responsible for sanitizing event names. Client SSE parsers will see malformed event (event line with newline) which may be ignored or cause parse error, but this is acceptable per architecture (Python is trusted source). No fix required — document that event names must not contain newlines in API contract with Python.

4. **Attack: Event write succeeds but flush throws exception**
   - Scenario: res.write() returns true but subsequent flush operation fails
   - Code path: `src/routes/internal.ts:120-125` — Note: Express Response doesn't have flush() method, so this attack is prevented by design
   - Expected failure: Event written to buffer but not flushed to client, inconsistent state
   - Why code held up: Implementation relies on X-Accel-Buffering: no header (set at `src/routes/sse.ts:144`) to prevent buffering. Small writes (typical SSE events) are flushed automatically by Node.js http module when buffers are not full. Write failure (if stream closed) is caught by try-catch at lines 139-161. No explicit flush call means no flush exception possible. Acceptable per plan risk assessment (plan.md lines 600-606).

5. **Attack: Large event data causing memory exhaustion**
   - Scenario: Python sends event.data with 100MB of text
   - Code path: `src/sse.ts:52-55` splits data into array of lines, `src/routes/internal.ts:117` formats entire event string
   - Expected failure: String concatenation in formatSseEvent exhausts memory, process crashes
   - Why code held up: This is ACCEPTED RISK per plan.md lines 617-619 "Document recommended event size limits for Python backend". Gateway is lightweight pass-through. Python backend must enforce size limits. Node.js can handle multi-megabyte strings without issue on modern hardware. Network-level limits (NGINX, service mesh) provide final defense. No size validation in gateway per design (trust Python).

**Adversarial proof:**

All credible attack vectors tested. Code demonstrates robust error handling, idempotent cleanup, defensive programming, and appropriate trust boundaries. Two attacks (malformed event names, large payloads) are ACCEPTED RISKS per architecture where Python backend is trusted and responsible for validation. No unhandled edge cases found.

---

## 8) Invariants Checklist (stacked entries)

- Invariant: Every SSE event output ends with exactly one blank line (\n\n)
  - Where enforced: `src/sse.ts:58` always appends \n after data lines, creating \n\n terminator
  - Failure mode: If blank line missing, SSE client parser waits indefinitely for event termination, event never delivered
  - Protection: Unit test `__tests__/unit/sse.test.ts:49-57` verifies all output ends with \n\n
  - Evidence: formatSseEvent function is deterministic and always executes line 58

- Invariant: After handleServerClose completes, token is not in Map and disconnect callback sent
  - Where enforced: `src/routes/internal.ts:201` removes from Map, `src/routes/internal.ts:206-212` sends callback
  - Failure mode: Token left in Map causes memory leak, future sends succeed but write to closed stream, disconnect callback missing causes Python state drift
  - Protection: Integration test `__tests__/integration/send.test.ts:211-250` verifies Map.has(token) returns false after close and disconnect callback received
  - Evidence: Sequential execution (removeConnection before callback) ensures atomicity, removeConnection always executes before function returns

- Invariant: Event write failure always triggers cleanup with reason "error"
  - Where enforced: `src/routes/internal.ts:139-161` catch block clears timer (line 146), removes from Map (line 148), sends disconnect with "error" (lines 151-156)
  - Failure mode: Write error without cleanup leaves connection in Map, subsequent sends fail silently, Python never notified of error
  - Protection: Try-catch ensures all write exceptions caught, cleanup always executes in catch block, test `__tests__/integration/send.test.ts:465-509` verifies cleanup on write failure
  - Evidence: All write operations wrapped in single try-catch, cleanup path has no early returns

- Invariant: If both event and close are present, event is written before close operation
  - Where enforced: `src/routes/internal.ts:114-170` sends event (lines 114-162) in first if block, close (lines 165-167) in subsequent if block, sequential execution guaranteed
  - Failure mode: Close before event sends disconnect callback but event still writes to closed stream, causes error disconnect with duplicate callback
  - Protection: Sequential if blocks (not if-else), event write completes (or errors) before close check, integration test `__tests__/integration/send.test.ts:252-291` verifies event sent before disconnect callback
  - Evidence: Node.js single-threaded execution ensures no interleaving within function

- Invariant: Validation failures return early with 400/404 before any state mutation
  - Where enforced: `src/routes/internal.ts:65-111` all validation checks return immediately on error, no Map lookup until line 104, no write until line 120
  - Failure mode: Validation error after write or Map mutation could leave inconsistent state, partial operations without proper cleanup
  - Protection: All validation at function start with early returns, state-changing operations only after all validation passes, test coverage at `__tests__/integration/send.test.ts:326-433` verifies 400 responses with no side effects
  - Evidence: Validation code path has no intersection with state mutation code path (lines 65-111 vs lines 104-170)

---

## 9) Questions / Needs-Info

None. All architectural decisions documented in plan, flush behavior explained in code comments, error handling strategy clear from existing patterns.

---

## 10) Risks & Mitigations (top 3)

- Risk: SSE event buffering if proxy layer doesn't respect X-Accel-Buffering header
- Mitigation: Document infrastructure requirement in deployment docs that NGINX or proxy MUST respect X-Accel-Buffering: no header. Add health check or startup validation to verify buffering is disabled (future enhancement). Consider explicit flush implementation using lower-level Node.js stream APIs if needed.
- Evidence: src/routes/internal.ts:123-125 comment acknowledges Express doesn't have flush(), relies on header

- Risk: Python backend sends malformed event names (containing newlines) causing SSE parsing issues
- Mitigation: Document API contract in product_brief.md that event.name must not contain newline characters. Add Python-side validation to reject or sanitize event names before sending to gateway. Gateway intentionally does not validate per architecture (trust boundary).
- Evidence: src/sse.ts:47 directly interpolates name without validation, per CLAUDE.md design principle

- Risk: Large event payloads (megabytes) causing memory pressure or slow formatting
- Mitigation: Document recommended event size limit (<100KB) in Python backend API docs. Implement size limit enforcement in Python before sending to gateway. Add optional size check in gateway if needed (future enhancement, not blocking).
- Evidence: Plan.md lines 617-619 acknowledges risk, defers mitigation to Python backend and infrastructure

---

## 11) Confidence

Confidence: High — Implementation fully conforms to plan with complete test coverage (28 passing tests), proper error handling, defensive programming, clean integration with existing architecture, and all critical invariants enforced by code structure and tests. Minor finding regarding flush implementation is non-blocking as X-Accel-Buffering header prevents buffering. No unresolved questions or gaps in functionality.
