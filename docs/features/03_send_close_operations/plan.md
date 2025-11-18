# Implementation Plan: Send & Close Operations

## 0) Research Log & Findings

**Codebase Structure Analysis:**
- The project has a working SSE connect flow with connection state management in `src/connections.ts`
- Callback infrastructure exists in `src/callback.ts` with `sendConnectCallback` and `sendDisconnectCallback`
- Connection records are stored in a `Map<string, ConnectionRecord>` with token as key
- SSE endpoint exists at `src/routes/sse.ts` handling `GET /sse/*` with full lifecycle
- Express app structure in `src/server.ts` registers routers via `createApp()` factory pattern
- Integration tests use MockServer utility to simulate Python backend callbacks
- Logger provides plain text format with severity prefixes

**Key Architectural Findings:**
- ConnectionRecord interface already includes `res: Response` for writing to SSE streams
- The `res` object must support immediate flushing after writes (per CLAUDE.md)
- Node.js event loop automatically serializes events for a single token
- All state is in-memory - no persistence layer needed
- Response 'close' event is already wired for disconnect detection
- Callback module uses native fetch() API with 5-second timeout

**SSE Specification Requirements (from CLAUDE.md and product_brief.md):**
- Event format must follow full SSE spec: `event: <name>\ndata: <line1>\ndata: <line2>\n\n`
- Multi-line data must be split and sent as separate `data:` lines
- Each event must end with a blank line (`\n\n`)
- Every write must flush immediately to prevent buffering
- No compression allowed on SSE output

**Integration Points Identified:**
- `src/server.ts` needs new `/internal/send` route registration
- ConnectionRecord.res provides access to Express response object for writing
- Disconnect flow already sends callback via `sendDisconnectCallback` with reason parameter
- Logger already supports info() and error() methods for all logging needs

**Conflicts & Resolutions:**
- No conflicts - the change brief aligns perfectly with existing architecture
- Close operation requires calling existing `sendDisconnectCallback` with `reason: "server_closed"`
- Write failures should trigger disconnect with `reason: "error"` (new disconnect reason)
- Heartbeat timer clearing is already handled in existing disconnect logic

---

## 1) Intent & Scope

**User intent**

Implement the internal API endpoint that allows the Python backend to send SSE events to connected clients and optionally close connections. This completes the SSE lifecycle by enabling server-to-client communication and server-initiated disconnections.

**Prompt quotes**

"Implement `POST /internal/send` endpoint that accepts token, event, and close fields"

"Implement SSE event formatting following the full SSE specification: event name line, data lines (split on newlines), blank line ending, immediate flush"

"If `close: true` is provided, terminate connection after sending event (if present)"

"Return 404 if token is unknown, 400 for invalid request types"

"If write fails, treat as disconnect with `reason: "error"` and send callback"

**In scope**

- Creating new `POST /internal/send` endpoint in `src/routes/internal.ts`
- Implementing SSE event formatting utility in `src/sse.ts` following full spec
- Validating request payload structure (token required, event/close optional)
- Looking up connections by token in the Map
- Writing formatted SSE events to response stream with immediate flush
- Implementing server-initiated close with `reason: "server_closed"`
- Handling write failures with `reason: "error"` disconnect callback
- Logging all send and close operations
- Comprehensive test coverage for event sending, closing, and error cases
- Integration with existing disconnect cleanup flow

**Out of scope**

- Heartbeat implementation (separate feature)
- Client-initiated disconnect (already implemented)
- Event buffering or queuing (contradicts immediate flush requirement)
- Event ordering validation (Node event loop guarantees ordering per token)
- Authentication or authorization on internal endpoint (assumed internal-only access)
- Metrics/monitoring integration (can be added later)
- Batching multiple events in single request (one event per request per spec)

**Assumptions / constraints**

- `/internal/send` endpoint is only accessible to Python backend (network-level access control)
- Response object for a token is always writable when in Map (if not, triggers error flow)
- Multi-line data splitting on `\n` character is sufficient (no other line terminators)
- Express response write operations are synchronous or promise-based
- Flush operation is available via `res.flush()` or similar mechanism
- Connection cleanup after close is handled by existing disconnect flow
- Write errors are detectable via try-catch or response event listeners

---

## 2) Affected Areas & File Map

- Area: `src/routes/internal.ts` (new file)
- Why: Implements the `POST /internal/send` endpoint handler with validation and token lookup
- Evidence: New file - change_brief.md line 9 "Implement `POST /internal/send` endpoint"

