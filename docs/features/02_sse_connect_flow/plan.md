# Implementation Plan: SSE Connect Flow

## 0) Research Log & Findings

**Codebase Structure:**
- The project is a Node.js 20 TypeScript 5 service using Express 5 with ESM modules
- Foundation is already in place: `config.ts`, `logger.ts`, `server.ts`, health endpoints
- Test infrastructure uses Jest with ts-jest ESM preset and Supertest for HTTP testing
- Configuration supports CALLBACK_URL (optional), HEARTBEAT_INTERVAL_SECONDS (default 15), and PORT (default 3000)
- Logger provides plain text format with [INFO] and [ERROR] prefixes
- Health endpoints (/healthz, /readyz) are already implemented in `src/routes/health.ts`

**Key Findings:**
- The `Config` interface already includes `callbackUrl` and `heartbeatIntervalSeconds` fields
- The project follows strict TypeScript with ESM import conventions (`.js` extensions required)
- No compression middleware is registered (correctly per CLAUDE.md requirements)
- Integration tests use `createApp()` factory pattern for Express app construction
- The server.ts file currently only mounts the health router - we'll add SSE and internal routes

**Architecture Decisions from CLAUDE.md:**
- Must use `crypto.randomUUID()` for token generation (built-in Node.js 20)
- Must forward headers and URL verbatim without parsing
- Must flush SSE writes immediately after every write
- Must follow full SSE spec for event formatting (event line, data lines, blank line)
- Must implement best-effort callbacks (no retries, log failures only)
- Connection state stored in `Map<token, ConnectionRecord>` (in-memory only)
- Event loop automatically serializes events for a token (no additional ordering needed)

**Conflicts & Resolutions:**
- No conflicts identified - the change brief aligns perfectly with product_brief.md requirements
- The existing config already supports all required environment variables
- Heartbeat implementation deferred to later (placeholder timer field only for this feature)

---

## 1) Intent & Scope

**User intent**

Implement the core SSE connection lifecycle: accept client SSE connections, generate tokens, notify Python backend of connects/disconnects, handle callback rejections, and manage connection state cleanup.

**Prompt quotes**

"Implement `GET /sse/*` endpoint that accepts any path and query string under `/sse/`"

"Generate a UUID token using `crypto.randomUUID()`"

"If callback returns non-2xx status: Immediately close SSE stream, Return same HTTP status code to client"

"Detect when client closes connection, Send disconnect callback to Python"

**In scope**

- Implementing `GET /sse/*` wildcard endpoint with proper SSE headers
- Generating unique tokens using `crypto.randomUUID()`
- Storing connection state in `Map<token, ConnectionRecord>`
- Sending connect callback to Python backend with request metadata
- Handling connect callback rejection (non-2xx responses)
- Detecting client disconnections via Express response 'close' event
- Sending disconnect callback with `reason: "client_closed"`
- Cleaning up connection state on disconnect
- Logging all connection lifecycle events
- Comprehensive test coverage for connect, reject, and disconnect flows

**Out of scope**

- Heartbeat implementation (timer field is placeholder only)
- Event sending functionality (`POST /internal/send` endpoint)
- Server-initiated close (`reason: "server_closed"`)
- Error-triggered disconnect (`reason: "error"`)
- URL or header parsing/validation
- Authentication or authorization
- SSE event formatting (will be needed for future event sending feature)

**Assumptions / constraints**

- CALLBACK_URL must be configured for SSE endpoint to function
- Python backend callback endpoint is available and responds to POST requests
- Single-instance deployment (no horizontal scaling)
- All state is ephemeral (lost on restart)
- Node.js event loop guarantees ordering of callbacks for a single connection
- Express 5 'close' event reliably detects client disconnections
- Native fetch() API is available in Node.js 20

---

## 2) Affected Areas & File Map

- Area: `src/routes/sse.ts` (new file)
- Why: Implements the `GET /sse/*` wildcard endpoint handler
- Evidence: New file - referenced in change_brief.md line 9 "Implement `GET /sse/*` endpoint"

- Area: `src/connections.ts` (new file)
- Why: Manages the connection state Map and ConnectionRecord type definition
- Evidence: New file - change_brief.md line 18 "Stores connection in `Map<token, ConnectionRecord>`"

