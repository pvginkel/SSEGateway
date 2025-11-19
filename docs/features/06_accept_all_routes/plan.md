# Implementation Plan: Accept All Routes for SSE Connections

## 0) Research Log & Findings

### Research Areas

**Codebase exploration:**
- Examined `/work/src/routes/sse.ts` (lines 1-244) to understand current route handling
- Reviewed integration tests in `/work/__tests__/integration/sse.test.ts` to understand test patterns
- Reviewed unit tests in `/work/__tests__/unit/sse.test.ts` to understand formatting tests
- Checked `/work/docs/product_brief.md` for documentation references to `/sse/` routes
- Searched codebase for all occurrences of `/sse/` pattern

**Key findings:**
- Current route pattern: `router.get(/^\/sse\/.*/, ...)` at line 46 in `src/routes/sse.ts`
- Route comment at line 35 states: "GET /sse/* - SSE connection endpoint (accepts any path under /sse/)"
- Product brief (lines 81-102) mentions "GET /sse/<any-path-and-query>" and routing rules
- All integration tests use `/sse/` prefixed routes (e.g., `/sse/channel/updates`, `/sse/test`)
- No other code depends on the specific `/sse/` prefix pattern
- URL is already forwarded raw to Python callback without parsing
- Express router order: health → SSE → internal routes (in `src/server.ts`)

**Conflicts identified and resolved:**
1. **Route collision risk**: Changing to `/.*/` could match health/internal routes
   - **Resolution**: Express evaluates routes in order; SSE router registered after health router, so `/healthz` and `/readyz` remain protected
   - **Verification needed**: Ensure `/internal/send` doesn't match SSE pattern (it's registered after SSE router as separate router)

2. **Documentation consistency**: Multiple files reference `/sse/` prefix
   - **Resolution**: Update both code comments and product brief as specified in change brief
   - **Files**: `src/routes/sse.ts` (line 35), `docs/product_brief.md` (lines 81-102)

3. **Test coverage**: All existing tests use `/sse/` paths
   - **Resolution**: Add new test for non-`/sse/` route while keeping existing tests (backwards compatibility verification)

### Router Registration Order (Critical)

From `src/server.ts`:
```typescript
app.use(healthRouter);    // /healthz, /readyz
app.use(sseRouter);       // Will change to /.*
app.use(internalRouter);  // /internal/*
```

**Analysis**: The new pattern `/.*/` will NOT capture health endpoints because they're registered first. However, it WILL capture any routes not matched by health endpoints, including `/internal/send`. This is acceptable because:
- Internal routes are registered as a separate router after SSE router
- Express routers are separate middleware - they don't conflict
- The `/internal/send` endpoint is POST, SSE endpoint is GET only

**Verification**: Router order is safe. No conflicts detected.

## 1) Intent & Scope

**User intent**

Remove the artificial `/sse/` path restriction from the SSE connection endpoint to allow the Python backend full control over route design. The gateway should accept SSE connections on any path and delegate authorization decisions to the Python callback handler.

**Prompt quotes**

"Accept SSE connections on **any route**, not just those under `/sse/`"

"The Python backend should control which routes are valid (via connect callback authorization), not the gateway itself."

"Change the SSE endpoint route pattern from `/^\/sse\/.*/` to `/^\/.*` / to accept connections on any path."

**In scope**

- Change route regex pattern from `/^\/sse\/.*/` to `/^\/.*/` in `src/routes/sse.ts`
- Update code comment at line 35 to reflect acceptance of any path
- Update `docs/product_brief.md` to remove `/sse/` path restriction (section 3.1)
- Add integration test verifying non-`/sse/` routes work (e.g., `GET /events/stream`)
- Verify all existing tests continue to pass (backwards compatibility)
- Update CLAUDE.md to reflect "Accept ANY path without parsing" principle

**Out of scope**

