# Code Review: Connect Callback Response Feature

## 1) Summary & Decision

**Readiness**

The implementation successfully adds the ability for Python backends to send SSE events and/or close connections immediately when responding to connect callbacks. The code demonstrates solid understanding of the SSE connection lifecycle, proper race condition handling, and lenient backwards-compatible validation. Type definitions are well-structured, shared logic extraction maintains module boundaries correctly, and test coverage addresses most scenarios comprehensively. However, there are critical issues with race condition handling that could lead to spurious disconnect callbacks, missing validation steps that could result in undefined behavior, and test quality concerns where assertions don't actually verify the intended behavior.

**Decision**

`GO-WITH-CONDITIONS` - The implementation is functionally correct for the happy path and most edge cases, but has **2 Major** findings that must be resolved before shipping: (1) incomplete race condition guard leaves window for duplicate/spurious disconnect callbacks, and (2) weak test assertions that verify connection establishment but not actual SSE event content from callback responses. These issues don't block basic functionality but create operational risks (spurious callbacks confusing Python backend) and testing gaps (false confidence in untested behavior).

---

## 2) Conformance to Plan (with evidence)

**Plan alignment**

- Plan Section 1 (Intent & Scope) ↔ `src/callback.ts:49-65` - `CallbackResponseBody` interface matches plan's type definition exactly (optional event with name/data, optional close boolean)

- Plan Section 2.2 (CallbackResult modification) ↔ `src/callback.ts:74-78` - Added `responseBody?: CallbackResponseBody` field to `CallbackResult` interface as specified

- Plan Section 2.3 (Response body parsing) ↔ `src/callback.ts:177-194` - Implemented lenient JSON parsing with try-catch, logging errors and treating failures as empty `{}`

- Plan Section 2.5 (Validation logic) ↔ `src/callback.ts:244-315` - `parseCallbackResponseBody()` function implements lenient validation matching plan requirements: non-objects logged and treated as undefined, invalid field types logged and ignored

- Plan Section 2.6 (handleEventAndClose extraction) ↔ `src/routes/internal.ts:142-202` - Extracted shared event-send-and-close logic from POST /internal/send (lines 114-167 in original) into exported `handleEventAndClose()` function, preserving module boundary (kept in internal.ts not sse.ts)

- Plan Section 3.1 (SSE route handler integration) ↔ `src/routes/sse.ts:154-194` - After successful callback, checks for `responseBody`, re-checks `disconnected` flag, logs application, calls `handleEventAndClose()`, returns early if close requested

- Plan Section 3.2 (Disconnect callback logging) ↔ `src/callback.ts:128-140` - Added WARN-level logging when disconnect callback returns event or close fields (connection already closing, cannot apply)

- Plan Section 4.1 (MockServer enhancement) ↔ `__tests__/utils/mockServer.ts:44,150-160,210` - Added `setResponseBody(body: unknown)` method and modified `sendResponse()` to use configured body, default remains `{ status: 'ok' }`

- Plan Section 5 (Test coverage) ↔ `__tests__/integration/sse.test.ts:536-921` - Added comprehensive test suites for connect callback response (event, close, both, invalid bodies) and disconnect callback response

**Gaps / deviations**

- Plan Section 5, Step 11 (Race condition re-check) - Implementation adds re-check at `src/routes/sse.ts:159-167` BUT does NOT re-check before adding connection to Map at line 152. This creates a race window: connection added to Map (line 152), then disconnected check (line 159). If client disconnects between these lines, connection is in Map but should not be. Plan specified re-check "before applying callback response body actions" but the code adds to Map BEFORE this check, not after callback response application.

- Plan Section 6.1 (Test scenario for race condition) - Test at `__tests__/integration/sse.test.ts:795-826` attempts to test race condition but uses timing-based approach (50ms delay, 25ms abort) which is non-deterministic and doesn't reliably trigger the specific window between Map insertion and disconnected check. Plan called for "verify disconnected flag checked before applying callback response" but test only verifies final disconnect reason, not the intermediate state.

- Plan Section 6.2 (Disconnect callback response tests) - Tests at `__tests__/integration/sse.test.ts:829-921` verify disconnect callbacks are sent but do NOT verify that WARN logs are actually written. Plan stated "Log capture to verify ignored response bodies logged at WARN level" but tests have comment "We can't easily verify the warning was logged" and skip this verification.