- Area: `src/callback.ts` (new file)
- Why: Handles HTTP callbacks to Python backend for connect/disconnect events
- Evidence: New file - change_brief.md line 23 "Implement connect callback to Python backend"

- Area: `src/server.ts` (modification)
- Why: Register new SSE route handler in Express app
- Evidence: `src/server.ts:18-31` - currently only registers health router, needs SSE router added

- Area: `src/config.ts` (no changes)
- Why: Already has all required config fields
- Evidence: `src/config.ts:10-14` defines Config interface with callbackUrl and heartbeatIntervalSeconds

- Area: `__tests__/integration/sse.test.ts` (new file)
- Why: Integration tests for SSE endpoint connect, reject, and disconnect flows
- Evidence: New file - change_brief.md line 62 "Tests cover connect, reject, and disconnect scenarios"

- Area: `__tests__/utils/mockServer.ts` (new file)
- Why: Provides mock Python backend server for testing callback interactions
- Evidence: New file - needed to test callback success/failure scenarios

---

## 3) Data Model / Contracts

- Entity / contract: ConnectionRecord interface
- Shape:
```typescript
interface ConnectionRecord {
  res: express.Response;
  request: {
    url: string;
    headers: Record<string, string | string[] | undefined>;
  };
  heartbeatTimer: NodeJS.Timeout | null;
  disconnected: boolean;  // Flag to detect early client disconnect
}
```
- Refactor strategy: New type definition, no backwards compatibility needed. The heartbeatTimer is set to null for this feature (actual heartbeat implementation deferred). The disconnected flag helps handle race conditions between callback and client disconnect.
- Evidence: product_brief.md:314-323 specifies base ConnectionRecord structure; disconnected field added to handle async callback race condition

- Entity / contract: Connect callback payload
- Shape:
```json
{
  "action": "connect",
  "token": "uuid-string",
  "request": {
    "url": "/sse/channel/updates?user=123",
    "headers": { "authorization": "Bearer xyz", "host": "gateway:3000" }
  }
}
```
- Refactor strategy: New payload, no migration needed. Headers are passed as-is from Express req.headers.
- Evidence: change_brief.md:25-35 and product_brief.md:182-192

- Entity / contract: Disconnect callback payload
- Shape:
```json
{
  "action": "disconnect",
  "reason": "client_closed",
  "token": "uuid-string",
  "request": {
    "url": "/sse/channel/updates?user=123",
    "headers": { "authorization": "Bearer xyz" }
  }
}
```
- Refactor strategy: New payload. The "reason" field is required for disconnect (not for connect).
- Evidence: change_brief.md:42-51 and product_brief.md:287-294

- Entity / contract: SSE Response Headers
- Shape:
```
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive
X-Accel-Buffering: no
```
- Refactor strategy: Standard SSE headers, no compatibility concerns. X-Accel-Buffering prevents NGINX buffering.
- Evidence: change_brief.md:12-16 and product_brief.md:95-101

---

## 4) API / Integration Surface

- Surface: `GET /sse/*`
- Inputs: Any path under /sse/, any query string, any headers (forwarded verbatim)
- Outputs: SSE stream with Content-Type: text/event-stream. If connect callback succeeds: 200 with open stream. If connect callback fails with non-2xx: same HTTP status code returned to client, stream immediately closed.
- Errors:
  - 500 if token generation fails (highly unlikely with crypto.randomUUID)
  - Same status as Python callback if callback returns non-2xx (e.g., 401, 403, 404, 500)
  - Connection terminates if callback request throws (network error)
- Evidence: change_brief.md:9-22 and product_brief.md:80-113

- Surface: Python Callback `POST <CALLBACK_URL>`
- Inputs: JSON payload with action ("connect" or "disconnect"), token, request metadata (url, headers). For disconnect: reason field required.
- Outputs: Expected 2xx response for success, non-2xx for rejection (connect only)
- Errors: Network errors logged only, no retries. For connect callback failure: SSE stream closed with callback's status code. For disconnect callback failure: only logged, connection already cleaned up.
- Evidence: change_brief.md:23-39 and product_brief.md:170-203

---

## 5) Algorithms & State Machines

