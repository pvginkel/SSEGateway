# Code Review: SSE Connect Flow Implementation

**Reviewer:** Claude Code
**Date:** 2025-11-18
**Revision:** e628bda (main branch)
**Files Reviewed:**
- New: `src/connections.ts`, `src/callback.ts`, `src/routes/sse.ts`
- New: `__tests__/integration/sse.test.ts`, `__tests__/utils/mockServer.ts`
- Modified: `src/server.ts`

---

## 1) Summary & Decision

**Readiness**

The SSE connect flow implementation demonstrates solid architectural design with proper separation of concerns (connections, callbacks, routing), comprehensive error handling for callback failures and timeouts, and thoughtful race condition handling. However, 11 of 26 tests are failing due to a critical async timing issue: the Express response 'close' event fires immediately when Supertest creates the request, before the SSE connection handler can complete the callback and add the connection to the Map. This causes all successful connection tests to fail because the connection closes prematurely and callbacks are never recorded in the mock server.

**Decision**

`NO-GO` — The implementation has a **Blocker** severity issue that prevents successful connection establishment in the test environment. The core async flow ordering problem must be resolved before this code can be merged. Specifically: Supertest's request handling triggers the 'close' event synchronously before the async handler runs, breaking the entire connection lifecycle. This likely indicates a fundamental incompatibility between Supertest's behavior and long-lived SSE connections, requiring either a test harness change or investigation into why the connection closes immediately.

---

## 2) Conformance to Plan (with evidence)

**Plan alignment**

The implementation follows the plan structure closely:

- Plan Section 2 (Affected Areas & File Map) ↔ All specified files created:
  - `src/connections.ts:1-77` — Implements `ConnectionRecord` interface, `connections` Map, and helper functions (addConnection, removeConnection, getConnection, hasConnection)
  - `src/callback.ts:1-175` — Implements `sendConnectCallback` and `sendDisconnectCallback` with 5-second timeout via `AbortSignal.timeout(5000)` (line 140)
  - `src/routes/sse.ts:1-215` — Implements GET /sse/* wildcard route handler with full lifecycle management
  - `src/server.ts:29-31` — Registers SSE router in Express app
  - `__tests__/integration/sse.test.ts:1-456` — Comprehensive test coverage for all scenarios
  - `__tests__/utils/mockServer.ts:1-199` — Mock Python backend server for callback testing

- Plan Section 3 (Data Model / Contracts) ↔ `src/connections.ts:13-27`:
  ```typescript
  export interface ConnectionRecord {
    res: Response;
    request: { url: string; headers: Record<string, string | string[]> };
    heartbeatTimer: NodeJS.Timeout | null;
    disconnected: boolean;
  }
  ```
  Matches plan exactly, including `disconnected` flag for race condition handling and nullable `heartbeatTimer`.

- Plan Section 5 (Algorithms & State Machines - Connect Flow) ↔ `src/routes/sse.ts:46-154`:
  - Steps 1-2: `src/routes/sse.ts:48-55` — Validates `CALLBACK_URL` configured, generates token via `randomUUID()`
  - Steps 3-4: `src/routes/sse.ts:57-73` — Extracts raw URL with fallback (`req.url || '/sse/unknown'`), filters undefined header values
  - Step 5-7: `src/routes/sse.ts:79-90` — Creates preliminary ConnectionRecord, registers 'close' listener BEFORE callback
  - Steps 8-11: `src/routes/sse.ts:93-129` — Sends connect callback with timeout, handles errors (504 for timeout, 503 for network, same status for non-2xx)
  - Steps 12-13: `src/routes/sse.ts:131-153` — Checks `disconnected` flag, sets SSE headers only if callback succeeded and client still connected

- Plan Section 5 (Algorithms & State Machines - Disconnect Flow) ↔ `src/routes/sse.ts:169-214`:
  - Steps 1-3: `src/routes/sse.ts:175-197` — Checks token in Map, clears heartbeat timer (if not null), removes from Map, sends disconnect callback best-effort
  - Step 4: `src/routes/sse.ts:203-213` — Handles early disconnect (sets `disconnected` flag, logs, no callback sent)

- Plan Section 8 (Errors & Edge Cases) ↔ Implementation handles all specified cases:
  - Callback timeout: `src/callback.ts:133-140` uses `AbortSignal.timeout(5000)`, returns 504 (`src/routes/sse.ts:105-108`)
  - Non-2xx callback: `src/callback.ts:143-152` checks `response.ok`, returns same status (`src/routes/sse.ts:109-117`)
  - Network error: `src/callback.ts:153-174` catches fetch errors, returns 503 (`src/routes/sse.ts:114-117`)
  - Race condition: `src/routes/sse.ts:88-90` registers 'close' listener before callback, `src/routes/sse.ts:132-138` checks `disconnected` flag
  - Header filtering: `src/routes/sse.ts:63-67` filters out `undefined` values with type guard
  - URL fallback: `src/routes/sse.ts:59` uses `req.url || '/sse/unknown'`

**Gaps / deviations**

- Plan Section 5 states "callback FIRST, then headers" (line 202) — **CONFIRMED**: Implementation sends callback first (`src/routes/sse.ts:93-97`), then sets headers only after callback succeeds (`src/routes/sse.ts:141-148`). This allows non-2xx status propagation to client. No deviation.

- Plan Section 13 (Deterministic Test Plan) expects successful connection tests to pass — **GAP**: 11 tests failing due to connections closing prematurely. Tests are written correctly per plan, but implementation or test harness has async timing issue preventing callback completion before connection closes. Evidence: Test logs show "Client disconnected early: token=... (during callback)" for tests expecting successful connections (e.g., `sse.test.ts:50-88`).

- Plan Section 6 (Derived State & Invariants - heartbeatTimer) states timer should be `null` for this feature — **CONFIRMED**: `src/routes/sse.ts:82` sets `heartbeatTimer: null`, and `src/routes/sse.ts:180-182` has null-check before `clearTimeout`. No deviation.

---

## 3) Correctness — Findings (ranked)

- Title: `Blocker — SSE connections close immediately before async callback completes`
- Evidence: `__tests__/integration/sse.test.ts:50-88` test expects callback to be recorded, but test logs show `Client disconnected early: token=b13b4e31-5209-42eb-8109-cc4432f16713 url=/sse/protected (during callback)`. The 'close' event fires BEFORE the async `sendConnectCallback` completes and records the callback in mockServer. All 11 failing tests exhibit this pattern: connection closes before the 200ms wait for callback completion. Test output shows `expect(callbacks.length).toBeGreaterThan(0)` receives 0 callbacks.
- Impact: This breaks the entire SSE connection establishment flow. If connections close immediately in production (as they do in tests), no SSE streams can ever be established. Clients receive empty responses. The gateway cannot function.
- Fix: Root cause analysis required. Possibilities:
  1. **Supertest incompatibility**: Supertest may close connections synchronously when creating requests with `.timeout()`. The 'close' listener registered at `src/routes/sse.ts:88-90` fires immediately, setting `disconnected=true` before the callback starts. Solution: Replace Supertest with native `http.request()` for SSE tests, or keep connection alive by not using `.timeout()` and instead manually aborting after verification.
  2. **Express 5 behavior**: Express may emit 'close' for GET requests that don't consume the response body. SSE requires keeping the response stream open. Solution: Verify Express 5 SSE compatibility, ensure `res.flushHeaders()` keeps connection alive.
  3. **Test timing**: The async callback might complete but mock server not capturing payload before disconnect cleanup. Solution: Add synchronization primitives (EventEmitter) in mock server to ensure payload captured before test assertions.

  **Minimal investigation step**: Add debug logging immediately inside 'close' listener (`src/routes/sse.ts:88`) to log stack trace and timing. Run single test to determine WHEN close fires relative to handler start. If close fires before `await sendConnectCallback` line, issue is Supertest/Express. If close fires after, issue is test synchronization.

- Confidence: High — Test failure pattern is consistent across all successful connection tests. Logs definitively show "disconnected early during callback" indicating the race condition flag is working, but firing inappropriately due to premature connection closure.

---

- Title: `Major — Error type classification uses string matching instead of error name property`
- Evidence: `src/callback.ts:158-162` — Error type determination uses `error.name === 'TimeoutError' || error.name === 'AbortError'`, but then `src/routes/sse.ts:105` checks `callbackResult.error?.includes('timeout')` (string matching). The error classification logic is split: callback.ts classifies by error.name, but sse.ts classifies by error message substring.
- Impact: If AbortSignal.timeout throws an error with name 'AbortError' but error message doesn't contain 'timeout', the check at `src/routes/sse.ts:105` will fail and return 503 instead of 504. This creates inconsistent timeout handling and wrong HTTP status codes for clients. Debugging is harder when status codes don't match actual error types.
- Fix: Return a structured error type from `sendConnectCallback` instead of string-based errors. Change `CallbackResult` to include an `errorType?: 'timeout' | 'network' | 'non_2xx'` field. Then `src/routes/sse.ts:100-117` can switch on `callbackResult.errorType` instead of parsing strings. Example:
  ```typescript
  // In callback.ts
  export interface CallbackResult {
    success: boolean;
    statusCode?: number;
    errorType?: 'timeout' | 'network' | 'http_error';
    errorMessage?: string;
  }

  // In sse.ts
  if (callbackResult.errorType === 'timeout') {
    statusCode = 504;
  } else if (callbackResult.errorType === 'network') {
    statusCode = 503;
  } else if (callbackResult.statusCode) {
    statusCode = callbackResult.statusCode;
  }
  ```
- Confidence: High — String matching for control flow is brittle and error-prone, especially when error messages can vary across Node.js versions or fetch implementations.

---

- Title: `Major — Disconnect callback sent without awaiting, potential unhandled promise rejection`
- Evidence: `src/routes/sse.ts:192-202` — `sendDisconnectCallback(...).catch(...)` fires without `await`, comment says "Don't await - allow cleanup to complete immediately". The catch handler logs errors, but there's no guarantee the promise chain executes before the function returns, especially during rapid shutdown or test teardown.
- Impact: In high-churn scenarios (many rapid connects/disconnects), disconnect callbacks may not send at all if the event loop exits before the promise resolves. During Jest test teardown, the "worker process failed to exit gracefully" warning indicates leaked async operations. The non-awaited promise is likely the culprit. Python backend may not receive disconnect notifications for short-lived connections.
- Fix: Either (1) await the disconnect callback but acknowledge it adds latency to cleanup, or (2) properly track the promise in a Set and drain during shutdown. Given plan states "best-effort" for disconnect callbacks, option 1 is preferable for correctness. Change `src/routes/sse.ts:192-202` to:
  ```typescript
  await sendDisconnectCallback(
    callbackUrl,
    token,
    'client_closed',
    record.request
  );
  // sendDisconnectCallback already catches and logs errors internally
  ```
  This ensures callback completes before cleanup finishes, preventing orphaned promises.
- Confidence: High — Jest warning "worker process has failed to exit gracefully" combined with non-awaited async operation is strong evidence. Best-effort doesn't mean "fire and hope," it means "try sincerely but don't retry on failure."

---

- Title: `Minor — TypeScript type assertion could be unsafe if error type changes`
- Evidence: `src/callback.ts:158-169` — Code uses `error instanceof Error` then checks `error.name`, but the `else` branch on line 167-169 casts unknown error to string. If a non-Error, non-string value is thrown (e.g., `throw { code: 'NETWORK_ERROR' }`), the `String(error)` conversion produces `[object Object]`, which isn't useful for debugging.
- Impact: Debugging async callback failures becomes harder if error messages are opaque. Operators cannot diagnose network vs. timeout issues from logs. This is a minor observability issue, not a functional bug.
- Fix: Use a more robust error stringification:
  ```typescript
  } else {
    errorType = 'unknown';
    errorMessage = typeof error === 'object' && error !== null
      ? JSON.stringify(error)
      : String(error);
  }
  ```
- Confidence: Medium — Edge case that depends on fetch() or network layer throwing non-standard errors. Unlikely but possible.

---

## 4) Over-Engineering & Refactoring Opportunities

- Hotspot: Helper functions in `src/connections.ts` add indirection without clear benefit
- Evidence: `src/connections.ts:44-76` — Four helper functions (`addConnection`, `removeConnection`, `getConnection`, `hasConnection`) wrap one-line Map operations. These are only called from `src/routes/sse.ts`, and the abstraction doesn't hide complexity or enable testing.
- Suggested refactor: Remove helper functions and directly use `connections.set()`, `connections.delete()`, `connections.get()`, `connections.has()` in `src/routes/sse.ts`. Export only the `connections` Map and `ConnectionRecord` type. This reduces indirection and makes the code more direct. If future features need centralized connection lifecycle hooks, the helpers can be reintroduced.
- Payoff: Fewer lines of code to maintain, one less level of indirection when debugging, clearer data flow (Map operations are self-documenting).

---

- Hotspot: CallbackRequest type duplicates ConnectionRecord.request structure
- Evidence: `src/callback.ts:23-28` defines `CallbackRequest`, `src/connections.ts:17-22` defines identical structure in `ConnectionRecord.request`. Both have `{ url: string; headers: Record<...> }`.
- Suggested refactor: Define `CallbackRequest` once in `src/connections.ts` and reuse it in both `ConnectionRecord` and `src/callback.ts`. This establishes single source of truth for request metadata shape.
  ```typescript
  // In src/connections.ts
  export interface CallbackRequest {
    url: string;
    headers: Record<string, string | string[]>;
  }

  export interface ConnectionRecord {
    res: Response;
    request: CallbackRequest; // Reuse type
    heartbeatTimer: NodeJS.Timeout | null;
    disconnected: boolean;
  }
  ```
  Then `src/callback.ts` imports `CallbackRequest` from `connections.js`.
- Payoff: DRY principle, ensures callback payload structure always matches stored connection metadata, easier to evolve the request shape in future.

---

## 5) Style & Consistency

- Pattern: Error logging duplicates token and error information in multiple formats
- Evidence: `src/callback.ts:150` logs `[ERROR] connect callback returned non-2xx: token=... status=...`, then `src/routes/sse.ts:119-121` logs `[ERROR] SSE connection rejected: token=... status=... error=...`. Both log lines appear for the same event (test output shows both), creating duplicate log entries.
- Impact: Log noise makes debugging harder. Operators see two ERROR lines for one failure, obscuring actual error rate. Searching logs for unique failures is complicated by duplicates.
- Recommendation: Decide on single logging location: either callback layer (where error originates) OR route layer (where error is handled). Plan Section 9 (Observability) specifies "Callback results (success/failure)" and "Connection establishment" as separate signals, suggesting both are legitimate. However, the route layer log should be INFO level (not ERROR) for rejected connections since callback failure is the authoritative error. Change `src/routes/sse.ts:119` to:
  ```typescript
  logger.info(
    `SSE connection rejected by backend: token=${token} status=${statusCode}`
  );
  ```
  Keep ERROR level only in callback.ts where the failure actually occurs.

---

- Pattern: Comment claims heartbeat implementation "deferred" but structure suggests forgotten cleanup
- Evidence: `src/routes/sse.ts:82` sets `heartbeatTimer: null` with comment "Heartbeat implementation deferred", but `src/routes/sse.ts:180-182` still has null-check and `clearTimeout` logic. If heartbeat is intentionally deferred, the cleanup code is dead code for this feature.
- Impact: Code readers may think heartbeat is partially implemented and broken. Future implementers may not realize the timer field is intentionally null.
- Recommendation: Add explicit comment at cleanup site explaining the null-check is future-proofing:
  ```typescript
  // Clear heartbeat timer if set (currently always null - heartbeat feature not yet implemented)
  // This null-check is intentional future-proofing for when heartbeats are added
  if (record.heartbeatTimer) {
    clearTimeout(record.heartbeatTimer);
  }
  ```
  Alternatively, remove the null-check entirely for this feature and add a TODO comment to re-add it when heartbeats are implemented.

---

## 6) Tests & Deterministic Coverage (new/changed behavior only)

- Surface: GET /sse/* endpoint - successful connection flow
- Scenarios:
  - Given CALLBACK_URL configured and Python returns 200, When client connects, Then SSE headers set, stream open, callback sent, token in Map (`sse.test.ts:50-88`) — **FAILING**: Connection closes before callback completes
  - Given multiple concurrent connections, When all connect, Then each has unique token and independent stream (`sse.test.ts:153-174`) — **FAILING**: Same root cause
  - Given request with headers, When callback sent, Then headers forwarded verbatim including multi-value headers (`sse.test.ts:106-130`) — **FAILING**: Connection closes before verification
- Hooks: `MockServer` class (`mockServer.ts:38-198`) provides HTTP callback server with configurable status, delay, and payload capture. Test setup (`sse.test.ts:19-47`) creates mock server, starts it, creates app with callback URL, and cleans up connections Map.
- Gaps: **All successful connection tests failing** due to Blocker issue. Tests are correctly written per plan but cannot execute due to premature connection closure. Mock server implementation appears correct (receives callbacks in non-2xx tests).
- Evidence: Test output shows `expect(callbacks.length).toBeGreaterThan(0); Received: 0` for all successful connection tests, but rejection tests (non-2xx callbacks) pass, proving mock server works. This indicates successful connection path has async ordering issue.

---

- Surface: GET /sse/* endpoint - connect callback rejection (non-2xx)
- Scenarios:
  - Given Python returns 401/403/500, When client connects, Then same status returned, no SSE headers, token not in Map (`sse.test.ts:178-224`) — **PASSING**: All 4 tests pass (401, 403, 500, header verification)
- Hooks: `mockServer.setStatusCode(401)` configures rejection response
- Gaps: None — rejection flow is fully tested and working
- Evidence: `sse.test.ts:178-224` all pass, demonstrating callback rejection correctly propagates status to client

---

- Surface: GET /sse/* endpoint - callback network failures
- Scenarios:
  - Given callback URL unreachable, When client connects, Then 503 returned (`sse.test.ts:228-237`) — **PASSING**
  - Given callback timeout >5s, When client connects, Then 504 returned (`sse.test.ts:239-248`) — **PASSING**
- Hooks: `mockServer.stop()` simulates network failure, `mockServer.setDelay(6000)` simulates timeout
- Gaps: None — network failure handling works correctly
- Evidence: Both tests pass, proving timeout and network error detection work as designed

---

- Surface: Express response 'close' event - client disconnect
- Scenarios:
  - Given active connection, When client disconnects, Then disconnect callback sent with reason "client_closed", token removed from Map (`sse.test.ts:268-308`) — **FAILING**: Cannot establish connection to test disconnect
  - Given disconnect callback fails, When client disconnects, Then cleanup still completes (`sse.test.ts:310-331`) — **FAILING**: Same root cause
- Hooks: `request(app).get('/sse/...').timeout(200)` triggers disconnect via timeout
- Gaps: **Disconnect tests cannot run** because connection establishment (prerequisite) fails. Tests are correctly designed but blocked by Blocker issue.
- Evidence: Test expects `connectCallbacks.length >= 1` but receives 0 (`sse.test.ts:279`)

---

- Surface: Race condition - client disconnects during callback
- Scenarios:
  - Given callback has delay, When client disconnects before callback completes, Then connection not added to Map, no disconnect callback sent (`sse.test.ts:335-361`) — **PASSING**
- Hooks: `mockServer.setDelay(200)` creates window for disconnect, `request(...).timeout(100)` aborts early
- Gaps: None — race condition handling works correctly
- Evidence: Test passes, proving `disconnected` flag prevents orphaned Map entries when client disconnects during async callback

---

## 7) Adversarial Sweep (must attempt ≥3 credible failures or justify none)

**Attempted Attack 1: Memory leak from unclosed timers**

- Check: `src/routes/sse.ts:180-182` clears heartbeat timer on disconnect. For this feature, timer is always null (`src/routes/sse.ts:82`), so no timers created.
- Evidence: `src/connections.ts:24` defines `heartbeatTimer: NodeJS.Timeout | null`, set to null in `src/routes/sse.ts:82`, cleared (when not null) in disconnect handler. Plan Section 6 states heartbeat deferred to future feature.
- Why code held up: No timers created = no timers leaked. The null-check before `clearTimeout` is defensive and future-proof. When heartbeats are implemented, the cleanup logic is already in place.

---

**Attempted Attack 2: Connection Map grows unbounded if disconnect events don't fire**

- Check: If Express 'close' event fails to fire, connections remain in Map forever, causing memory leak. Tested by checking if successful connections are removed from Map.
- Evidence: Test `sse.test.ts:310-331` verifies cleanup even when disconnect callback fails (mock server stopped). Test expects `connections.has(token)` to be false after disconnect, but test is **FAILING** due to Blocker (cannot establish connection).
- Why code held up partially: Cleanup logic exists (`src/routes/sse.ts:185`) and would work if connections were established. However, **CANNOT VERIFY** cleanup actually runs because connection establishment is broken. This is a **latent risk** — if Express 'close' event proves unreliable in production, Map will leak memory. Recommendation: Add server-side timeout per connection (e.g., max 1 hour) to force cleanup even without 'close' event.

---

**Attempted Attack 3: Concurrent disconnects during cleanup could cause race condition**

- Check: If 'close' event fires twice for same token (or fires while disconnect callback is in flight), could cause double-cleanup or crash.
- Evidence: `src/routes/sse.ts:175` checks `hasConnection(token)` before cleanup, providing idempotency. If connection already removed, handler returns early (line 203-213 handles case where token not in Map). Disconnect callback is fire-and-forget (`src/routes/sse.ts:192-202`), so concurrent calls would send duplicate callbacks but not crash.
- Why code held up: Idempotency check prevents double-cleanup. Map.delete() is safe to call multiple times (returns false on second call). Worst case: duplicate disconnect callbacks sent to Python (acceptable per "best-effort" design).

---

**Attempted Attack 4: Header injection via malicious header values**

- Check: If client sends headers with newlines or other control characters, could break SSE format or inject malicious content into Python callback.
- Evidence: `src/routes/sse.ts:63-67` filters headers using `Object.entries(req.headers).filter(...)`. Express itself parses headers and would reject malformed HTTP headers before reaching application code. The gateway forwards headers as-is to Python in JSON payload (`src/callback.ts:139`). SSE response headers are set with hardcoded values (`src/routes/sse.ts:141-144`), not derived from client input.
- Why code held up: Express HTTP parser is the security boundary. By the time headers reach route handler, they're already validated. JSON.stringify in callback payload escapes any special characters. No direct interpolation of header values into SSE stream.

---

## 8) Invariants Checklist (stacked entries)

- Invariant: If a token exists in the connections Map, then the ConnectionRecord.disconnected flag must be false
  - Where enforced: `src/routes/sse.ts:132-138` — Before adding connection to Map, checks `if (connectionRecord.disconnected)` and skips insertion if true. `src/routes/sse.ts:206` sets `disconnected = true` only when connection is NOT in Map.
  - Failure mode: If `addConnection` called without checking `disconnected` flag, could add closed connection to Map, creating orphan entry that never gets cleaned up (memory leak).
  - Protection: Single code path adds to Map (`src/routes/sse.ts:151`), guarded by `if (!connectionRecord.disconnected)` check (line 132). Disconnect handler checks `hasConnection(token)` before setting `disconnected` flag (line 175 vs. 206).
  - Evidence: `src/routes/sse.ts:132-138` and `src/routes/sse.ts:203-213` enforce this invariant through mutually exclusive logic branches.

---

- Invariant: For every connection added to the Map, a connect callback must have returned 2xx status
  - Where enforced: `src/routes/sse.ts:100-129` — Connection only added if `callbackResult.success === true`. If callback fails (non-2xx, timeout, network error), code returns early without calling `addConnection`.
  - Failure mode: If connection added before callback completes, Python backend never receives connect notification, leading to orphaned connection that Python doesn't know about. Events sent via `/internal/send` would fail with 404.
  - Protection: Sequential flow: callback first (line 93-97), result check (line 100), early return on failure (line 128), add to Map only after success (line 151). The `await` on line 93 ensures callback completes before proceeding.
  - Evidence: `src/routes/sse.ts:93-151` — Linear flow with no parallel branches. Plan Section 5 explicitly requires "callback FIRST, then headers."

---

- Invariant: Every connection removed from the Map must trigger a disconnect callback to Python (unless connection was never added)
  - Where enforced: `src/routes/sse.ts:175-197` — If `hasConnection(token)` is true, disconnect callback sent (line 192-202).
  - Failure mode: If connection removed without disconnect callback, Python backend thinks connection still active. Python may send events to closed tokens, wasting resources. /internal/send would return 404, causing Python errors.
  - Protection: Idempotent cleanup: `hasConnection` check ensures disconnect callback only sent for connections that were in Map. Early disconnect path (line 203-213) doesn't send callback because connection was never established in Python.
  - Evidence: `src/routes/sse.ts:169-214` — Two branches: token in Map (send callback), token not in Map (don't send callback). Best-effort semantics allow callback to fail without retrying (line 192-202 catch block).

---

## 9) Questions / Needs-Info

- Question: Is the Blocker issue (connections closing immediately) specific to the test harness (Supertest), or will it occur in production with real browsers/HTTP clients?
- Why it matters: If this is a Supertest limitation, production may work fine and only tests need fixing (change to native http.request or different client). If this is an Express 5 SSE incompatibility, the entire implementation approach is wrong and needs fundamental changes (different framework or Express configuration).
- Desired answer: Evidence from production-like environment (e.g., manual curl test, browser EventSource test) showing SSE connections stay open and receive events. Or confirmation that Express 5 requires specific configuration for SSE (e.g., `res.flushHeaders()` isn't sufficient).

---

- Question: Should disconnect callback failures block connection cleanup, or is fire-and-forget the correct design?
- Why it matters: Current implementation doesn't await disconnect callback (`src/routes/sse.ts:192-202`), which may cause promise leaks and test harness warnings ("worker process failed to exit gracefully"). However, awaiting could delay cleanup if Python backend is slow/down. Plan states "best-effort" but doesn't specify blocking vs. non-blocking.
- Desired answer: Explicit decision from product owner or architect: either (1) "await disconnect callback to ensure delivery, accept cleanup latency" or (2) "fire-and-forget is correct, fix test harness to handle dangling promises."

---

- Question: What is the expected behavior when req.url is empty/undefined? Current implementation uses '/sse/unknown' as fallback.
- Why it matters: `src/routes/sse.ts:59` has defensive fallback `req.url || '/sse/unknown'`, but Express should always populate req.url for valid HTTP requests. If this fallback ever triggers, it indicates malformed request that maybe should be rejected with 400 instead of silently accepting with placeholder URL. Python backend may make routing decisions based on URL.
- Desired answer: Confirmation that fallback is acceptable, or clarification that 400 Bad Request should be returned if req.url is missing (indicating client protocol violation).

---

## 10) Risks & Mitigations (top 3)

- Risk: SSE connections close immediately in production, preventing any long-lived streams (same as Blocker finding)
- Mitigation: Before merging, validate SSE functionality in production-like environment. Test with real browsers using EventSource API, curl with --no-buffer flag, or native Node.js HTTP client. If tests pass but Supertest fails, replace Supertest with manual HTTP requests in test suite. If both fail, investigate Express 5 SSE configuration or consider alternative framework (Fastify, raw Node.js http).
- Evidence: Blocker finding in Section 3, test failures in Section 6 (`sse.test.ts:50-88` and 9 other tests).

---

- Risk: Disconnect callbacks may not send reliably due to fire-and-forget promise handling, causing Python backend state drift
- Mitigation: Either (1) change `src/routes/sse.ts:192-202` to await disconnect callback, accepting increased cleanup latency, or (2) implement promise tracking during shutdown (add disconnect promises to a Set, await Promise.allSettled on server close). Option 1 is simpler and aligns with "best-effort" semantics (try sincerely, but don't retry on failure).
- Evidence: Major finding in Section 3, Jest warning "worker process failed to exit gracefully" indicating leaked promises.

---

- Risk: Memory leak if Express 'close' event doesn't fire reliably, causing connections Map to grow unbounded
- Mitigation: Add server-side connection timeout (e.g., 1 hour max per connection). Implement periodic sweep (every 5 minutes) to remove stale connections where response object is no longer writable. Add monitoring for connections Map size with alerts if exceeds expected threshold (e.g., >10,000 connections).
- Evidence: Adversarial Sweep Section 7 (Attack 2), inability to verify cleanup in tests due to Blocker issue.

---

## 11) Confidence

Confidence: Medium — The implementation demonstrates solid understanding of async patterns, race condition handling, and error classification. The architectural separation (connections, callbacks, routes) is clean and testable. However, the Blocker issue preventing 11 tests from passing undermines confidence in the core functionality. Until SSE connections can be established and verified in a real (non-Supertest) environment, confidence remains medium. The code appears correct in design but unproven in execution.