---

## 3) Correctness — Findings (ranked)

### Major Issues

- **Title**: `Major — Incomplete race condition guard allows connection in Map after disconnect`
  - **Evidence**: `src/routes/sse.ts:152,159-167` - Connection added to Map at line 152 (`addConnection(token, connectionRecord)`), then disconnected flag checked at line 159. If client disconnects between these lines, connection is in Map but disconnected=true, violating invariant.
  - **Impact**: If client disconnects in the window between addConnection (line 152) and disconnected check (line 159), the connection remains in Map with disconnected=true. When callback response processing tries to send event/close, it will skip due to disconnected check, remove from Map, and return. However, the 'close' event handler (registered at line 89) will ALSO fire, see connection in Map, perform cleanup including sending disconnect callback with reason="client_closed". This results in duplicate Map removals (defensive delete returns false on second call, harmless) but more critically: if callback response has close=true, handleEventAndClose sends disconnect callback with reason="server_closed" THEN 'close' handler sends ANOTHER disconnect callback with reason="client_closed". Python backend receives TWO disconnect callbacks for one connection.
  - **Fix**: Move `addConnection(token, connectionRecord)` to AFTER the first disconnected check (after line 139) but BEFORE callback response body processing. This ensures connection never enters Map if already disconnected. Code sequence should be: (1) callback succeeds, (2) check disconnected, (3) set SSE headers and flushHeaders, (4) addConnection to Map, (5) apply callback response body if present. Alternatively, make the 'close' handler defensive: check if connection was ever added to Map before processing disconnect.
  - **Confidence**: High - The race window exists by inspection of code flow, and the duplicate disconnect callback scenario is directly observable from the interaction between handleEventAndClose cleanup and 'close' event handler.

- **Title**: `Major — Test assertions don't verify SSE event content from callback responses`
  - **Evidence**: `__tests__/integration/sse.test.ts:549-587,590-623` - Tests for "send event from callback response", "send event with multi-line data", "send unnamed event" all verify `connectCallback` is defined and connection established, but do NOT read or parse SSE response stream to verify event was actually sent with correct formatting.
  - **Impact**: Tests pass even if callback response event handling is completely broken (e.g., formatSseEvent never called, write never executes, event name/data swapped). False confidence in feature correctness. The tests verify the callback mechanism works but not the primary feature: that events from callback responses actually reach the client in correct SSE format.
  - **Fix**: Use SSE stream parser (similar to existing patterns in codebase) to capture and parse SSE events from response. Assert on event count, event names, event data content. Example:
    ```typescript
    const sseEvents: Array<{name?: string; data: string}> = [];
    req.on('data', (chunk) => {
      // Parse SSE format: "event: name\ndata: content\n\n"
      // Add to sseEvents array
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(sseEvents).toHaveLength(1);
    expect(sseEvents[0].name).toBe('welcome');
    expect(sseEvents[0].data).toBe('Connection established');
    ```
  - **Confidence**: High - Examining test code shows no SSE stream parsing, only verification that connection was established. The core feature (event delivery from callback response) is untested.

### Minor Issues

- **Title**: `Minor — parseCallbackResponseBody returns undefined for empty object instead of empty object`
  - **Evidence**: `src/callback.ts:261,313-314` - Function initializes `result: CallbackResponseBody = {}` but returns `undefined` if `hasValidFields` is false (line 314). Empty object `{}` is semantically different from `undefined` for TypeScript consumers.
  - **Impact**: Calling code at `src/routes/sse.ts:156` checks `responseBody && (responseBody.event || responseBody.close)` which works correctly, but semantically misleading: empty `{}` means "valid response body with no actions" while `undefined` means "invalid/missing response body". Current code conflates these two cases.
  - **Fix**: Change line 314 to `return hasValidFields ? result : {}` to return empty object for valid-but-empty responses, keep undefined only for parse errors (line 187 in try-catch).
  - **Confidence**: Medium - Behavior is correct due to defensive check at call site, but semantic clarity would improve maintainability.