- Flow: SSE Connection Establishment
- Steps:
  1. Client sends GET /sse/channel/updates?user=123
  2. Gateway validates CALLBACK_URL is configured; if not, return 503 Service Unavailable
  3. Gateway extracts full raw URL from req.url (including query string); if empty/undefined, use '/sse/unknown' as fallback
  4. Gateway extracts raw headers from req.headers and filters out undefined values
  5. Gateway generates token using crypto.randomUUID()
  6. Gateway creates preliminary ConnectionRecord { res, request: { url, headers }, heartbeatTimer: null, disconnected: false }
  7. Gateway registers 'close' event listener on response BEFORE callback to detect early client disconnect
  8. Gateway sends connect callback to Python: POST { action: "connect", token, request } with 5-second timeout
  9. If callback times out (>5s): return 504 Gateway Timeout to client, cleanup, log error
  10. If callback throws (network error): return 503 Service Unavailable to client, cleanup, log error
  11. If callback returns non-2xx status: return same status code to client (without SSE headers), cleanup, log error
  12. If callback returns 2xx AND disconnected flag is false:
      - Set SSE response headers (Content-Type, Cache-Control, Connection, X-Accel-Buffering)
      - Send HTTP 200 status and flush headers (stream is now open)
      - Store ConnectionRecord in connections Map with token as key
      - Log successful connection with token and URL
  13. If callback returns 2xx BUT disconnected flag is true: cleanup only, do not add to Map (client already gone)
- States / transitions: No formal state machine. Connection lifecycle: pending-callback → open (in Map) → closed (removed from Map)
- Hotspots:
  - Callback latency blocks connection establishment (5s max with timeout)
  - Client can disconnect during callback (handled by disconnected flag)
  - Map lookup for disconnect is O(1)
  - Headers may be large objects (proxied headers can include many fields)
- Evidence: product_brief.md:230-244 describes connect flow; product_brief.md:109-112 requires returning callback status code to client

- Flow: Client Disconnect Detection
- Steps:
  1. Express response emits 'close' event when client disconnects
  2. Event listener checks if token exists in Map
  3. If token exists in Map:
     - Retrieve ConnectionRecord from Map
     - Clear heartbeatTimer using clearTimeout (if not null)
     - Remove token from Map
     - Send disconnect callback to Python: POST { action: "disconnect", reason: "client_closed", token, request } (best-effort, 5s timeout)
     - Log disconnect event with token and URL
     - If disconnect callback fails (network error, timeout, or non-2xx), only log error
  4. If token does NOT exist in Map (client disconnected during callback):
     - Set disconnected flag to true in ConnectionRecord (prevents later Map insertion)
     - Log early disconnect with token
- States / transitions: Connection moves from exists → not-exists atomically, OR never enters Map if disconnect happens during callback
- Hotspots:
  - Disconnect callback is best-effort (failures only logged)
  - Timer is null for this feature, so clearTimeout only called if non-null (future-proof)
  - Race condition between callback and disconnect handled by disconnected flag
  - Multiple disconnect triggers possible - Map.has(token) check ensures idempotency
- Evidence: product_brief.md:276-298 and change_brief.md:40-52; race condition handling addresses review finding

---

## 6) Derived State & Invariants

- Derived value: Connection existence in Map
  - Source: Unfiltered - token generated internally, ConnectionRecord created from req.url and req.headers
  - Writes / cleanup: Token added to Map after successful callback AND disconnected=false, removed on disconnect or callback rejection
  - Guards: Token uniqueness guaranteed by crypto.randomUUID(). Disconnect handler checks Map.has(token) before cleanup. disconnected flag prevents adding closed connections to Map.
  - Invariant: If token exists in Map, then (1) response object is valid and open, (2) heartbeatTimer is null (for this feature), (3) disconnected is false. Connection is bidirectional (can write to res, res can emit events).
  - Evidence: product_brief.md:314-323 ConnectionRecord structure; disconnected flag prevents race condition orphans

- Derived value: Callback payload request.url
  - Source: Filtered from req.url - Express provides this as the full path including query string
  - Writes / cleanup: Included in both connect and disconnect callback payloads, never modified
  - Guards: URL is never parsed or validated, forwarded raw as string
  - Invariant: request.url in callback exactly matches the URL the client requested
  - Evidence: product_brief.md:187 "request.url is the raw incoming URL, including query string"