- Changing how URLs are forwarded to Python (already raw and unchanged)
- Adding route filtering/validation logic (remains Python's responsibility via callback)
- Modifying callback contract or payload structure
- Changing other endpoints (`/healthz`, `/readyz`, `/internal/*`)
- Modifying SSE event formatting or connection lifecycle behavior
- Adding new authorization mechanisms to the gateway

**Assumptions / constraints**

- Express router registration order remains unchanged (health → SSE → internal)
- Health endpoints (`/healthz`, `/readyz`) remain unaffected due to router order
- Internal endpoints (`/internal/*`) registered as separate router, no conflict
- Python backend callback logic can handle authorization for any route pattern
- Existing deployed clients using `/sse/` paths will continue to work
- The change is backwards compatible - no breaking changes to API contract
- **Product owner approval**: User (product owner) has confirmed requirement to accept all routes, not just `/sse/*` - this updates the product brief specification intentionally

## 2) Affected Areas & File Map

- **Area**: `src/routes/sse.ts` - Route pattern and documentation
  - **Why**: Contains the route regex that must change from `/^\/sse\/.*/` to `/^\/.*/`
  - **Evidence**: `src/routes/sse.ts:46` - `router.get(/^\/sse\/.*/, async (req: Request, res: Response) => {`

- **Area**: `src/routes/sse.ts` - Route handler comment
  - **Why**: Documentation comment must reflect acceptance of any path, not just `/sse/*`
  - **Evidence**: `src/routes/sse.ts:35` - `* GET /sse/* - SSE connection endpoint (accepts any path under /sse/)`

- **Area**: `docs/product_brief.md` - Section 3.1 SSE Endpoint specification
  - **Why**: Product specification documents the `/sse/` prefix requirement which is being removed
  - **Evidence**: `docs/product_brief.md:82-92` - Route specification states `GET /sse/<any-path-and-query>` and "Accept **any** path under `/sse/`"

- **Area**: `CLAUDE.md` - Architecture Principles / SSE Endpoint section
  - **Why**: Project guide documents the route acceptance policy that is changing
  - **Evidence**: `CLAUDE.md:17-18` - "Accept **ANY** path under `/sse/` - do NOT parse or validate" should become "Accept **ANY** path"

- **Area**: `__tests__/integration/sse.test.ts` - Test suite addition
  - **Why**: Must add test case verifying non-`/sse/` routes are accepted
  - **Evidence**: `__tests__/integration/sse.test.ts:49-194` - All existing tests use `/sse/` paths; new test needed for routes like `/events/stream`

## 3) Data Model / Contracts

No data model or contract changes are required for this feature. This is a route pattern change only.

**Unchanged contracts:**

- **Entity / contract**: SSE Connection Callback Request
  - **Shape**:
    ```json
    {
      "action": "connect",
      "token": "uuid-string",
      "request": {
        "url": "string",  // Already raw, unchanged
        "headers": { "header": "value" }
      }
    }
    ```
  - **Refactor strategy**: No changes - URL field already contains raw path without validation
  - **Evidence**: `src/routes/sse.ts:57-73` - URL extraction and callback preparation already work with any path

- **Entity / contract**: ConnectionRecord interface
  - **Shape**: Interface remains unchanged - stores raw URL and headers regardless of path pattern
  - **Refactor strategy**: No changes needed - connection state storage is path-agnostic
  - **Evidence**: `src/connections.ts` (referenced in imports at `src/routes/sse.ts:12-18`)

## 4) API / Integration Surface

- **Surface**: `GET /*` (previously `GET /sse/*`) - SSE connection endpoint
  - **Inputs**:
    - Path: Any valid HTTP path (was: paths under `/sse/`)
    - Query string: Preserved verbatim (unchanged)
    - Headers: Forwarded raw (unchanged)
  - **Outputs**:
    - Success (2xx from callback): SSE stream with `Content-Type: text/event-stream`
    - Rejection (non-2xx from callback): HTTP error with JSON body (unchanged behavior)
    - Configuration error: 503 if `CALLBACK_URL` not set (unchanged)
  - **Errors**:
    - 401/403 - Python callback rejects authorization
    - 500 - Python callback returns server error
    - 503 - Backend unavailable or not configured
    - 504 - Callback timeout (>5s)
    - All error handling unchanged, only route pattern differs
  - **Evidence**: `src/routes/sse.ts:46-186` - Complete handler implementation

- **Surface**: Python Callback `POST {CALLBACK_URL}` - Connect notification
  - **Inputs**:
    ```json
    {
      "action": "connect",
      "token": "string",
      "request": {
        "url": "string",  // Can now be any path, not just /sse/*
        "headers": { ... }
      }
    }
    ```
  - **Outputs**: HTTP status code determines acceptance (2xx = accept, non-2xx = reject)
  - **Errors**: Network errors result in 503 to client
  - **Evidence**: `src/routes/sse.ts:92-97` - Callback invocation; behavior unchanged, only input URL can vary more widely

## 5) Algorithms & State Machines (step-by-step)

No algorithmic changes are required. The connection lifecycle remains identical regardless of route pattern.

**Unchanged flow:**

- **Flow**: SSE Connection Establishment
  - **Steps**:
    1. Client sends `GET <any-path>` (was: `GET /sse/<path>`)
    2. Gateway validates `CALLBACK_URL` configured
    3. Gateway generates UUID token
    4. Gateway extracts raw URL and headers (unchanged logic)
    5. Gateway registers 'close' event listener
    6. Gateway sends connect callback to Python with full URL
    7. Python returns 2xx (accept) or non-2xx (reject)
    8. If accepted: Set SSE headers, open stream, start heartbeat
    9. If rejected: Return error status to client
  - **States / transitions**: Connection states (pending → established → disconnected) unchanged
  - **Hotspots**: No performance impact - pattern matching slightly broader but negligible
  - **Evidence**: `src/routes/sse.ts:46-186` - Complete flow implementation

## 6) Derived State & Invariants

No derived state or invariants are affected by this change. The route pattern does not influence state management.

**Unchanged invariants:**

- **Derived value**: Connection token
  - **Source**: `crypto.randomUUID()` - generation unchanged
  - **Writes / cleanup**: Stored in `Map<token, ConnectionRecord>` - storage unchanged
  - **Guards**: Connection only added to Map after successful callback
  - **Invariant**: Each token maps to exactly one connection; token uniqueness preserved
  - **Evidence**: `src/routes/sse.ts:55` - Token generation

- **Derived value**: Raw request URL
  - **Source**: `req.url` from Express request object
  - **Writes / cleanup**: Stored in connection record, forwarded to Python in callbacks
  - **Guards**: URL extracted verbatim without validation (behavior unchanged, just broader set of valid inputs)
  - **Invariant**: URL in callbacks exactly matches client request URL
  - **Evidence**: `src/routes/sse.ts:57-59` - URL extraction logic

- **Derived value**: Heartbeat timer
  - **Source**: `setInterval()` after successful connection
  - **Writes / cleanup**: Stored in ConnectionRecord, cleared on disconnect
  - **Guards**: Timer only created after callback success and stream establishment
  - **Invariant**: Each active connection has exactly one heartbeat timer; cleared before Map removal
  - **Evidence**: `src/routes/sse.ts:154-182` - Heartbeat timer creation

## 7) Consistency, Transactions & Concurrency

No consistency, transaction, or concurrency changes. This is a stateless route pattern modification.

- **Transaction scope**: No transactional operations - single-threaded event loop handles requests
- **Atomic requirements**: None - connection state management unchanged
- **Retry / idempotency**: No retry logic changes - callback remains best-effort
- **Ordering / concurrency controls**: Node.js event loop serialization unchanged
- **Evidence**: `src/routes/sse.ts:46-186` - Handler remains synchronous with async callback

## 8) Errors & Edge Cases

All error handling remains unchanged. The route pattern change does not introduce new error cases.

**Unchanged error cases:**

- **Failure**: Unknown/invalid route path
  - **Surface**: Previously: 404 for non-`/sse/` paths; Now: All paths routed to SSE handler, Python callback decides validity
  - **Handling**: Python callback can return 404 or other appropriate error if path is invalid
  - **Guardrails**: No validation at gateway level (intentional - moves control to Python)
  - **Evidence**: `src/routes/sse.ts:100-129` - Callback failure handling

- **Failure**: `CALLBACK_URL` not configured
  - **Surface**: SSE endpoint (`GET /*`)
  - **Handling**: 503 error with `{"error": "Service not configured"}`
  - **Guardrails**: Check at line 48 prevents connection without callback URL
  - **Evidence**: `src/routes/sse.ts:47-52`

- **Failure**: Callback timeout (>5s)
  - **Surface**: SSE endpoint during connection establishment
  - **Handling**: 504 error with `{"error": "Gateway timeout"}`
  - **Guardrails**: 5-second timeout enforced in callback implementation
  - **Evidence**: `src/routes/sse.ts:105-108`

- **Failure**: Callback returns non-2xx
  - **Surface**: SSE endpoint during connection establishment
  - **Handling**: Return same status code to client (e.g., 401, 403, 500)
  - **Guardrails**: Connection not added to Map; client receives error immediately
  - **Evidence**: `src/routes/sse.ts:109-129`

**New consideration:**

- **Failure**: Route collision with health/internal endpoints
  - **Surface**: Pattern `/.*/` matches all routes, but Express router order prevents issues
  - **Handling**: Health router registered first, so `/healthz` and `/readyz` unreachable by SSE handler
  - **Guardrails**: Router registration order in `src/server.ts` must remain unchanged
  - **Evidence**: `src/server.ts:26-36` - Router registration order

## 9) Observability / Telemetry

No changes to logging or telemetry. All log messages remain unchanged.

**Unchanged signals:**

- **Signal**: New SSE connection log
  - **Type**: Structured log (INFO level)
  - **Trigger**: Every new connection attempt
  - **Labels / fields**: `token=<uuid>`, `url=<raw-path>` (URL can now be any path)
  - **Consumer**: Application logs, debugging
  - **Evidence**: `src/routes/sse.ts:76` - `logger.info('New SSE connection: token=${token} url=${url}')`

- **Signal**: SSE connection rejected log
  - **Type**: Structured log (ERROR level)
  - **Trigger**: Callback failure or rejection
  - **Labels / fields**: `token=<uuid>`, `status=<code>`, `error=<message>`
  - **Consumer**: Application logs, monitoring for authorization failures
  - **Evidence**: `src/routes/sse.ts:119-121`

- **Signal**: Connection established log
  - **Type**: Structured log (INFO level)
  - **Trigger**: After successful callback and stream opening
  - **Labels / fields**: `token=<uuid>`, `heartbeatInterval=<seconds>`
  - **Consumer**: Application logs, debugging
  - **Evidence**: `src/routes/sse.ts:184-186`

## 10) Background Work & Shutdown

No changes to background work or shutdown handling. Heartbeat timers operate identically.

- **Worker / job**: Heartbeat timer per connection
  - **Trigger cadence**: Interval-driven (default: 15 seconds, configurable via `HEARTBEAT_INTERVAL_SECONDS`)
  - **Responsibilities**: Send `: heartbeat\n\n` comment to keep connection alive
  - **Shutdown handling**: Timer cleared when connection closes (via 'close' event)
  - **Evidence**: `src/routes/sse.ts:154-182` - Heartbeat timer creation and error handling

## 11) Security & Permissions

This change enhances security separation by moving authorization fully to Python backend.

- **Concern**: Route-based authorization moved from gateway to backend
  - **Touchpoints**:
    - Gateway: Previously rejected non-`/sse/` routes at routing level
    - Now: Gateway accepts all routes, Python callback performs authorization
  - **Mitigation**:
    - Python callback receives full URL and headers to make authorization decisions
    - Gateway remains stateless and authorization-agnostic (per design principle)
    - Non-2xx callback response immediately closes connection
  - **Residual risk**: None - this is the intended design. Python backend already had full control via callback response; removing `/sse/` prefix restriction simply makes this explicit
  - **Evidence**: `src/routes/sse.ts:92-129` - Callback result handling enforces authorization

- **Concern**: Route collision / path traversal
  - **Touchpoints**: Express routing layer
  - **Mitigation**:
    - Health endpoints protected by router registration order
    - Internal endpoints on separate router (POST vs GET method separation)
    - URL forwarded raw but not executed - Python interprets
  - **Residual risk**: Minimal - Express routing and URL parsing are well-tested; no dynamic path execution
  - **Evidence**: `src/server.ts:26-36` - Router registration order

## 12) UX / UI Impact

Not applicable - this is a backend service change with no user interface.

## 13) Deterministic Test Plan

### Surface: SSE Connection Endpoint (`GET /*`)

**Scenarios:**

- **Given** SSE gateway is running with valid `CALLBACK_URL`
  **When** client sends `GET /events/stream` (non-`/sse/` path)
  **Then** gateway accepts connection, forwards URL to Python callback, and opens SSE stream if callback returns 200

- **Given** SSE gateway is running
  **When** client sends `GET /api/v1/notifications/live`
  **Then** callback receives full URL `/api/v1/notifications/live` verbatim, including path segments

- **Given** existing client using legacy `/sse/` routes
  **When** client sends `GET /sse/channel/updates`
  **Then** connection works identically to before (backwards compatibility)

- **Given** Python callback rejects non-`/sse/` route with 404
  **When** client sends `GET /invalid/route`
  **Then** gateway returns 404 to client and does not add connection to Map

- **Given** health endpoints registered before SSE router
  **When** client sends `GET /healthz`
  **Then** health endpoint responds, SSE handler never invoked

**Fixtures / hooks:**

- Reuse existing MockServer from `__tests__/utils/mockServer.js`
- Reuse existing test setup from `__tests__/integration/sse.test.ts`
- Add new test case in "Successful connection establishment" describe block
- Test case structure: start connection, verify callback payload, verify connection established, abort and cleanup

**Gaps:**

- No exhaustive testing of all possible route patterns (infinite set)
- Justification: Integration test with one non-`/sse/` example (e.g., `/events/stream`) proves pattern works; existing tests prove backwards compatibility

**Evidence:**

- `__tests__/integration/sse.test.ts:49-194` - Existing test patterns for connection establishment
- `__tests__/utils/mockServer.js` - Mock server implementation (imported in tests)

### Test Implementation Details

**New test to add:**

```typescript
describe('Successful connection establishment', () => {
  // ... existing tests ...

  it('should accept non-/sse/ routes (e.g., /events/stream)', async () => {
    // Start SSE connection on non-/sse/ path
    const req = request(app).get('/events/stream?channel=notifications');
    const responsePromise = req.then(() => {}, () => {});

    // Wait for connection to be established and callback to be sent
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Verify connect callback was sent with full URL
    const callbacks = mockServer.getCallbacks();
    const connectCallback = callbacks.find(
      (cb) => cb.action === 'connect' && cb.request.url === '/events/stream?channel=notifications'
    );
    expect(connectCallback).toBeDefined();
    expect(connectCallback!.token).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );

    // Verify connection is stored in Map
    expect(connections.has(connectCallback!.token)).toBe(true);

    // Abort and cleanup
    req.abort();
    await responsePromise;
  });
});
```

**Location:** `__tests__/integration/sse.test.ts` - add after line 113 (after existing "should accept any path under /sse/" test)

**Additional backwards compatibility test:**

```typescript
  it('should still accept /sse/ routes (backwards compatibility)', async () => {
    // Verify existing /sse/ paths continue to work after pattern change
    const req = request(app).get('/sse/legacy/endpoint?param=value');
    const responsePromise = req.then(() => {}, () => {});

    await new Promise((resolve) => setTimeout(resolve, 200));

    // Verify connect callback was sent with /sse/ URL
    const callbacks = mockServer.getCallbacks();
    const connectCallback = callbacks.find(
      (cb) => cb.action === 'connect' && cb.request.url === '/sse/legacy/endpoint?param=value'
    );
    expect(connectCallback).toBeDefined();
    expect(connections.has(connectCallback!.token)).toBe(true);

    // Abort and cleanup
    req.abort();
    await responsePromise;
  });
```

**Location:** `__tests__/integration/sse.test.ts` - add after the non-`/sse/` test above

**Justification:** Existing tests use `/sse/` paths, but they don't explicitly verify backwards compatibility as a test goal. This test makes the backwards compatibility requirement explicit and prevents accidental regressions.

## 14) Implementation Slices

This is a small change that should be implemented as a single atomic unit.

- **Slice**: Complete route pattern change with tests and documentation
  - **Goal**: Accept all routes, update documentation, verify with tests
  - **Touches**:
    - `src/routes/sse.ts` (lines 35, 46)
    - `docs/product_brief.md` (section 3.1, lines 81-102)
    - `CLAUDE.md` (SSE Endpoint section, lines 17-18)
    - `__tests__/integration/sse.test.ts` (add new test case)
  - **Dependencies**: None - change is self-contained and backwards compatible

**Implementation order:**

1. Update route pattern and comment in `src/routes/sse.ts`
2. Add integration test for non-`/sse/` route
3. Run all tests to verify backwards compatibility
4. Update `docs/product_brief.md` to remove `/sse/` restriction
5. Update `CLAUDE.md` to reflect new routing policy

## 15) Risks & Open Questions

**Risks:**

- **Risk**: Route collision with internal endpoints
  - **Impact**: If SSE route handler captures `/internal/send`, the send endpoint would break
  - **Mitigation**: Express routers are separate middleware; `/internal/send` is POST method, SSE is GET only - no collision possible

- **Risk**: Backwards compatibility broken for existing clients
  - **Impact**: If route pattern change somehow rejects `/sse/` paths, deployed clients fail
  - **Mitigation**: Pattern `/.*/` is superset of `/^\/sse\/.*/` - all existing paths still match; existing integration tests verify this

- **Risk**: Python backend not prepared for arbitrary routes
  - **Impact**: Backend callback logic may not handle non-`/sse/` routes correctly
  - **Mitigation**: Backend already receives raw URL and makes authorization decisions; this change just removes artificial restriction. Backend can reject unwanted routes via non-2xx response

- **Risk**: Increased attack surface for malformed URLs
  - **Impact**: Gateway might receive unexpected URL patterns
  - **Mitigation**: URL already forwarded raw without parsing; Express handles URL parsing safely; Python backend validates and authorizes. No new parsing or execution added

**Open Questions:**

None. All implementation details are clear from the change brief and codebase research.

## 16) Confidence

Confidence: **High** — This is a simple regex pattern change with clear scope, minimal code impact, comprehensive existing test coverage, and no new complexity. The change is backwards compatible by design (new pattern is a superset of old pattern), and Express router order prevents any route collision issues. All error handling, state management, and business logic remain unchanged.