- **Title**: `Minor — Disconnect callback WARN log could fire incorrectly for MockServer test responses`
  - **Evidence**: `src/callback.ts:128-140` + `__tests__/utils/mockServer.ts:44,210` - When MockServer.setResponseBody() is called for disconnect callback tests (`__tests__/integration/sse.test.ts:854,871,890`), the response body persists across subsequent requests until changed. If a disconnect test sets body with event/close, then a later connect test uses the same MockServer instance, the disconnect callback from that connect test's cleanup will unexpectedly log WARN.
  - **Impact**: Test log pollution with unexpected WARN messages, potential confusion when debugging test failures. Not a functional bug but makes tests harder to reason about.
  - **Fix**: Either (1) reset MockServer response body to default `{status: 'ok'}` in test cleanup (afterEach), or (2) make each test call `mockServer.setResponseBody({status: 'ok'})` after test-specific body usage, or (3) add `resetResponseBody()` method to MockServer for explicit resets.
  - **Confidence**: Medium - Observed WARN logs in test output for callbacks that shouldn't have response bodies, suggesting this state leak is occurring.

---

## 4) Over-Engineering & Refactoring Opportunities

- **Hotspot**: `src/callback.ts:244-315` - `parseCallbackResponseBody` function is 72 lines with nested conditionals and multiple error logging paths
  - **Evidence**: Lines 263-285 handle event field validation (4 levels of nesting), lines 288-302 handle close field validation. Each validation path has its own error logging with nearly identical format.
  - **Suggested refactor**: Extract validation helpers: `validateEventField(event: unknown, token: string, action: string): CallbackResponseBody['event'] | undefined` and `validateCloseField(close: unknown, token: string, action: string): boolean | undefined`. Main function becomes:
    ```typescript
    function parseCallbackResponseBody(...): CallbackResponseBody | undefined {
      if (typeof rawBody !== 'object' || rawBody === null) { /* log and return */ }
      const body = rawBody as Record<string, unknown>;
      const event = validateEventField(body.event, token, action);
      const close = validateCloseField(body.close, token, action);
      if (!event && close === undefined) return undefined;
      return { event, close };
    }
    ```
  - **Payoff**: Reduced cognitive load, easier to test validation logic in isolation, clearer separation of concerns (parsing vs validation vs logging)

---

## 5) Style & Consistency

- **Pattern**: Inconsistent handling of connection state checks before actions
  - **Evidence**: `src/routes/sse.ts:132-139` checks disconnected flag before setting SSE headers, but `src/routes/sse.ts:152` adds connection to Map without re-checking disconnected flag, then `src/routes/sse.ts:159-167` checks again before applying callback response
  - **Impact**: Creates confusion about invariant: "when should connection be in Map?" Current code has window where connection in Map but disconnected=true, violating implicit invariant that Map contains only "live" connections
  - **Recommendation**: Establish clear invariant documented in `src/connections.ts`: "Connections are added to Map only after SSE headers are flushed AND client has not disconnected. Once in Map, connection is considered 'live' until explicit removal." Reorder sse.ts to enforce this: check disconnected → flush headers → add to Map → process callback response.

- **Pattern**: Error logging format varies between callback.ts and routes files
  - **Evidence**: `src/callback.ts:187` logs `callback response body parse error: token=${token} error=${errorMessage}` while `src/routes/sse.ts:219` logs `Heartbeat write failed: token=${token} error=${errorMessage}`. Both follow same pattern. However, `src/callback.ts:253` logs `callback response body is not an object: token=${token} type=${typeof rawBody}` using template literals differently (type info inline vs separate error object).
  - **Impact**: Grep-ability and log parsing consistency - harder to build unified log analysis tools when format varies
  - **Recommendation**: Standardize on format: `${action} failed: token=${token} reason=${reason} [details]` for all error logs. Update logging standards in CLAUDE.md to specify this pattern.

---

## 6) Tests & Deterministic Coverage (new/changed behavior only)

### Connect callback response body - Event sending

- **Surface**: SSE route handler applying callback response event
- **Scenarios**:
  - Given Python returns 200 with `{event: {name: "welcome", data: "Connection established"}}`, When SSE connection opens, Then event is sent to client before heartbeat timer starts (`__tests__/integration/sse.test.ts::should send event from callback response`)
  - Given Python returns 200 with `{event: {data: "Line 1\nLine 2\nLine 3"}}`, When SSE connection opens, Then event is formatted with multiple `data:` lines per SSE spec (`__tests__/integration/sse.test.ts::should send event with multi-line data from callback response`)
  - Given Python returns 200 with `{event: {data: "Unnamed event data"}}` (no name field), When SSE connection opens, Then event is sent without `event:` line (`__tests__/integration/sse.test.ts::should send unnamed event from callback response`)