- Derived value: Callback payload request.headers
  - Source: Filtered from req.headers - Express provides this as object with header names (lowercased) and values
  - Writes / cleanup: Included in both connect and disconnect callback payloads, forwarded verbatim
  - Guards: Headers are never parsed, validated, or filtered (except Express's own lowercasing)
  - Invariant: request.headers in callback contains all headers the client sent (as processed by Express)
  - Evidence: product_brief.md:188 "request.headers are the raw incoming headers"

- Derived value: heartbeatTimer field
  - Source: Set to null for this feature (actual heartbeat implementation deferred to future work)
  - Writes / cleanup: Set to null on ConnectionRecord creation, cleared with `if (timer) clearTimeout(timer)` on disconnect (future-proof for when timer is implemented)
  - Guards: Type is `NodeJS.Timeout | null`, so null-check required before clearTimeout
  - Invariant: heartbeatTimer is always null for this feature. Field exists in interface for future compatibility.
  - Evidence: product_brief.md:322 heartbeatTimer field in ConnectionRecord, change_brief.md:21 "Heartbeat timer (placeholder for now)"; null value avoids creating no-op timers (review finding)

---

## 7) Consistency, Transactions & Concurrency

- Transaction scope: No database transactions. State changes are in-memory Map operations which are atomic at the JavaScript level.
- Atomic requirements:
  - Adding token to Map must happen before registering 'close' listener (else disconnect could fire before connection tracked)
  - Removing token from Map and clearing timer must happen together (timer cleared first, then Map.delete)
  - Connect callback must complete before connection is considered established
- Retry / idempotency:
  - No retries for callback failures (best-effort design)
  - Disconnect handler checks Map.has(token) to ensure idempotency if called multiple times
  - Token generation via crypto.randomUUID() ensures no collisions (collision probability negligible)
- Ordering / concurrency controls:
  - Node.js event loop serializes all operations for a single token automatically
  - Map operations are synchronous and atomic within the event loop
  - No locks needed due to single-threaded nature
  - Multiple connections with different tokens can be processed concurrently via event loop multiplexing
- Evidence: CLAUDE.md:45 "Event Loop Ordering: All events for a token are automatically serialized by Node's event loop"

---

## 8) Errors & Edge Cases

- Failure: Python callback timeout (> 5 seconds)
- Surface: GET /sse/* endpoint during connect callback
- Handling: Return 504 Gateway Timeout to client, do not set SSE headers, cleanup, log timeout error with token and callback URL
- Guardrails: fetch() with signal: AbortSignal.timeout(5000), timeout error caught and logged, client receives clear timeout status
- Evidence: Review finding - timeout must be in-scope to prevent indefinite blocking; 504 is standard HTTP timeout status

- Failure: Python callback returns non-2xx status (e.g., 401, 403, 500)
- Surface: GET /sse/* endpoint
- Handling: Return same HTTP status code to client WITHOUT setting SSE headers, do not add to Map, log failure with token and status code
- Guardrails: Status code validation (check response.ok or response.status >= 200 && response.status < 300), callback sent BEFORE headers to allow status propagation
- Evidence: change_brief.md:36-39 and product_brief.md:109-112 "Return the same HTTP status code to the client"

- Failure: Python callback request throws (network error: ECONNREFUSED, DNS failure)
- Surface: GET /sse/* endpoint
- Handling: Return 503 Service Unavailable to client (backend unavailable), do not add to Map, log error with token and error message
- Guardrails: Try-catch around fetch() call, 503 signals temporary backend unavailability (distinguishes from 500 for internal errors)
- Evidence: product_brief.md:330-336 and CLAUDE.md:110 "Don't retry failed callbacks - log and move on"

- Failure: Client disconnects before connect callback completes (race condition)
- Surface: Express 'close' event listener on response object
- Handling: 'close' event fires BEFORE callback completes (listener registered early). Disconnect handler sets disconnected=true flag in ConnectionRecord. When callback completes successfully, checks disconnected flag before adding to Map. If true, skips Map insertion and logs early disconnect.
- Guardrails: disconnected flag prevents orphaned connections in Map, 'close' listener registered before callback to detect early disconnect, idempotent handling
- Evidence: Express documentation on response 'close' event; review finding on race condition between callback and disconnect

- Failure: CALLBACK_URL not configured
- Surface: GET /sse/* endpoint
- Handling: Return 503 Service Unavailable to client (service is not ready), log error indicating CALLBACK_URL missing
- Guardrails: Check config.callbackUrl !== null at start of handler, readyz endpoint already returns 503 when not configured
- Evidence: src/config.ts:39 callbackUrl can be null, src/routes/health.ts:42-54 readyz returns 503 when not configured

- Failure: req.url is empty, undefined, or malformed
- Surface: GET /sse/* endpoint during URL extraction
- Handling: Use defensive fallback: `const url = req.url || '/sse/unknown'` to ensure callback always has a valid string value
- Guardrails: Express guarantees req.url for valid requests, but fallback prevents TypeScript strict null errors and handles edge cases gracefully
- Evidence: Review finding on req.url defensive handling; Express Request documentation

- Failure: Headers object contains undefined values or multi-value headers (string[])
- Surface: Callback payload construction in src/callback.ts
- Handling: Filter out undefined header values before JSON.stringify to prevent inconsistent Python parsing. For multi-value headers (string[]), forward as-is - Python must handle arrays. Create sanitized headers object: `Object.fromEntries(Object.entries(req.headers).filter(([_, v]) => v !== undefined))`
- Guardrails: Explicit filtering ensures no undefined in JSON, TypeScript types document string[] possibility, test coverage verifies multi-value headers are preserved
- Evidence: product_brief.md:92 "Forward headers verbatim"; review finding on undefined values causing Python parsing issues

- Failure: Response object write fails (stream already ended, network error)
- Surface: SSE response write operations (headers, status)
- Handling: This feature only writes headers/status. Write failures would be caught by Express and trigger 'close' event. Disconnect handler will clean up.
- Guardrails: 'close' event listener ensures cleanup regardless of failure mode, log errors if write operations throw
- Evidence: product_brief.md:289 disconnect reason "error" for write failures (future feature)

---

## 9) Observability / Telemetry

- Signal: Connection establishment log
- Type: Structured log message (plain text)
- Trigger: After token generation and before connect callback, in GET /sse/* handler
- Labels / fields: token (UUID), url (full path with query), remote address (req.socket.remoteAddress)
- Consumer: Log aggregation system, manual debugging
- Evidence: product_brief.md:373-375 "Log these events: New connections (token, URL)"

- Signal: Connect callback success log
- Type: Structured log message (plain text)
- Trigger: After connect callback returns 2xx response
- Labels / fields: token, callback status code (e.g., 200)
- Consumer: Log aggregation, callback reliability monitoring
- Evidence: product_brief.md:375 "Callback results (success/failure)"

- Signal: Connect callback failure log
- Type: Structured log message with [ERROR] severity
- Trigger: After connect callback returns non-2xx or throws error
- Labels / fields: token, callback URL, status code or error message, url (for context)
- Consumer: Alerting system, debugging connection rejections
- Evidence: product_brief.md:375 "Callback results (success/failure)"

- Signal: Client disconnect log
- Type: Structured log message (plain text)
- Trigger: When 'close' event fires on response object
- Labels / fields: token, reason ("client_closed"), url
- Consumer: Log aggregation, connection duration analysis
- Evidence: product_brief.md:377 "Connection closes (token, reason)"

- Signal: Disconnect callback failure log
- Type: Structured log message with [ERROR] severity
- Trigger: When disconnect callback to Python fails (network error or non-2xx)
- Labels / fields: token, error message or status code
- Consumer: Monitoring disconnect callback reliability (best-effort, failures expected)
- Evidence: product_brief.md:342-346 "Callback Errors: Log only, No retries"

---

## 10) Background Work & Shutdown

- Worker / job: Placeholder heartbeat timer setup
- Trigger cadence: Per-connection, at connection establishment
- Responsibilities: For this feature, create a no-op timer using setTimeout(() => {}, 0) and immediately clear it. Actual heartbeat sending deferred to future feature.
- Shutdown handling: On graceful shutdown (SIGTERM/SIGINT), existing shutdown handler in index.ts calls server.close() which terminates all SSE connections. Each terminated connection triggers 'close' event, which runs disconnect cleanup. Timer is cleared as part of cleanup.
- Evidence: src/index.ts:56-75 shutdown handler, product_brief.md:322 heartbeatTimer field, change_brief.md:21 "Heartbeat timer (placeholder for now)"

- Worker / job: Connection 'close' event listener
- Trigger cadence: Event-driven, when client disconnects or connection is terminated
- Responsibilities: Cleanup timer, remove from Map, send disconnect callback, log disconnect
- Shutdown handling: During shutdown, all response objects are closed by server.close(), triggering 'close' events for all active connections. Disconnect callbacks are sent best-effort (may fail if Python backend is also shutting down).
- Evidence: product_brief.md:276-298 disconnect handling, product_brief.md:301-305 restart behavior (no callbacks sent)

---

## 11) Security & Permissions

- Concern: No authentication or authorization enforced by gateway
- Touchpoints: GET /sse/* endpoint
- Mitigation: Per design, gateway relies on Python backend to enforce auth/authz by rejecting connections (non-2xx callback response). NGINX may also enforce auth before requests reach gateway. Gateway's responsibility is to forward request metadata (headers, URL) to Python for decision.
- Residual risk: Gateway trusts Python backend's decision. If Python callback is compromised or misconfigured, unauthorized connections could be accepted. This is acceptable per product_brief.md design.
- Evidence: product_brief.md:350-357 "Security Requirements: No authentication, No authorization, Rely on Python and NGINX for access control"

- Concern: Headers and URL forwarded verbatim without sanitization
- Touchpoints: Callback payload construction
- Mitigation: No sanitization applied (by design). Headers and URL are passed as-is to Python backend. Python is responsible for validation, sanitization, and security checks.
- Residual risk: Gateway could forward malicious headers or URLs to Python. Python must implement proper input validation. Acceptable per division of responsibilities.
- Evidence: product_brief.md:355 "No header parsing beyond passing through to callback"

- Concern: Token generation predictability
- Touchpoints: crypto.randomUUID() call in connection handler
- Mitigation: Using crypto.randomUUID() which is cryptographically secure (implements RFC 4122 version 4 UUID). Tokens are unpredictable and have negligible collision probability.
- Residual risk: None - crypto.randomUUID() is industry-standard secure random token generation
- Evidence: CLAUDE.md:66 "Generate token using crypto.randomUUID()"

---

## 12) UX / UI Impact

Not applicable - this is a backend service with no user interface. The only "users" are:
1. HTTP clients connecting to /sse/* (typically browsers or HTTP libraries)
2. Python backend receiving callbacks

User experience considerations:
- Clients connecting to /sse/* will see immediate connection rejection if Python callback returns non-2xx (good UX - fast failure)
- Clients will receive proper SSE Content-Type headers enabling EventSource API usage
- Connection failures surface as HTTP status codes (401, 403, 500, etc.) making debugging easier

---

## 13) Deterministic Test Plan

- Surface: GET /sse/* endpoint - successful connection flow
- Scenarios:
  - Given CALLBACK_URL is configured and Python backend is available, When client sends GET /sse/channel/updates?user=123, Then response headers are set to SSE format (Content-Type: text/event-stream, Cache-Control: no-cache, Connection: keep-alive, X-Accel-Buffering: no), And status is 200, And connect callback is sent to Python with correct payload (action: "connect", token, request.url, request.headers), And token is stored in connections Map, And response remains open (stream active)
  - Given multiple clients connect simultaneously, When each sends GET /sse/different-paths, Then each receives unique token, And all tokens are stored in Map, And all connections remain open independently
- Fixtures / hooks: mockServer utility to simulate Python backend returning 200 OK, spy on fetch() to verify callback payload, verify response headers using supertest
- Gaps: None for basic flow
- Evidence: change_brief.md:56-57 "Clients can establish SSE connections", product_brief.md:230-244 connect flow

- Surface: GET /sse/* endpoint - connect callback rejection (non-2xx)
- Scenarios:
  - Given CALLBACK_URL is configured and Python backend returns 401 Unauthorized, When client sends GET /sse/protected, Then connect callback is sent to Python, And gateway receives 401 response, And SSE stream is immediately closed, And client receives 401 response, And token is NOT stored in Map, And heartbeat timer is cleared
  - Given Python backend returns 403 Forbidden, When client connects, Then client receives 403 response, And connection is closed
  - Given Python backend returns 500 Internal Server Error, When client connects, Then client receives 500 response
- Fixtures / hooks: mockServer returning various non-2xx status codes, verify Map.has(token) returns false, verify response status and closure
- Gaps: None
- Evidence: change_brief.md:36-39 "Connections are rejected when Python returns non-2xx"

- Surface: GET /sse/* endpoint - callback network failure
- Scenarios:
  - Given CALLBACK_URL points to non-existent server, When client connects, Then fetch() throws ECONNREFUSED, And client receives 503 Service Unavailable response, And error is logged, And connection is closed, And token is NOT in Map
  - Given CALLBACK_URL is reachable but Python backend takes > 5 seconds to respond, When client connects, Then fetch() times out (AbortSignal.timeout), And client receives 504 Gateway Timeout response, And timeout error is logged, And connection is closed
- Fixtures / hooks: mockServer not started (or wrong port) for ECONNREFUSED, mockServer with artificial delay for timeout, spy on logger.error to verify error logged
- Gaps: None - timeout testing is now in-scope (5-second timeout via AbortSignal)
- Evidence: product_brief.md:330-336 callback error handling; review finding requires timeout in-scope

- Surface: GET /sse/* endpoint - CALLBACK_URL not configured
- Scenarios:
  - Given config.callbackUrl is null, When client sends GET /sse/any, Then response is 503 Service Unavailable, And error is logged, And no callback is attempted
- Fixtures / hooks: Create app with callbackUrl: null config, verify 503 response
- Gaps: None
- Evidence: src/routes/health.ts:42-54 readyz behavior, should be consistent

- Surface: Express response 'close' event - client disconnect
- Scenarios:
  - Given active SSE connection exists in Map, When client closes connection (abort request), Then 'close' event fires, And disconnect callback is sent to Python with action: "disconnect" and reason: "client_closed", And token is removed from Map, And heartbeatTimer is cleared if not null, And disconnect is logged
  - Given disconnect callback to Python fails (network error), When client disconnects, Then error is logged only, And cleanup still completes (Map.delete, timer cleared)
  - Given disconnect callback returns non-2xx, When client disconnects, Then error is logged only, And cleanup still completes
  - Given client disconnects DURING connect callback (race condition), When 'close' fires before callback returns, Then disconnected flag is set to true, And when callback later returns 2xx, token is NOT added to Map, And early disconnect is logged
- Fixtures / hooks: mockServer to receive disconnect callback, simulate client disconnect by aborting request in test, mockServer with artificial delay to test race condition, verify Map.has(token) returns false, spy on clearTimeout (should handle null)
- Gaps: None
- Evidence: change_brief.md:59-61 "Client disconnects are detected and callback is sent"; review finding on race condition handling

- Surface: Callback payload formatting
- Scenarios:
  - Given request has query string /sse/channel?user=123&room=456, When connect callback is sent, Then request.url includes full query string
  - Given request has multiple headers (Authorization, User-Agent, X-Custom), When connect callback is sent, Then request.headers includes all headers (filtered for undefined values)
  - Given request has no query string /sse/simple, When connect callback is sent, Then request.url is "/sse/simple"
  - Given request headers contain undefined values (edge case), When connect callback is sent, Then request.headers does NOT include undefined entries (filtered out)
  - Given request has multi-value header (e.g., Set-Cookie as string[]), When connect callback is sent, Then request.headers preserves array value for that header
  - Given req.url is empty/undefined (edge case), When callback is sent, Then request.url defaults to "/sse/unknown"
- Fixtures / hooks: mockServer to capture callback payload, assertions on payload structure, inject headers with undefined and string[] values to test filtering
- Gaps: None
- Evidence: product_brief.md:187-188 raw URL and headers forwarding; review finding on undefined values and multi-value headers

- Surface: Connection state management
- Scenarios:
  - Given 100 concurrent connections, When all connect successfully, Then Map contains 100 entries, And each has unique token
  - Given connection exists in Map, When same client disconnects, Then Map.size decreases by 1
  - Given all connections disconnect, When cleanup completes, Then Map.size is 0 (no memory leaks)
- Fixtures / hooks: Loop to create multiple connections, verify Map state after each operation
- Gaps: Large-scale load testing (1000+ connections) deferred to performance testing phase
- Evidence: product_brief.md:66-68 "Thousands of concurrent SSE connections"

---

## 14) Implementation Slices

- Slice: 1 - Connection state management module
- Goal: Create foundational types and Map for storing connections
- Touches: `src/connections.ts` (new) - define ConnectionRecord interface, export connections Map, export helper functions (addConnection, removeConnection, getConnection)
- Dependencies: None - can be implemented and unit tested independently

- Slice: 2 - Callback module
- Goal: Implement HTTP callback logic for connect and disconnect actions
- Touches: `src/callback.ts` (new) - implement sendConnectCallback and sendDisconnectCallback functions using fetch(), error handling, logging
- Dependencies: Requires config.callbackUrl, logger. Can be implemented with integration tests using mockServer.

- Slice: 3 - SSE endpoint handler
- Goal: Implement GET /sse/* route handler with connection establishment and reject flows
- Touches: `src/routes/sse.ts` (new) - implement route handler, integrate with callback module and connections module, set SSE headers, handle callback success/failure
- Dependencies: Requires slice 1 (connections) and slice 2 (callback) completed. Integration tests can verify full flow.

- Slice: 4 - Disconnect detection
- Goal: Add 'close' event listener to handle client disconnects
- Touches: `src/routes/sse.ts` (modify) - add response 'close' event listener in connection handler, implement cleanup and disconnect callback
- Dependencies: Requires slices 1, 2, 3 completed. Integration tests verify disconnect flow.

- Slice: 5 - Express app integration and full testing
- Goal: Wire SSE routes into Express app, run full integration test suite
- Touches: `src/server.ts` (modify) - import and mount SSE router, `__tests__/integration/sse.test.ts` (new) - comprehensive test coverage
- Dependencies: Requires all previous slices. Completes the feature.

---

## 15) Risks & Open Questions

- Risk: Connect callback latency blocks client connection establishment
- Impact: Slow or unresponsive Python backend delays clients
- Mitigation: **IMPLEMENTED** - 5-second timeout on fetch() using AbortSignal.timeout(5000). Client receives 504 Gateway Timeout if callback exceeds limit. Documented in error handling (Section 8).

- Risk: fetch() API behavior with non-2xx responses may not match expectations
- Impact: fetch() does NOT reject promise for HTTP error status codes (only network errors). Must check response.ok explicitly.
- Mitigation: Implement explicit response.ok check or response.status validation in callback functions. Add tests for various status codes.

- Risk: Express 'close' event may fire multiple times or not fire at all
- Impact: Could lead to duplicate disconnect callbacks or missed disconnects
- Mitigation: Implement idempotent disconnect handler (check Map.has before cleanup), rely on Express event behavior (tested and documented). Add tests for edge cases.

- Risk: Memory leak from heartbeat timer (NOW RESOLVED)
- Impact: Previously, placeholder timers could leak if not cleared
- Mitigation: **RESOLVED** - heartbeatTimer is now `NodeJS.Timeout | null`, set to null for this feature. No timer creation means no cleanup needed. Conditional clearTimeout (`if (timer) clearTimeout(timer)`) makes code future-proof for when heartbeats are implemented.

- Risk: Race condition - client disconnects during connect callback
- Impact: Callback could complete successfully and add connection to Map after client already disconnected, creating orphaned entry
- Mitigation: **IMPLEMENTED** - 'close' listener registered BEFORE callback, sets `disconnected` flag. Callback completion checks flag before Map insertion. Test coverage for race condition (Section 13).

- Risk: Large headers object could cause performance issues or payload size limits
- Impact: Callback payload could be very large if headers are extensive (e.g., cookies, proxied headers)
- Mitigation: Document that Python backend should enforce payload size limits, no size limits in gateway (by design), trust network and backend to handle

---

## 16) Confidence

Confidence: High — All requirements are clearly specified in change_brief.md and product_brief.md, existing codebase provides solid foundation (config, logger, Express setup), Node.js 20 native APIs (fetch, crypto.randomUUID) are stable and well-documented, implementation slices are well-defined and testable independently, no ambiguous requirements identified.