- Area: `src/sse.ts` (new file)
- Why: Provides SSE event formatting utilities following full SSE specification
- Evidence: New file - change_brief.md line 26 "Implement SSE event formatting following the full SSE specification"

- Area: `src/server.ts` (modification)
- Why: Register new internal routes router in Express app
- Evidence: `src/server.ts:19-31` - currently registers health and SSE routers, needs internal router added

- Area: `src/connections.ts` (no changes needed)
- Why: Already provides `getConnection()` for token lookup and connection state management
- Evidence: `src/connections.ts:64-66` - getConnection() already implemented

- Area: `src/callback.ts` (no changes needed)
- Why: Already provides `sendDisconnectCallback()` with reason parameter
- Evidence: `src/callback.ts:96-117` - sendDisconnectCallback() accepts reason parameter including "server_closed" and "error"

- Area: `src/routes/sse.ts` (reference only, no changes)
- Why: Contains existing disconnect handling pattern to follow for close operation
- Evidence: `src/routes/sse.ts:169-210` - handleDisconnect() function shows cleanup pattern

- Area: `__tests__/integration/send.test.ts` (new file)
- Why: Integration tests for /internal/send endpoint covering send, close, and error scenarios
- Evidence: New file - change_brief.md line 63 "Tests cover event sending, closing, multiline data, and error cases"

- Area: `__tests__/utils/sseParser.ts` (new file)
- Why: Utility to parse SSE event stream for test assertions
- Evidence: New file - needed to verify SSE event formatting correctness in tests

---

## 3) Data Model / Contracts

- Entity / contract: SendRequest payload
- Shape:
```typescript
interface SendRequest {
  token: string;          // required - UUID of target connection
  event?: {               // optional - SSE event to send
    name?: string;        // optional - event type name
    data: string;         // required if event present - event data (may contain newlines)
  };
  close?: boolean;        // optional - whether to close connection after event
}
```
- Refactor strategy: New type definition, no backwards compatibility needed. Unknown fields in request body are ignored per spec. Validation ensures token is string, event.data is string (if event present), close is boolean (if present).
- Evidence: change_brief.md lines 10-24 defines exact payload structure

- Entity / contract: SendResponse (success)
- Shape:
```json
{
  "status": "ok"
}
```
- Refactor strategy: Simple success response, 200 status code. For close operation, response sent before connection is terminated.
- Evidence: Standard practice for internal API endpoints

- Entity / contract: SendResponse (error)
- Shape:
```json
{
  "error": "Token not found"
}
```
- Refactor strategy: Error responses use appropriate HTTP status codes (404 for unknown token, 400 for invalid types). Error object contains descriptive message.
- Evidence: change_brief.md lines 47-49 specifies error handling

- Entity / contract: SSE Event Format (wire format)
- Shape:
```
event: message
data: First line
data: Second line

```
- Refactor strategy: Follows RFC SSE specification exactly. Event name line is optional (only if `event.name` provided). Data is split on `\n` and each line prefixed with `data: `. Event ends with blank line (`\n\n`). Immediate flush after write.
- Evidence: change_brief.md lines 26-30 and CLAUDE.md lines 56-62 specify full SSE format

---

## 4) API / Integration Surface

- Surface: `POST /internal/send`
- Inputs: JSON payload with token (required), event (optional), close (optional). Content-Type: application/json.
- Outputs:
  - 200 OK with `{"status": "ok"}` if operation succeeds
  - 404 Not Found with `{"error": "Token not found"}` if token is unknown
  - 400 Bad Request with `{"error": "Invalid request"}` if payload validation fails
  - 500 Internal Server Error if write operation fails (rare - would trigger error disconnect)