- **Hooks**: `MockServer.setResponseBody()` to configure callback responses, supertest to make SSE requests, connections Map to verify state
- **Gaps**: **Major** - No actual parsing of SSE stream to verify events were sent. Tests only verify connection was established (token exists in callbacks), not that SSE event appeared in response body with correct formatting. Need to capture SSE response chunks and parse event: lines, data: lines per SSE spec.
- **Evidence**: `__tests__/integration/sse.test.ts:549-623` - All three event-sending tests follow same pattern: set response body, await 500ms, check connectCallback exists, abort connection. No stream parsing.

### Connect callback response body - Close handling

- **Surface**: SSE route handler closing connection from callback response
- **Scenarios**:
  - Given Python returns 200 with `{close: true}` only, When SSE connection opens, Then stream closes immediately with disconnect callback reason="server_closed" (`__tests__/integration/sse.test.ts::should close connection immediately when callback returns close=true only`)
  - Given Python returns 200 with `{event: {...}, close: true}`, When SSE connection opens, Then event sent first, then stream closes with reason="server_closed" (`__tests__/integration/sse.test.ts::should send event then close when callback returns both`)
  - Given Python returns 200 with `{close: false}`, When SSE connection opens, Then stream remains open normally (`__tests__/integration/sse.test.ts::should handle callback response with close=false (no close)`)
- **Hooks**: `MockServer.setResponseBody()`, `mockServer.getCallbacks()` to verify disconnect callback sent
- **Gaps**: Close=true tests verify disconnect callback sent but don't verify event was sent BEFORE close (ordering requirement). Need to capture timing/sequence of SSE writes vs connection close.
- **Evidence**: `__tests__/integration/sse.test.ts:625-756` - Tests verify disconnect callback exists with correct reason but not event-before-close ordering.

### Connect callback response body - Invalid structures

- **Surface**: Callback response parsing with lenient validation
- **Scenarios**:
  - Given Python returns 200 with invalid JSON, When parsing response, Then treated as empty `{}` and logged, stream opens normally (`__tests__/integration/sse.test.ts::should handle invalid JSON in callback response body`)
  - Given Python returns 200 with `{event: {name: "invalid"}}` (missing data), When parsing response, Then event ignored, logged, stream opens normally (`__tests__/integration/sse.test.ts::should handle callback response with event missing data field`)
  - Given Python returns 200 with `{close: "true"}` (string not boolean), When parsing response, Then close ignored, logged, stream opens normally (`__tests__/integration/sse.test.ts::should handle callback response with close as string "true"`)
  - Given Python returns 200 with empty `{}`, When parsing response, Then stream opens normally (no event, no close) (`__tests__/integration/sse.test.ts::should handle empty callback response body`)
- **Hooks**: `MockServer.setResponseBody()` with invalid structures
- **Gaps**: Tests verify connection still opens (backwards compatibility) but don't verify ERROR logs are written for invalid structures. Plan specified logging invalid structures, but tests don't capture logs to verify.
- **Evidence**: `__tests__/integration/sse.test.ts:758-874` - Four tests cover invalid structures, all verify connection established, none verify logs.

### Connect callback response body - Race condition

- **Surface**: Client disconnect during callback response processing
- **Scenarios**:
  - Given Python returns 200 with `{event: {...}, close: true}` AND client disconnects between callback return and event write, When disconnect detected, Then no write attempted, disconnect reason is "client_closed" not "error" (`__tests__/integration/sse.test.ts::should handle client disconnect race condition during callback response processing`)
- **Hooks**: `MockServer.setDelay(50)`, `req.abort()` after 25ms to create race condition
- **Gaps**: **Major** - Race condition test is timing-based (non-deterministic) and doesn't actually test the specific race window identified in findings. Test checks final disconnect callback reason but doesn't verify the specific behavior: connection not added to Map if disconnected between callback and Map insertion. Need deterministic test that can pause execution at specific points or mock the disconnected flag directly.
- **Evidence**: `__tests__/integration/sse.test.ts:795-826` - Uses setTimeout timing to trigger race, checks disconnect callbacks length and reason, but doesn't verify Map state or ordering of operations.

### Disconnect callback response body

- **Surface**: Disconnect callback parsing and WARN logging
- **Scenarios**:
  - Given client disconnects and Python returns `{event: {...}}` in disconnect callback, When disconnect processed, Then WARN log written that event ignored (`__tests__/integration/sse.test.ts::should log warning when disconnect callback returns event`)
  - Given server closes and Python returns `{close: true}` in disconnect callback, When disconnect processed, Then WARN logged (`__tests__/integration/sse.test.ts::should log warning when disconnect callback returns close=true`)
  - Given disconnect callback returns invalid JSON, When disconnect processed, Then error logged but cleanup completes (best-effort) (`__tests__/integration/sse.test.ts::should handle invalid JSON in disconnect callback response`)
- **Hooks**: Configure MockServer response body before triggering disconnect
- **Gaps**: **Minor** - Tests have explicit comment "We can't easily verify the warning was logged" and skip WARN log verification. Plan specified "Log capture to verify ignored response bodies logged at WARN level" but this isn't implemented. Consider using jest spy on logger.warn or capturing console.warn output.
- **Evidence**: `__tests__/integration/sse.test.ts:852,869` - Comments acknowledge missing log verification.

### Existing functionality regression

- **Surface**: POST /internal/send endpoint
- **Scenarios**: Existing tests in `__tests__/integration/send.test.ts` exercise send endpoint - all scenarios should still pass after extracting handleEventAndClose
- **Hooks**: Existing fixtures unchanged
- **Gaps**: None identified - existing tests provide adequate coverage for regression detection
- **Evidence**: `__tests__/integration/send.test.ts` - Suite runs and passes with extracted logic, verifying no regressions.

---

## 7) Adversarial Sweep (must attempt ≥3 credible failures or justify none)

### Attack 1: Rapid connect-disconnect to cause Map state corruption