- Errors:
  - Token not in Map → 404 (connection doesn't exist or already closed)
  - Invalid JSON → 400 (Express json parser handles this)
  - Missing token field → 400
  - Invalid types (token not string, event.data not string, close not boolean) → 400
  - Write failure (res.write throws or returns false) → log error, send disconnect callback with reason "error", return 500
- Evidence: change_brief.md lines 9-50 defines endpoint contract

- Surface: SSE event stream writes (to client)
- Inputs: Event object with optional name and required data string
- Outputs: Formatted SSE event written to response stream, flushed immediately
- Errors:
  - Response stream closed → write throws or fails, triggers error disconnect
  - Flush failure → same as write failure
  - No errors bubble to caller - all handled internally with disconnect callback
- Evidence: CLAUDE.md lines 56-62 "SSE Event Formatting (STRICT)"

- Surface: Disconnect callback (existing, called with new reason values)
- Inputs: Same callback contract as existing disconnect, but with new reason values: "server_closed" (for close operation) and "error" (for write failures)
- Outputs: Best-effort POST to Python callback endpoint with disconnect payload
- Errors: Callback failures are logged only (existing behavior)
- Evidence: change_brief.md lines 35-43 and product_brief.md line 18 "reason: client_closed | server_closed | error"

---

## 5) Algorithms & State Machines

- Flow: Send Event Operation
- Steps:
  1. Express receives POST /internal/send with JSON body
  2. Express json middleware parses body into object
  3. Handler validates payload structure:
     - token field exists and is string → else return 400
     - If event field exists: event.data exists and is string → else return 400
     - If close field exists: is boolean → else return 400
  4. Handler looks up connection in Map using getConnection(token)
  5. If connection not found → return 404 with error message
  6. If event field is present:
     - Call formatSseEvent(event.name, event.data) to generate formatted string
     - Write formatted event to connection.res
     - Call connection.res.flush() to flush immediately
     - If write or flush fails → catch error, log, send disconnect callback with reason "error", remove from Map, return 500
  7. If close field is true:
     - Call handleServerClose(token, connection) to close stream
     - handleServerClose: send disconnect callback with reason "server_closed", clear heartbeat timer, remove from Map, end response stream
  8. Return 200 OK with success response
- States / transitions: Connection moves from exists-in-Map → removed-from-Map atomically during close. No intermediate states.
- Hotspots:
  - Write operation could block if client backpressure is high (Node handles this with buffering)
  - Flush must complete synchronously to ensure immediate delivery
  - Close operation must cleanup state before returning to prevent race conditions
  - Map lookup is O(1) but happens on every request
- Evidence: change_brief.md lines 34-43 "If both event and close: send event FIRST, then close"

- Flow: SSE Event Formatting
- Steps:
  1. Receive event name (string or undefined) and data (string)
  2. Initialize output string as empty
  3. If event name is defined and non-empty:
     - Append `event: ${name}\n` to output
  4. Split data on `\n` character to get array of lines
  5. For each line in array:
     - Append `data: ${line}\n` to output
  6. Append final `\n` to output (creates blank line ending)
  7. Return output string
- States / transitions: Pure function, no state changes
- Hotspots:
  - String concatenation for large data strings (could use array join for efficiency)
  - Split operation creates array of substrings (memory allocation)
  - Multi-line data with 1000+ lines could be slow (rare in SSE use case)
- Evidence: change_brief.md lines 26-30 and CLAUDE.md lines 56-62

- Flow: Server-Initiated Close
- Steps:
  1. Called with token and ConnectionRecord
  2. Clear heartbeat timer if present: `if (connection.heartbeatTimer) clearTimeout(connection.heartbeatTimer)`
  3. Remove connection from Map: removeConnection(token)
  4. Send disconnect callback to Python: await sendDisconnectCallback(callbackUrl, token, "server_closed", connection.request)
  5. End response stream: connection.res.end()
  6. Log close operation: logger.info(`Server closed connection: token=${token}`)
- States / transitions: Connection removed from Map, response stream ended. No rollback possible.
- Hotspots:
  - Disconnect callback is async (best-effort, failures logged only)
  - res.end() may fail if stream already closed (handle gracefully)
  - Must cleanup before sending callback to prevent race condition with new request
- Evidence: change_brief.md lines 33-45 and product_brief.md lines 163-166

---

## 6) Derived State & Invariants

- Derived value: Formatted SSE event string
  - Source: Filtered from event.name (optional) and event.data (required) - data is split on newlines
  - Writes / cleanup: Written to response stream via res.write(), flushed via res.flush(), no storage
  - Guards: Data splitting handles empty strings (produces single `data: \n` line), event name only included if defined
  - Invariant: Output always ends with `\n\n` (blank line). Each data line prefixed with `data: `. Event name line (if present) always comes before data lines.
  - Evidence: CLAUDE.md lines 56-62 "SSE Event Formatting (STRICT)"

- Derived value: Connection existence after close
  - Source: Unfiltered - close operation triggered by Python backend request
  - Writes / cleanup: Token removed from Map, heartbeat timer cleared, response ended, disconnect callback sent
  - Guards: Close handler checks Map.has(token) first (idempotent), timer cleared conditionally (if not null)
  - Invariant: After close completes, token is NOT in Map, response stream is ended, Python backend has received disconnect callback (best-effort)
  - Evidence: change_brief.md lines 33-45 "Remove token from connection map"

- Derived value: Write failure detection
  - Source: Filtered - res.write() or res.flush() throws exception or returns false
  - Writes / cleanup: Triggers disconnect callback with reason "error", removes from Map, logs error
  - Guards: Try-catch around write operations, check res.write() return value (boolean indicates backpressure)
  - Invariant: Any write failure results in connection cleanup and error disconnect callback. Connection is NOT left in inconsistent state.
  - Evidence: change_brief.md lines 49-50 "If write fails, treat as disconnect with `reason: "error"`"

- Derived value: Event ordering per connection
  - Source: Filtered - multiple /internal/send requests for same token
  - Writes / cleanup: No explicit ordering logic needed - Node.js event loop serializes operations for same connection
  - Guards: Single-threaded event loop, synchronous Map lookup and write operations
  - Invariant: Events for a single token are processed in request arrival order. No interleaving of event writes for same connection.
  - Evidence: CLAUDE.md line 45 "Event Loop Ordering: All events for a token are automatically serialized by Node's event loop"

---

## 7) Consistency, Transactions & Concurrency

- Transaction scope: No database transactions. Each /internal/send request is an independent operation: validate → lookup → write → (optional) close. State changes are in-memory Map operations.
- Atomic requirements:
  - Event write and flush must happen together (no partial writes visible to client)
  - Close operation must cleanup all state atomically: timer cleared, Map entry removed, response ended
  - If close fails partway through, connection is still removed from Map (no retry)
  - Write failure triggers full disconnect cleanup atomically
- Retry / idempotency:
  - No retries on write failures (client will see disconnect)
  - Python backend is responsible for retry logic if send fails
  - Sending to already-closed connection returns 404 (idempotent - no side effects)
  - Closing already-closed connection returns 404 (idempotent)
  - Disconnect callback is best-effort (failures logged, no retries)
- Ordering / concurrency controls:
  - Node.js event loop serializes all operations for a single token
  - Multiple requests for different tokens can process concurrently via event loop
  - No locks or mutexes needed due to single-threaded nature
  - Map operations are synchronous and atomic at JavaScript level
  - res.write() may buffer internally, but flush() ensures delivery
- Evidence: CLAUDE.md lines 45-46 "Event Loop Ordering" and product_brief.md lines 246-248 "Sending Events: All events for a token are serialized automatically"

---

## 8) Errors & Edge Cases

- Failure: Token not found in Map (connection doesn't exist or already closed)
- Surface: POST /internal/send endpoint
- Handling: Return 404 Not Found with `{"error": "Token not found"}`. Log warning with token. No side effects.
- Guardrails: getConnection(token) returns undefined, explicit check before any operations, Python backend should handle 404 as expected condition
- Evidence: change_brief.md line 48 "Return 404 if token is unknown"

- Failure: Invalid request payload (missing token, wrong types, invalid JSON)
- Surface: POST /internal/send endpoint
- Handling: Return 400 Bad Request with `{"error": "Invalid request"}`. Log error with details. Express json parser handles malformed JSON automatically.
- Guardrails: Explicit validation of token (string), event.data (string if event present), close (boolean if present). Type guards for TypeScript safety.
- Evidence: change_brief.md line 49 "Return 400 for invalid request types"

- Failure: Response write operation throws exception
- Surface: SSE event write in /internal/send handler
- Handling: Catch exception, log error with token and error message, send disconnect callback with reason "error", remove connection from Map, clear heartbeat timer, return 500 Internal Server Error to caller
- Guardrails: Try-catch around res.write() and res.flush(), connection cleanup ensures no leaked state, Python backend can detect failure via 500 response
- Evidence: change_brief.md line 50 "If write fails, treat as disconnect with `reason: "error"` and send callback"

- Failure: Response flush operation fails (stream closed, network error)
- Surface: SSE flush after event write
- Handling: Same as write failure - treat as disconnect with reason "error", cleanup, log, return 500
- Guardrails: Flush called immediately after write, both wrapped in same try-catch, connection state cleaned up before returning error
- Evidence: CLAUDE.md line 49 "Immediate Flushing: Every SSE write must flush immediately"

- Failure: Connection closes between lookup and write (race condition)
- Surface: POST /internal/send when client disconnects during request processing
- Handling: Write operation will fail (stream closed), caught by write error handler, triggers "error" disconnect (may be duplicate with client disconnect), cleanup is idempotent (Map.delete returns false if already removed)
- Guardrails: Disconnect handler checks Map.has(token) before cleanup (idempotent), write error handling always attempts cleanup (safe if already done)
- Evidence: Implicit from async nature of operations - Node event loop prevents interleaving within single token operations

- Failure: Close operation called when connection already closed
- Surface: POST /internal/send with close: true
- Handling: Token lookup returns undefined, return 404 before attempting close. No duplicate disconnect callback sent.
- Guardrails: Close operation never reached if token not in Map, 404 response indicates connection gone
- Evidence: Standard error handling flow - lookup before operation

- Failure: Event data is empty string
- Surface: SSE event formatting
- Handling: Produce `data: \n\n` (single empty data line + blank line). Valid SSE format.
- Guardrails: Split on empty string produces [''], loop still executes once, output is valid
- Evidence: SSE spec allows empty data, formatSseEvent handles gracefully

- Failure: Event data contains only newlines (e.g., "\n\n\n")
- Surface: SSE event formatting
- Handling: Split produces ['', '', '', ''], each becomes `data: \n`, total output is `data: \ndata: \ndata: \ndata: \n\n`. Valid SSE format.
- Guardrails: Split behavior is well-defined for newline separators, output follows spec
- Evidence: SSE spec allows empty data lines

- Failure: Event name contains newline (malformed input)
- Surface: SSE event formatting
- Handling: Output will be `event: name\nwith\nnewline\ndata: ...\n\n` which violates SSE spec (event name must be single line). Decision: document that event names must not contain newlines, Python backend responsible for validation.
- Guardrails: No explicit validation in gateway (trust Python to send valid data), if sent anyway, client SSE parser will handle gracefully (likely treats second line as data)
- Evidence: CLAUDE.md line 91 "Don't validate headers/URLs - forward them unchanged" (same principle for event names)

- Failure: Disconnect callback fails during close operation
- Surface: handleServerClose function
- Handling: Disconnect callback failure is logged only (best-effort), connection cleanup still completes, response stream still ended, 200 response still returned to Python
- Guardrails: sendDisconnectCallback already handles failures internally (logs only, never throws), await ensures cleanup waits but doesn't fail on error
- Evidence: product_brief.md lines 342-346 "Callback Errors: Log only, No retries"

---

## 9) Observability / Telemetry

- Signal: Event send log
- Type: Structured log message (plain text, INFO level)
- Trigger: After successful event write and flush, in /internal/send handler
- Labels / fields: token (UUID), event name (if present), data length (characters), url (from connection.request)
- Consumer: Log aggregation, event throughput monitoring, debugging event delivery
- Evidence: product_brief.md line 376 "Event sends (token, event name)"

- Signal: Server close log
- Type: Structured log message (plain text, INFO level)
- Trigger: After connection cleanup in handleServerClose, before disconnect callback
- Labels / fields: token, reason ("server_closed"), url
- Consumer: Log aggregation, close operation tracking
- Evidence: product_brief.md line 377 "Closing connections (token, reason)"

- Signal: Write failure log
- Type: Structured log message (plain text, ERROR level)
- Trigger: When res.write() or res.flush() throws exception
- Labels / fields: token, error message, url, operation ("write" or "flush")
- Consumer: Error alerting, debugging stream failures
- Evidence: product_brief.md line 378 "All errors"

- Signal: Invalid request log
- Type: Structured log message (plain text, ERROR level)
- Trigger: When /internal/send receives invalid payload (400 response)
- Labels / fields: error type (missing token, invalid types, etc.), request body excerpt
- Consumer: Debugging integration issues with Python backend
- Evidence: Standard logging practice for API validation failures

- Signal: Token not found log
- Type: Structured log message (plain text, INFO level - expected condition)
- Trigger: When /internal/send receives token not in Map (404 response)
- Labels / fields: token, endpoint (/internal/send)
- Consumer: Tracking close race conditions, Python backend retry logic effectiveness
- Evidence: 404 is expected in normal operation (connections close, Python may still try to send)

---

## 10) Background Work & Shutdown

- Worker / job: None - all operations are request-driven
- Trigger cadence: N/A - /internal/send is synchronous request handler
- Responsibilities: N/A
- Shutdown handling: During graceful shutdown (SIGTERM/SIGINT), existing shutdown handler in index.ts calls server.close() which prevents new requests to /internal/send. In-flight requests complete normally. All SSE connections are terminated by server.close(), triggering 'close' events and cleanup (handled by existing disconnect flow).
- Evidence: src/index.ts:56-75 existing shutdown handler handles all routes

- Worker / job: Heartbeat timer (referenced but not modified)
- Trigger cadence: N/A for this feature (still placeholder)
- Responsibilities: Heartbeat timer is cleared during close operation using existing pattern: `if (connection.heartbeatTimer) clearTimeout(connection.heartbeatTimer)`
- Shutdown handling: Timer cleared as part of connection cleanup (server close or explicit close operation)
- Evidence: change_brief.md references heartbeat timer clearing in close operation

---

## 11) Security & Permissions

- Concern: No authentication on /internal/send endpoint
- Touchpoints: POST /internal/send route handler
- Mitigation: Endpoint is designed for internal-only access (Python backend to gateway communication within same Kubernetes Pod). Network-level access control (Pod networking, firewall rules) prevents external access. No authentication needed at application layer.
- Residual risk: If gateway is exposed externally or Pod networking is misconfigured, malicious actors could send events or close connections. Mitigation is infrastructure responsibility (network policies, service mesh).
- Evidence: product_brief.md lines 350-357 "Security Requirements: No authentication, Rely on Python and NGINX for access control"

- Concern: Arbitrary SSE event content from Python backend
- Touchpoints: Event data written to response stream
- Mitigation: Gateway does not validate or sanitize event content (by design). Python backend is trusted source. Client-side SSE parsers handle event data according to their own security policies.
- Residual risk: Malicious Python backend could send XSS payloads via SSE events. Client applications must sanitize event data before rendering in DOM. This is standard SSE security practice.
- Evidence: CLAUDE.md line 91 "Don't validate headers/URLs - forward them unchanged" (same principle applies to event content)

- Concern: Token guessing or enumeration
- Touchpoints: Token parameter in /internal/send requests
- Mitigation: Tokens are UUIDs generated with crypto.randomUUID() (128-bit cryptographically secure random). Enumeration is infeasible. Failed token lookups return 404 with no timing side channels (Map lookup is O(1)).
- Residual risk: Minimal - UUID space is too large for practical enumeration
- Evidence: CLAUDE.md line 66 "Generate token using crypto.randomUUID()"

- Concern: Denial of service via large event data
- Touchpoints: Event data processing and response stream writes
- Mitigation: No explicit size limits in gateway (by design). Node.js response buffering handles backpressure. Python backend should enforce reasonable event size limits before sending. Network-level limits (NGINX, service mesh) provide final defense.
- Residual risk: Very large events (megabytes) could cause memory pressure or slow writes. Acceptable per architecture (Python is trusted).
- Evidence: Implicit from architecture - gateway is lightweight pass-through

---

## 12) UX / UI Impact

Not applicable - this is an internal backend-to-backend API with no user interface. The only "users" are:
1. Python backend (calling /internal/send)
2. SSE clients (receiving events on their open streams)

Operational experience considerations:
- Python backend receives clear error responses (404, 400, 500) for debugging
- SSE clients receive properly formatted events following spec (compatible with EventSource API)
- Logging provides visibility into send operations and failures for troubleshooting
- Server-initiated close allows graceful connection termination from Python side

---

## 13) Deterministic Test Plan

- Surface: POST /internal/send - successful event send
- Scenarios:
  - Given active SSE connection in Map, When Python sends POST /internal/send with token and event (name + data), Then response is 200 OK, And event is written to SSE stream in correct format (`event: <name>\ndata: <data>\n\n`), And res.flush() is called, And event send is logged with token and event name
  - Given active SSE connection, When Python sends event with only data (no name), Then event is written as `data: <data>\n\n` (no event line), And response is 200 OK
  - Given active SSE connection, When Python sends event with multiline data (contains `\n`), Then data is split and written as multiple `data:` lines, And each line has correct `data: ` prefix, And event ends with blank line
  - Given active SSE connection, When Python sends event with empty string data, Then event is written as `data: \n\n`, And response is 200 OK
- Fixtures / hooks: Establish SSE connection first, capture token, use MockServer to verify event format received by client, spy on res.flush() to verify immediate flush
- Gaps: None
- Evidence: change_brief.md lines 56-58 "Python backend can send events to connected clients via token, SSE events are formatted correctly per specification"

- Surface: POST /internal/send - successful close operation
- Scenarios:
  - Given active SSE connection, When Python sends POST /internal/send with token and close: true (no event), Then response is 200 OK, And disconnect callback is sent to Python with reason "server_closed", And connection is removed from Map, And response stream is ended, And close is logged
  - Given active SSE connection, When Python sends event AND close: true, Then event is sent FIRST, Then connection is closed, And disconnect callback sent after event write, And response is 200 OK
- Fixtures / hooks: MockServer to capture disconnect callback, verify callback payload has correct reason, verify Map.has(token) returns false after close
- Gaps: None
- Evidence: change_brief.md lines 59-60 "Connections close cleanly when requested, Disconnect callback is sent with `reason: "server_closed"` after close"

- Surface: POST /internal/send - token not found
- Scenarios:
  - Given no connection exists for token, When Python sends POST /internal/send with unknown token, Then response is 404 Not Found, And response body is `{"error": "Token not found"}`, And no SSE write is attempted, And no disconnect callback is sent
  - Given connection was closed previously, When Python sends event to that token, Then response is 404 (idempotent)
- Fixtures / hooks: Generate random UUID not in Map, assert 404 response, verify no calls to sendDisconnectCallback
- Gaps: None
- Evidence: change_brief.md line 61 "Unknown tokens return 404"

- Surface: POST /internal/send - invalid request payload
- Scenarios:
  - Given no token field in request, When Python sends POST /internal/send, Then response is 400 Bad Request, And error message indicates missing token
  - Given token is not a string (e.g., number or null), When request is sent, Then response is 400
  - Given event is present but event.data is missing, When request is sent, Then response is 400
  - Given event.data is not a string (e.g., number or object), When request is sent, Then response is 400
  - Given close is not a boolean (e.g., string "true"), When request is sent, Then response is 400
  - Given malformed JSON body, When request is sent, Then Express json parser returns 400 automatically
- Fixtures / hooks: Send various invalid payloads, assert 400 responses with error messages
- Gaps: None
- Evidence: change_brief.md line 49 "Return 400 for invalid request types"

- Surface: POST /internal/send - write failure handling
- Scenarios:
  - Given SSE connection exists but response stream is closed (race condition), When Python sends event, Then res.write() throws exception, And exception is caught, And disconnect callback is sent with reason "error", And connection is removed from Map, And response to Python is 500 Internal Server Error, And error is logged
  - Given res.flush() fails after successful write, When Python sends event, Then flush exception is caught, And disconnect with reason "error" is triggered, And response is 500
- Fixtures / hooks: Mock res.write() or res.flush() to throw error, spy on sendDisconnectCallback to verify reason "error", verify Map cleanup
- Gaps: Difficult to simulate actual stream close in integration test - may need unit test with mocked response object
- Evidence: change_brief.md line 62 "Write failures trigger disconnect callback with `reason: "error"`"

- Surface: SSE event formatting utility
- Scenarios:
  - Given event name "message" and data "Hello", When formatSseEvent() is called, Then output is `event: message\ndata: Hello\n\n`
  - Given no event name (undefined) and data "Hello", When formatSseEvent() is called, Then output is `data: Hello\n\n` (no event line)
  - Given event name and data "Line1\nLine2\nLine3", When formatSseEvent() is called, Then output is `event: <name>\ndata: Line1\ndata: Line2\ndata: Line3\n\n`
  - Given data is empty string "", When formatSseEvent() is called, Then output is `data: \n\n`
  - Given data is only newlines "\n\n", When formatSseEvent() is called, Then output is `data: \ndata: \ndata: \n\n` (three empty data lines)
- Fixtures / hooks: Unit test SSE formatting function directly, assert exact string output including newlines
- Gaps: None
- Evidence: change_brief.md line 58 "Multiline data is properly split and sent, Event names are included when provided"

- Surface: Integration flow - end-to-end event delivery
- Scenarios:
  - Given client establishes SSE connection, When Python sends event via /internal/send, Then client receives event in SSE stream, And event is parseable by client SSE parser
  - Given multiple events sent in sequence, When each /internal/send returns 200, Then client receives all events in order
- Fixtures / hooks: Use supertest to maintain open SSE connection, parse SSE stream in test to verify events, send multiple events and verify order
- Gaps: None
- Evidence: change_brief.md line 63 "Tests cover event sending, closing, multiline data, and error cases"

- Surface: Heartbeat timer cleanup on close
- Scenarios:
  - Given connection has heartbeatTimer set (once heartbeat feature implemented), When server close is triggered, Then clearTimeout(heartbeatTimer) is called, And timer is cancelled
  - Given heartbeatTimer is null (current state), When close is triggered, Then clearTimeout is not called (conditional check), And no error occurs
- Fixtures / hooks: Spy on clearTimeout, verify called with correct timer ID if present, verify not called if null
- Gaps: Full test deferred until heartbeat feature implemented - current test verifies null-safe handling only
- Evidence: Existing pattern in src/routes/sse.ts:180-182 for heartbeat timer cleanup

---

## 14) Implementation Slices

- Slice: 1 - SSE formatting utility
- Goal: Implement and test SSE event formatting following full specification
- Touches: `src/sse.ts` (new) - implement formatSseEvent() function with event name and data parameters, handle multiline data splitting, unit tests
- Dependencies: None - pure function, can be implemented and tested independently

- Slice: 2 - Internal send endpoint (event send only)
- Goal: Implement /internal/send endpoint with event sending capability (no close yet)
- Touches: `src/routes/internal.ts` (new) - create router, implement POST /internal/send handler, payload validation, token lookup, event writing with flush, error handling for write failures, logging
- Dependencies: Requires slice 1 (SSE formatting). Integration tests verify event delivery.

- Slice: 3 - Server-initiated close operation
- Goal: Add close functionality to /internal/send endpoint
- Touches: `src/routes/internal.ts` (modify) - add close parameter handling, implement handleServerClose() helper, integrate with existing disconnect callback flow
- Dependencies: Requires slice 2 (send endpoint) completed. Tests verify close operation and disconnect callback.

- Slice: 4 - Express app integration and full testing
- Goal: Wire internal routes into Express app, comprehensive integration test suite
- Touches: `src/server.ts` (modify) - import and mount internal router, `__tests__/integration/send.test.ts` (new) - full test coverage for send, close, errors, multiline data, `__tests__/utils/sseParser.ts` (new) - SSE stream parsing utility for tests
- Dependencies: Requires all previous slices. Completes the feature.

---

## 15) Risks & Open Questions

- Risk: Response flush() method availability in Express 5
- Impact: If res.flush() is not available or has different signature, immediate flushing may not work correctly
- Mitigation: Research Express 5 response API documentation, verify flush() availability. Alternative: call res.write() with no buffering (check if Express 5 supports this). Fallback: use low-level Node.js http response methods if needed. Test with actual SSE client to verify no buffering occurs.

- Risk: Write operation synchronicity assumptions
- Impact: If res.write() is async and doesn't throw synchronously on stream close, error detection may not work
- Mitigation: Review Node.js Writable stream API docs, verify write() throws synchronously when stream closed. Add test with closed stream to verify behavior. If async, wrap in Promise and handle rejection.

- Risk: SSE client parsing of multiline data
- Impact: Incorrect splitting or formatting could break client EventSource parsers
- Mitigation: Follow SSE spec exactly (RFC), test with real EventSource API in browser, verify parseable events received. Include integration test that actually parses SSE stream.

- Risk: Close operation race condition with in-flight send
- Impact: If close is triggered while event write is in progress, partial event could be sent or response could close mid-write
- Mitigation: Node.js event loop serializes operations per token (no concurrent writes). Close only happens after current request completes. If write is in progress, close request waits in event loop queue. Add test for rapid send+close sequence.

- Risk: Memory usage with large event data strings
- Impact: Very large event data (megabytes) could cause string concatenation memory pressure or slow split operations
- Mitigation: Document recommended event size limits for Python backend (e.g., <100KB per event). Node.js string handling is efficient for typical SSE payloads. If needed, implement streaming write (write data line by line without full string concat). Defer optimization until proven necessary.

- Risk: Disconnect callback failure during close
- Impact: If disconnect callback to Python fails (network error, timeout), Python may not know connection is closed
- Mitigation: This is acceptable per design (best-effort callbacks, no retries). Python backend should track connection state on its side. 200 response to /internal/send close request indicates gateway processed close regardless of callback. Document this behavior.

---

## 16) Confidence

Confidence: High — All requirements are clearly specified in change_brief.md and product_brief.md with exact payload structure and SSE formatting rules. Existing codebase provides solid patterns (callback flow, disconnect cleanup, connection management). SSE specification is well-documented RFC standard. Express 5 and Node.js 20 APIs are stable. Implementation slices are well-defined and incrementally testable. Only minor uncertainty around res.flush() API which can be resolved by documentation review.