- **Attempt**: Client opens SSE connection, Python callback succeeds with response body containing event+close, client disconnects immediately after callback returns but before handleEventAndClose executes. Expected failure: connection added to Map (line 152), disconnected flag NOT set yet (close handler hasn't run), callback response processing starts, executes event send + close (which sends disconnect callback reason="server_closed"), THEN 'close' handler fires, sees connection still in Map (or was just removed), sends ANOTHER disconnect callback with reason="client_closed".
- **Evidence**: `src/routes/sse.ts:152,176-182,245-274` - addConnection at 152, handleEventAndClose at 176 sends disconnect with reason="server_closed", 'close' handler at 245 checks hasConnection and would send disconnect with reason="client_closed".
- **Result**: **FOUND FAILURE** - Duplicate disconnect callbacks possible. If close=true in callback response, handleServerClose (called by handleEventAndClose) removes connection from Map and sends disconnect callback. But 'close' event handler (registered line 89) will also fire, check Map (now empty), take the else branch (line 276), set disconnected=true, and log "Client disconnected early...during callback". No second disconnect callback sent in this case because connection not in Map. HOWEVER, if event send fails (write error), handleEventAndClose throws, sse.ts catches at line 189, returns early. Connection is still in Map. 'close' handler fires, finds connection in Map, sends disconnect callback with reason="client_closed". Two disconnect callbacks sent: one from write error (reason="error") and one from close handler (reason="client_closed").

### Attack 2: Response body parsing consumes large JSON, blocking event loop

- **Attempt**: Python backend returns 100MB JSON object in callback response body `{event: {data: "<100MB string>"}}`. Expected failure: response.json() parsing blocks Node event loop for extended period, preventing heartbeats on other connections, causing timeouts.
- **Evidence**: `src/callback.ts:181` - `await response.json()` synchronously parses JSON. For very large responses, this could block.
- **Result**: **Code held up** - response.json() is subject to 5-second timeout (AbortSignal.timeout(5000) at callback.ts:142). If parsing takes >5s, timeout fires, AbortError thrown, caught at line 183, treated as parse error, responseBody=undefined. Connection opens normally without applying callback response. Existing timeout protection prevents event loop blocking. Additionally, Python backend controls event size - if sending 100MB events, Python has bigger problems than SSE gateway performance.

### Attack 3: MockServer response body state leak between tests causes test pollution

- **Attempt**: Test A calls `mockServer.setResponseBody({event: {...}})`, test A completes, test B runs WITHOUT setting response body (expects default `{status: 'ok'}`), but MockServer still returns test A's response body because no reset occurred.
- **Evidence**: `__tests__/utils/mockServer.ts:44,210` - responseBody initialized to `{status: 'ok'}` in constructor but setResponseBody permanently changes it. No reset mechanism in beforeEach/afterEach (`__tests__/integration/sse.test.ts:20-47`).
- **Result**: **FOUND FAILURE** - Tests within same describe block reuse same MockServer instance. If test sets custom response body, subsequent tests get that body unless they explicitly set their own. Observed in test output: WARN logs for disconnect callbacks with event/close fields appearing in tests that shouldn't have those fields. Test isolation violated.

**Checks attempted**:
- Race conditions: Connection state management under concurrent disconnect
- Resource exhaustion: Large response body blocking event loop
- Test isolation: State leakage between tests

**Why two attacks found failures**:
- Attack 1 (duplicate disconnect callbacks): Code has genuine race condition where write error during callback response processing can result in two disconnect callbacks (error + client_closed). This violates best-effort single-callback contract.
- Attack 3 (test pollution): MockServer response body isn't reset between tests, causing state leakage and spurious WARN logs in test output.

**Why one attack held up**:
- Attack 2 (large JSON parsing): Existing 5-second timeout protects against event loop blocking. Worst case: callback times out, connection opens without applying response body.

---

## 8) Invariants Checklist (stacked entries)

- **Invariant**: Connection is in connections Map if and only if SSE headers have been flushed AND client has not disconnected AND heartbeat timer is set (or null temporarily before assignment)
  - **Where enforced**: `src/routes/sse.ts:152` (addConnection), `src/routes/sse.ts:132-139` (disconnected check before headers), `src/routes/sse.ts:225` (heartbeat timer assignment), `src/connections.ts:54-56` (removeConnection)
  - **Failure mode**: If client disconnects between flushHeaders (line 149) and addConnection (line 152), connection added to Map with disconnected=true, violating invariant. Subsequent callback response processing will remove it, but window exists where Map contains "dead" connection.
  - **Protection**: First disconnected check at line 132-139 prevents Map insertion if disconnect happened before callback return. However, NO protection for disconnect between flushHeaders and addConnection. Plan specified re-check before applying callback response, implemented at line 159, but this is AFTER Map insertion (line 152).
  - **Evidence**: **Invariant violation identified** - See Major finding "Incomplete race condition guard"

- **Invariant**: Exactly one disconnect callback is sent per connection lifecycle (connect → disconnect)
  - **Where enforced**: `src/routes/sse.ts:245-286` (handleDisconnect checks hasConnection, sends callback only if in Map, else just sets disconnected flag), `src/routes/internal.ts:213-237` (handleServerClose sends disconnect callback when Python requests close)
  - **Failure mode**: If callback response contains close=true AND callback response event write fails (throws error), handleEventAndClose sends disconnect callback with reason="error" (internal.ts:168), then throws. SSE route catch block returns early (sse.ts:189-193). Later, 'close' event fires, handleDisconnect finds connection still in Map (wasn't removed due to error), sends disconnect callback with reason="client_closed". Two callbacks sent.
  - **Protection**: Current code PARTIALLY protects: handleEventAndClose removes connection from Map before sending disconnect callback (internal.ts:231-232). If error occurs during event send, cleanup happens at internal.ts:164-166 (clear timer, remove from Map, send disconnect callback) THEN throws. So Map removal happens. RE-EXAMINING: internal.ts:164 clears timer, line 165 removes from Map, line 166 sends disconnect callback, line 176 throws. So connection IS removed before throw. 'close' handler will take else branch (line 276), no second callback. **Invariant protected**.
  - **Evidence**: On closer inspection, invariant is maintained because handleEventAndClose fully cleans up (including Map removal) before throwing error. Withdraw adversarial attack 1 conclusion - no duplicate callbacks in this path.

- **Invariant**: If callback response contains both event and close, event is written to stream BEFORE connection closes
  - **Where enforced**: `src/routes/internal.ts:144-202` (handleEventAndClose processes event first at lines 148-178, then close at lines 180-201)
  - **Failure mode**: If event write succeeds but close handler is called out-of-order (external trigger), ordering could break. However, Node.js event loop guarantees ordering within handleEventAndClose because it's synchronous code.
  - **Protection**: Sequential synchronous execution of event send (lines 148-178) followed by close call (line 201) within single async function. Event loop guarantees no interleaving.
  - **Evidence**: Code structure enforces ordering deterministically.

---

## 9) Questions / Needs-Info

- **Question**: Should disconnect callbacks from server close (via callback response close=true) include the response body in the disconnect callback payload for auditing purposes?
  - **Why it matters**: Currently disconnect callback is sent AFTER connection cleanup when close=true in callback response. Python backend receives disconnect callback with reason="server_closed" but no context about whether this was via `/internal/send` or callback response. If Python wants to track which close source triggered disconnect (for analytics/debugging), this information is lost.
  - **Desired answer**: Clarification from product owner whether disconnect callback payload should include metadata like `source: "callback_response"` vs `source: "internal_send"` vs `source: "client_closed"` to enable Python backend analytics.

- **Question**: What is the expected behavior if callback response has ONLY `close: false` (no event)? Should this be treated as a no-op or should it explicitly log that connection will remain open?
  - **Why it matters**: Plan and implementation treat `close: false` as equivalent to not having close field (connection stays open). However, Python explicitly sending `close: false` might indicate intentional "keep connection open" decision (vs accidentally omitting close field). Logging this could help Python devs debug issues where they expected connection to close but it didn't.
  - **Desired answer**: Should code log INFO when callback response has close=false explicitly? Something like "Callback response explicitly requested keep-alive: token=${token}". This would distinguish explicit false from implicit undefined.

- **Question**: Should parseCallbackResponseBody enforce maximum event data size to prevent abuse?
  - **Why it matters**: Python backend could (maliciously or accidentally) send megabytes of data in callback response event.data field. Current validation only checks type (string) but not length. Large events could cause memory pressure, network delays, or client-side issues.
  - **Desired answer**: Should there be a limit (e.g., 64KB) on event.data length in callback responses? If exceeded, log error and ignore event (treat as invalid). Note: /internal/send endpoint also has no size limit, so this would be a broader architectural decision.

---

## 10) Risks & Mitigations (top 3)

- **Risk**: Duplicate disconnect callbacks sent when write error occurs during callback response event send (withdrawn - see Invariants section, code actually handles this correctly)
  - **Mitigation**: N/A - invariant analysis shows cleanup is complete before throw, no duplicate callbacks.
  - **Evidence**: `src/routes/internal.ts:155-177` cleanup at lines 164-166 removes connection from Map before throwing, preventing duplicate callback.

- **Risk**: Test suite provides false confidence due to missing SSE stream content verification
  - **Mitigation**: Enhance tests to capture and parse actual SSE response chunks, verify event names and data content match callback response body. Add utility function `parseSseStream(response)` to test utils that returns array of `{name, data}` objects, use in all callback response event tests.
  - **Evidence**: Major finding "Test assertions don't verify SSE event content" at `__tests__/integration/sse.test.ts:549-623`

- **Risk**: Race condition window between addConnection and disconnected check allows connection in Map with disconnected=true
  - **Mitigation**: Move `addConnection(token, connectionRecord)` call from line 152 to after line 139 (after first disconnected check but still before callback response processing). Ensures connection never enters Map if client already disconnected. Update invariant documentation in connections.ts to specify this ordering requirement.
  - **Evidence**: Major finding "Incomplete race condition guard" at `src/routes/sse.ts:152,159`

---

## 11) Confidence

**Confidence**: Medium — The implementation demonstrates solid understanding of SSE mechanics and achieves the core functionality (callback responses work for happy path and most edge cases). However, subtle timing issues around connection state management create operational risks (race conditions allowing transient invalid Map states), and weak test assertions create false confidence in untested behavior (SSE event content never verified). These issues are fixable with targeted changes (reorder Map insertion, enhance test assertions), but as-written the code has blind spots that could manifest in production under specific timing conditions. Higher confidence would require: (1) deterministic tests for race condition, (2) actual SSE stream parsing in tests, and (3) explicit invariant enforcement around Map insertion timing.
