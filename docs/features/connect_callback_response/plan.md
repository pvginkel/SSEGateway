# Feature Plan: Connect Callback Response

## 0) Research Log & Findings

### Discovery Work

I examined the codebase to understand the current callback mechanism and how the Python backend interacts with SSEGateway:

1. **Current callback implementation** (`src/callback.ts`):
   - `sendConnectCallback()` and `sendDisconnectCallback()` functions send POST requests to Python backend
   - Current implementation only checks `response.ok` (2xx status) and `response.status`
   - Response body is never read or parsed
   - Callbacks use 5-second timeout via `AbortSignal.timeout(5000)`

2. **SSE route handler** (`src/routes/sse.ts`):
   - Lines 93-98: Sends connect callback and awaits result
   - Lines 100-129: Handles callback failure by mapping error types to HTTP status codes
   - Non-2xx responses return JSON error to client without opening SSE stream

3. **Internal send endpoint** (`src/routes/internal.ts`):
   - Lines 60-171: Implements POST `/internal/send` endpoint
   - Lines 18-30: Defines `SendRequest` interface with optional `event` and `close` fields
   - Lines 114-162: Handles event sending with SSE formatting
   - Lines 164-167: Handles connection close if `close: true`
   - Lines 164-167: Critical ordering: if both event and close, send event FIRST, then close

4. **SSE formatting** (`src/sse.ts`):
   - `formatSseEvent()` utility handles proper SSE spec formatting with event names and multi-line data

5. **Test infrastructure** (`__tests__/utils/mockServer.ts`):
   - MockServer currently returns fixed status code and JSON body `{ status: 'ok' }`
   - No mechanism to return custom response bodies for testing

### Key Findings

1. **Reusable logic**: The event sending and closing logic in `/internal/send` is exactly what we need for callback responses - we can extract and reuse it
2. **Callback result structure**: `CallbackResult` interface currently only captures success/failure status, not response body
3. **Type alignment**: The desired response body structure matches `SendRequest` minus the `token` field - we should define a shared type
4. **Ordering guarantee**: Both `/internal/send` and the change brief specify "event first, then close" - we must maintain this invariant
5. **Error handling**: Connect callback failures already prevent stream opening - this behavior must be preserved
6. **Testing gap**: MockServer needs enhancement to return custom response bodies for testing this feature

### Conflicts & Resolutions

**Conflict**: Should disconnect callbacks also support response bodies?
**Resolution**: The change brief states "This applies to all callback actions (both connect and disconnect)" - we must implement for both, even though disconnect is best-effort and less useful in practice.

**Conflict**: What if response body is invalid JSON or has wrong types?
**Resolution**: Treat as empty response `{}` and log error - never fail the connection for malformed response bodies, as this would break backwards compatibility with Python backends that don't send bodies.

**Conflict**: Should we validate event/close in callback response as strictly as `/internal/send`?
**Resolution**: Use lenient validation - if fields are invalid, treat as empty `{}` and log warning. This maintains backwards compatibility and resilience.

## 1) Intent & Scope

### User intent

Allow the Python backend to immediately send an SSE event and/or close a connection when responding to a connect or disconnect callback, without requiring a separate POST to `/internal/send`.

### Prompt quotes

"Allow the Python backend to send an event and/or close the connection immediately when responding to a connect (or disconnect) callback."

"Default response body is `{}` (no action taken)"

"If both `event` and `close` are present: send event first, then close (same as existing `/internal/send` logic)"

"This allows Python to immediately send a welcome message or reject a connection with a specific error event without needing a separate `/internal/send` call."

### In scope

- Extend `sendConnectCallback()` and `sendDisconnectCallback()` to read and parse response body
- Define shared type for callback response body (matches `SendRequest` without `token`)
- Apply callback response body actions (send event, close connection) in SSE route handler
- Maintain existing ordering guarantee: event sent first, then close
- Handle invalid/missing response body gracefully (default to empty `{}`)
- Preserve all existing behavior: non-2xx status still closes connection immediately
- Update MockServer test utility to support custom response bodies
- Add comprehensive tests for callback response body scenarios

### Out of scope

- Retrying failed callbacks (already best-effort)
- Buffering or queueing events from callback responses
- Supporting callback response bodies for other actions beyond connect/disconnect
- Validating event data content or size limits
- Compression or optimization of response body data
- Authentication or authorization of callback response contents

### Assumptions / constraints

- Python backend will return JSON response bodies (invalid JSON treated as `{}`)
- Callback responses must complete within existing 5-second timeout
- Event formatting follows existing SSE spec (handled by `formatSseEvent()`)
- Single-threaded Node.js event loop ensures ordering within a connection
- Backwards compatibility required: Python backends not sending bodies must continue working
- Disconnect callbacks remain best-effort (errors logged, not thrown)

## 2) Affected Areas & File Map

- Area: `src/callback.ts` - sendConnectCallback function
- Why: Must read and parse response body, return parsed event/close data in CallbackResult
- Evidence: `src/callback.ts:71-83` - current implementation only checks response.ok, never reads body

- Area: `src/callback.ts` - sendDisconnectCallback function
- Why: Must read and parse response body for disconnect callbacks (though less commonly used)
- Evidence: `src/callback.ts:96-117` - current implementation only checks response.ok

- Area: `src/callback.ts` - CallbackResult interface
- Why: Must include optional event and close fields from response body
- Evidence: `src/callback.ts:52-61` - current interface only has success/statusCode/errorType/error fields

- Area: `src/callback.ts` - sendCallback helper function
- Why: Must read response.json() and parse callback response body structure
- Evidence: `src/callback.ts:128-185` - currently returns result after checking response.ok, body never read

- Area: `src/callback.ts` - new shared type definition
- Why: Need type for callback response body (event + close, without token)
- Evidence: `src/routes/internal.ts:18-30` - SendRequest interface has token, event, close fields; callback response should only have event and close

- Area: `src/routes/sse.ts` - SSE route handler after successful callback
- Why: Must apply callback response body actions (send event, close) after callback succeeds
- Evidence: `src/routes/sse.ts:131-151` - after successful callback, sets SSE headers and opens stream; needs to send event/close if present in callback result

- Area: `src/callback.ts` - sendDisconnectCallback function
- Why: Parse response body for disconnect callbacks for forwards compatibility with future Python backend features (e.g., logging/analytics pipelines that track disconnect-time events). Response bodies are parsed but never applied to connections because disconnect callbacks are sent AFTER connection cleanup (Map removal, timer cleared, stream ending). Log at WARN level to signal unexpected usage to developers.
- Evidence: `src/callback.ts:96-117` - add logging after successful response.json() parse: if responseBody has event or close fields, log WARN message that disconnect callback response bodies are informational only and ignored

- Area: `src/routes/internal.ts` - extract handleEventAndClose function
- Why: Extract event-send-and-close logic from POST /internal/send (lines 114-167) into new exported function handleEventAndClose(). Keep function in src/routes/internal.ts to preserve existing module boundaries (src/sse.ts should remain a pure formatting utility with no dependencies).
- Function signature:
  ```typescript
  async function handleEventAndClose(
    connection: ConnectionRecord,
    event: { name?: string; data: string } | undefined,
    close: boolean | undefined,
    token: string,
    callbackUrl: string
  ): Promise<void>
  ```
- Returns: void (throws on write failure)
- Called by: POST /internal/send handler (same file), SSE route handler after connect callback (imports from internal.ts)
- Evidence: `src/routes/internal.ts:114-167` - current implementation to be extracted

- Area: `__tests__/utils/mockServer.ts` - MockServer response handling
- Why: Must support custom response bodies for testing callback response scenarios, including invalid structures and malformed JSON
- Signature:
  ```typescript
  setResponseBody(body: any): void
  ```
- Accepts any value (object, string, etc.) and stores it. In sendResponse(), calls JSON.stringify() on the stored value. This allows testing both valid CallbackResponseBody objects AND invalid structures.
- Default behavior: If setResponseBody() never called, sendResponse() uses `{ status: 'ok' }` as default
- Evidence: `__tests__/utils/mockServer.ts:194-197` - sendResponse always returns `{ status: 'ok' }`; needs configurable body

- Area: `__tests__/integration/sse.test.ts` - new test suite
- Why: Add tests for callback response with event, close, both, invalid bodies, etc.
- Evidence: `__tests__/integration/sse.test.ts:1-536` - existing tests verify callback success/failure but not response body handling

- Area: `__tests__/integration/send.test.ts` - verify no regression
- Why: Ensure existing send endpoint tests still pass after extracting shared logic
- Evidence: File exists in test suite - must verify no behavior changes to /internal/send

## 3) Data Model / Contracts

- Entity / contract: CallbackResponseBody (new shared type)
- Shape:
  ```typescript
  interface CallbackResponseBody {
    event?: {
      name?: string;
      data: string;
    };
    close?: boolean;
  }
  ```
- Refactor strategy: Define once, reference in CallbackResult and use for validation; eliminates duplicate type definitions
- Validation location: In sendCallback function (callback.ts) immediately after response.json() parse
- Validation logic: Try-catch around JSON.parse; type checks for event.data (must be string), event.name (must be string or undefined), close (must be boolean or undefined)
- Invalid handling: Set responseBody to undefined, log ERROR with token and error details
- Evidence: `src/routes/internal.ts:18-30` - SendRequest has same structure with additional token field

- Entity / contract: CallbackResult (modified)
- Shape:
  ```typescript
  interface CallbackResult {
    success: boolean;
    statusCode?: number;
    errorType?: 'timeout' | 'network' | 'http_error';
    error?: string;
    // NEW: parsed response body (only present if success = true)
    responseBody?: CallbackResponseBody;
  }
  ```
- Refactor strategy: Add optional responseBody field; existing callers ignore it (backwards compatible)
- Evidence: `src/callback.ts:52-61` - current CallbackResult definition

- Entity / contract: Python callback response body (HTTP response from Python)
- Shape:
  ```json
  {
    "event": {
      "name": "welcome",
      "data": "Connected successfully"
    },
    "close": true
  }
  ```
  Default if missing: `{}`

  Invalid cases treated as `{}`:
  - Invalid JSON
  - event present but event.data not string
  - close present but not boolean
  - event.name present but not string

- Refactor strategy: Lenient parsing - invalid fields ignored, logged as warnings; maintains backwards compatibility
- Evidence: Change brief line 27-28 - "Default response body is `{}`"

## 4) API / Integration Surface

- Surface: Python callback endpoint response (existing, behavior extended)
- Inputs: POST request with connect/disconnect payload
- Outputs:
  - HTTP status code (existing): 2xx = success, non-2xx = failure
  - Response body (NEW): Optional JSON with event and/or close fields
  - Example success with event:
    ```json
    {
      "event": { "name": "welcome", "data": "Hello!" },
      "close": false
    }
    ```
  - Example rejection with error event:
    ```json
    {
      "event": { "name": "error", "data": "Unauthorized" }
    }
    ```
    Status: 401
- Errors:
  - Invalid JSON body: logged, treated as `{}`
  - Missing event.data: logged, event ignored
  - Invalid types: logged, fields ignored
  - Timeout (>5s): existing behavior, responseBody undefined
- Evidence: `src/callback.ts:128-185` - sendCallback implementation; `src/routes/sse.ts:93-129` - callback result handling

- Surface: Internal implementation - no external API changes
- Inputs: N/A (internal refactoring)
- Outputs: N/A
- Errors: N/A
- Evidence: Changes are internal to SSEGateway, no external integration surface modified

## 5) Algorithms & State Machines

- Flow: Connect callback with response body processing
- Steps:
  1. Client sends GET request to SSE endpoint
  2. Gateway generates token, registers 'close' event listener
  3. Gateway sends POST to Python callback URL with connect payload
  4. Python responds with status code + optional JSON body containing event/close
  5. Gateway reads response body and parses JSON (lenient - errors logged, treat as `{}`)
  6. If status non-2xx: return error to client (existing behavior, ignore response body)
  7. If status 2xx and client already disconnected: do nothing (existing race condition handling)
  8. If status 2xx and response has event: format and write SSE event to stream
  9. If status 2xx and response has close=true: close connection immediately after event
  10. If status 2xx and no event/close: open stream normally (existing behavior)
  11. Before executing event-send-and-close logic: re-check connectionRecord.disconnected flag
      - If disconnected=true: skip event/close, remove from Map if present, log "Client disconnected before callback response applied"
      - This guards against race condition window between first disconnected check (Step 7) and event write (Step 8)
- States / transitions:
  - Connection states: pending_callback → open → closed
  - Transition guards:
    - Non-2xx response: pending_callback → closed (no stream opened)
    - Client disconnect during callback: pending_callback → closed (disconnected flag set)
    - 2xx response with close=true: pending_callback → closed (stream opened briefly, event sent if present, then closed)
    - 2xx response without close: pending_callback → open (normal SSE stream)
- Hotspots:
  - JSON parsing in callback path adds latency (mitigated by 5s timeout covering total callback time including parsing)
  - Event formatting and writing must happen before setting heartbeat timer
  - Ordering critical: event MUST be sent before close (if both present)
- Evidence: `src/routes/sse.ts:46-187` - SSE route handler flow; `src/callback.ts:128-185` - callback sending

- Flow: Disconnect callback with response body (best-effort)
- Steps:
  1. Client disconnects or server closes connection
  2. Gateway cleans up connection state (clear heartbeat, remove from Map)
  3. Gateway sends POST to Python callback URL with disconnect payload
  4. Python responds with status + optional JSON body
  5. Gateway reads response body and parses JSON (lenient)
  6. If response has event or close: log warning (connection already closed, cannot apply)
  7. Return (best-effort complete)
- States / transitions: N/A (linear flow, connection already closed)
- Hotspots:
  - Response body fields for disconnect callbacks are informational only (connection already closing)
  - Parsing errors must not throw (best-effort disconnect callback)
- Evidence: `src/routes/sse.ts:202-243` - handleDisconnect function

- Flow: Event send and close ordering (shared logic)
- Steps:
  1. Check if event present in data
  2. If event present: format SSE event via formatSseEvent()
  3. If event present: write to response stream, check write success
  4. If write fails: cleanup connection, send disconnect callback with reason="error", return error
  5. If close=true: cleanup connection (clear timer, remove from Map), send disconnect callback with reason="server_closed", end response
  6. Return success
- States / transitions: N/A (sequential operations)
- Hotspots:
  - CRITICAL ORDERING: event write MUST complete before close
  - Write failure during event send must trigger disconnect callback
- Evidence: `src/routes/internal.ts:114-167` - existing implementation of send/close logic

## 6) Derived State & Invariants

- Derived value: Connection state after callback
  - Source: Callback HTTP status code (2xx vs non-2xx) + response body close field (true vs false/absent)
  - Writes / cleanup:
    - Non-2xx: no connection created, no Map entry, no heartbeat timer
    - 2xx + close=true: connection created briefly, event sent if present, then removed from Map, heartbeat timer cleared, disconnect callback sent
    - 2xx + no close: connection added to Map, heartbeat timer started, remains open
  - Guards:
    - Must check disconnected flag before adding to Map (race condition)
    - Must clear heartbeat timer before removing from Map
    - Must send disconnect callback only if connection was in Map
  - Invariant: Connection is in Map if and only if it has been successfully opened and not yet closed
  - Evidence: `src/routes/sse.ts:131-151` - connection opening logic; `src/connections.ts:36` - connections Map

- Derived value: Event content from callback response
  - Source: Parsed JSON response body from Python callback (filtered/validated)
  - Writes / cleanup:
    - If valid event with data: written to SSE stream via formatSseEvent()
    - If invalid event structure: logged as warning, no write
  - Guards:
    - event.data must be string (required if event present)
    - event.name must be string or undefined (optional)
    - JSON parsing errors caught and logged
  - Invariant: Only valid SSE events are written to stream; invalid events never cause stream corruption
  - Evidence: `src/sse.ts:41-61` - formatSseEvent implementation; `src/routes/internal.ts:74-94` - validation logic for event structure

- Derived value: Disconnect callback reason
  - Source: How connection ended (client close, server close, error)
  - Writes / cleanup:
    - Sent in disconnect callback payload to Python
    - Determines whether callback response should be applied (hint: it shouldn't, connection already closing)
  - Guards:
    - client_closed: set by handleDisconnect when 'close' event fires
    - server_closed: set by handleServerClose when close=true in /internal/send or callback response
    - error: set when write fails in /internal/send
  - Invariant: Disconnect callback always includes exactly one reason; reason accurately reflects how connection ended
  - Evidence: `src/callback.ts:18` - DisconnectReason type; `src/routes/sse.ts:226-231` - client_closed; `src/routes/internal.ts:206-212` - server_closed

- Derived value: Response body parsing result
  - Source: response.json() from Python callback, filtered through validation
  - Writes / cleanup:
    - Stored in CallbackResult.responseBody if valid
    - Used to send event and/or close connection
    - Never persisted beyond request lifecycle
  - Guards:
    - JSON parse errors caught, treated as empty `{}`
    - Type validation errors logged, fields ignored
    - Timeout/network errors mean no body available (responseBody undefined)
  - Invariant: responseBody is undefined OR contains valid CallbackResponseBody structure; never contains invalid data
  - Evidence: New implementation in callback.ts sendCallback function

## 7) Consistency, Transactions & Concurrency

- Transaction scope: Single request lifecycle (SSE connection establishment or /internal/send operation)
- Atomic requirements:
  - Event send + close must be atomic per connection: if close=true, event (if present) must be written before connection ends
  - Connection Map operations: add/remove must happen in correct order relative to heartbeat timer and callbacks
  - No database transactions (all in-memory state)
- Retry / idempotency:
  - Callbacks are best-effort, no retries (existing behavior maintained)
  - Client can retry GET request if connection fails (idempotent - new token generated each time)
  - Response body actions not idempotent (event sent once when callback returns, not retriable)
- Ordering / concurrency controls:
  - Single-threaded event loop guarantees ordering within a connection
  - Race condition: client disconnect during callback handled via disconnected flag (existing mechanism)
  - Multiple connections are independent (Map keyed by token)
  - Event ordering within connection: callback response event → heartbeats → /internal/send events → close
- Evidence: `CLAUDE.md` line 20 - "Event Loop Ordering: All events for a token are automatically serialized by Node's event loop"; `src/routes/sse.ts:83-90` - disconnected flag for race condition; `src/connections.ts:36` - Map ensures independence

## 8) Errors & Edge Cases

- Failure: Callback response body is invalid JSON
- Surface: sendCallback in callback.ts
- Handling: Catch JSON parse error, log warning with token, set responseBody to undefined, proceed as if no body
- Guardrails: JSON.parse wrapped in try-catch; lenient validation; never throws to caller
- Evidence: Change brief line 27 - default to `{}`; need to implement lenient parsing

- Failure: Callback response has event but event.data is missing or wrong type
- Surface: Callback response parsing in sendCallback
- Handling: Log warning with token, ignore event field entirely, treat as if event not present
- Guardrails: Type checks before accessing event.data; never assume structure
- Evidence: `src/routes/internal.ts:82-86` - existing validation pattern for event.data

- Failure: Callback response has close but it's not boolean
- Surface: Callback response parsing in sendCallback
- Handling: Log warning with token, ignore close field, treat as close=false
- Guardrails: typeof check for close field
- Evidence: `src/routes/internal.ts:97-101` - existing validation pattern for close

- Failure: Write fails when sending event from callback response
- Surface: SSE route handler after successful callback
- Handling: Cleanup connection (clear timer, remove from Map), send disconnect callback with reason="error", return 500 to client (but client already received headers, so will see broken stream)
- Guardrails: Wrap write in try-catch; check write success return value
- Evidence: `src/routes/internal.ts:139-161` - existing write failure handling pattern

- Failure: Callback timeout (>5s) means response body not available
- Surface: sendCallback in callback.ts
- Handling: Timeout error caught, responseBody remains undefined, existing timeout handling proceeds (return 504 to client)
- Guardrails: AbortSignal.timeout(5000) already in place; response.json() will abort if timeout fires
- Evidence: `src/callback.ts:142` - existing timeout implementation

- Failure: Disconnect callback returns event or close but connection already closed
- Surface: sendDisconnectCallback in callback.ts
- Handling: Log warning message that response body ignored for disconnect callbacks (connection already closing, cannot apply)
- Guardrails: Check if responseBody present after parsing, log WARN if event or close fields present
- Evidence: New logic needed in sendDisconnectCallback

- Failure: Client disconnects during callback and callback response has event/close
- Surface: SSE route handler after callback returns
- Handling: disconnected flag set, do not add to Map, do not send event, log early disconnect
- Guardrails: Check connectionRecord.disconnected before sending event/close
- Evidence: `src/routes/sse.ts:132-138` - existing race condition handling

- Failure: Callback returns 2xx with close=true but no event
- Surface: SSE route handler
- Handling: Open stream with headers, immediately close with disconnect callback reason="server_closed", valid use case
- Guardrails: Check close field independent of event field
- Evidence: Change brief line 30 - close can be present without event

## 9) Observability / Telemetry

- Signal: Callback response body parsed
- Type: Structured log (INFO level)
- Trigger: After successfully parsing callback response body with event or close fields
- Labels / fields:
  - token: connection token
  - hasEvent: boolean (whether event field present)
  - hasClose: boolean (whether close field present)
  - eventName: event.name if present
- Consumer: Debugging callback response handling, understanding Python backend behavior
- Evidence: Existing log pattern at `src/routes/internal.ts:136-138` - similar event send logging

- Signal: Callback response body parse error
- Type: Structured log (ERROR level)
- Trigger: When response.json() fails or body structure invalid
- Labels / fields:
  - token: connection token
  - action: "connect" or "disconnect"
  - error: error message
- Consumer: Alerting on misconfigured Python backend responses
- Evidence: Existing error logging at `src/callback.ts:182` - callback failure logging

- Signal: Disconnect callback response body ignored
- Type: Structured log (WARN level)
- Trigger: When disconnect callback returns event or close fields (cannot be applied)
- Labels / fields:
  - token: connection token
  - reason: disconnect reason
  - responseBodyPresent: true
- Consumer: Understanding when Python backend returns unnecessary data in disconnect callbacks; signals this is unexpected behavior
- Evidence: New telemetry for disconnect callback response handling

- Signal: Event sent from callback response
- Type: Structured log (INFO level)
- Trigger: After successfully writing event from callback response to SSE stream
- Labels / fields:
  - token: connection token
  - eventName: event.name or "(unnamed)"
  - dataLength: event.data.length
  - source: "callback_response"
  - url: connection request URL
- Consumer: Tracking event delivery, debugging SSE streams
- Evidence: Existing log pattern at `src/routes/internal.ts:136-138` - event send logging

- Signal: Connection closed from callback response
- Type: Structured log (INFO level)
- Trigger: When callback response has close=true and connection closes immediately
- Labels / fields:
  - token: connection token
  - source: "callback_response"
  - eventSent: boolean (whether event was sent before close)
- Consumer: Understanding connection lifecycle, debugging premature closes
- Evidence: Existing log pattern at `src/routes/internal.ts:204` - server close logging

## 10) Background Work & Shutdown

- Worker / job: No new background workers
- Trigger cadence: N/A
- Responsibilities: N/A
- Shutdown handling: Existing heartbeat timers cleanup unchanged
- Evidence: `src/routes/sse.ts:154-182` - existing heartbeat implementation continues unchanged

## 11) Security & Permissions

- Concern: Data exposure - callback response body contains event data from Python
- Touchpoints: SSE route handler, callback response parsing
- Mitigation:
  - Event data sent to client is controlled by Python backend (Python is source of truth for authorization)
  - SSEGateway does not add authorization - relies on Python to send appropriate events
  - No additional exposure beyond what /internal/send already allows
- Residual risk: Python backend must validate event content appropriately; SSEGateway trusts Python (acceptable - Python is the authorization layer)
- Evidence: `CLAUDE.md` line 352-356 - "No authentication/authorization" policy

- Concern: Denial of service - large event data in callback response
- Touchpoints: response.json() parsing, event formatting, stream writing
- Mitigation:
  - Callback timeout (5s) limits total response time including parsing
  - No explicit size limit on event.data (same as /internal/send)
  - Node.js will handle backpressure via write() return value
- Residual risk: Very large events can slow down response processing; acceptable (Python controls event size, can rate limit connections)
- Evidence: `src/callback.ts:142` - timeout; `src/routes/internal.ts:120-131` - backpressure handling

## 12) UX / UI Impact

Not applicable - backend service with no UI.

## 13) Deterministic Test Plan

- Surface: Connect callback with event in response
- Scenarios:
  - Given Python returns 200 with event in body, When SSE connection opens, Then event is sent to client before normal stream opens
  - Given Python returns 200 with named event, When SSE connection opens, Then event includes correct event name in SSE format
  - Given Python returns 200 with multi-line event data, When SSE connection opens, Then event is formatted with multiple data: lines per SSE spec
- Fixtures / hooks:
  - MockServer.setResponseBody() method to configure custom response bodies
  - SSE stream reader to capture events from SSE response
  - Assertions on event order (callback event before heartbeat)
- Gaps: None
- Evidence: `__tests__/integration/sse.test.ts:49-95` - existing connect callback tests; `__tests__/utils/sseParser.ts` - SSE parsing utilities

- Surface: Connect callback with close in response
- Scenarios:
  - Given Python returns 200 with close=true only, When SSE connection opens, Then stream opens and immediately closes with reason="server_closed"
  - Given Python returns 200 with event and close=true, When SSE connection opens, Then event sent first, then stream closes with reason="server_closed"
  - Given Python returns 200 with close=false, When SSE connection opens, Then stream remains open normally
- Fixtures / hooks:
  - MockServer.setResponseBody() with close variations
  - Verify disconnect callback sent with correct reason
  - Verify connection removed from Map after close
- Gaps: None
- Evidence: `__tests__/utils/mockServer.ts:194-197` - response handling; needs enhancement

- Surface: Connect callback with invalid response body
- Scenarios:
  - Given Python returns 200 with invalid JSON body, When parsing response, Then treated as empty `{}` and logged, stream opens normally
  - Given Python returns 200 with event missing data field, When parsing response, Then event ignored, logged, stream opens normally
  - Given Python returns 200 with close as string "true", When parsing response, Then close ignored, logged, stream opens normally
  - Given Python returns 200 with empty body `{}`, When parsing response, Then stream opens normally (no event, no close)
- Fixtures / hooks:
  - MockServer.setResponseBody() with invalid structures
  - Log capture to verify warnings logged
  - Verify connection still opens successfully despite invalid body
- Gaps: None
- Evidence: Lenient validation requirements from change brief

- Surface: Connect callback response with client disconnect race condition
- Scenarios:
  - Given Python returns 200 with event+close AND client disconnects between callback return and event write, When disconnect detected, Then no write attempted, no spurious error callback, disconnect reason is client_closed not error (`__tests__/integration/sse.test.ts::test_connect_callback_response_client_disconnect_race`)
- Fixtures / hooks:
  - Client disconnect simulation between callback return and event processing
  - Verify disconnected flag checked before applying callback response
  - Verify no spurious "error" disconnect callbacks
- Gaps: None
- Evidence: Race condition guard in Section 5, Step 11

- Surface: Disconnect callback with response body
- Scenarios:
  - Given client disconnects and Python returns disconnect callback with event, When disconnect processed, Then event ignored (connection closed) and WARN log written
  - Given server closes and Python returns disconnect callback with close=true, When disconnect processed, Then close ignored and WARN logged
  - Given disconnect callback returns invalid JSON, When disconnect processed, Then error logged but cleanup completes (best-effort)
- Fixtures / hooks:
  - MockServer.setResponseBody() for disconnect callbacks
  - Log capture to verify ignored response bodies logged at WARN level
  - Verify connection cleanup completes regardless of response body
- Gaps: **Note** - Disconnect callback response bodies cannot be applied because connection is already closing (Map removed, timer cleared, stream ending). Response bodies are parsed for forwards compatibility but never applied. This is a limitation that should be clearly documented.
- Evidence: `__tests__/integration/sse.test.ts:332-373` - existing disconnect tests

- Surface: Callback timeout with response body
- Scenarios:
  - Given Python callback takes >5s to return body, When timeout fires, Then responseBody undefined, existing timeout handling proceeds
- Fixtures / hooks:
  - MockServer.setDelay(6000) to trigger timeout
  - Verify 504 returned to client
  - Verify responseBody undefined in callback result
- Gaps: None
- Evidence: `__tests__/integration/sse.test.ts:304-313` - existing timeout test

- Surface: Event ordering with callback response
- Scenarios:
  - Given callback returns event, When SSE stream opens, Then callback event appears before first heartbeat
  - Given callback returns event and /internal/send sends another event, When both processed, Then callback event appears first
- Fixtures / hooks:
  - SSE stream reader to capture event order
  - POST to /internal/send after connection established
  - Assertions on event sequence
- Gaps: None
- Evidence: Event loop ordering guarantees from `CLAUDE.md` line 20

- Surface: /internal/send endpoint (regression tests)
- Scenarios:
  - Given /internal/send with event, When processed, Then event sent (existing behavior)
  - Given /internal/send with close, When processed, Then connection closed (existing behavior)
  - Given /internal/send with event and close, When processed, Then event sent first, then close (existing behavior)
- Fixtures / hooks: Existing test fixtures unchanged
- Gaps: None - verify no regressions after extracting shared logic
- Evidence: `__tests__/integration/send.test.ts` - existing send endpoint tests

## 14) Implementation Slices

- Slice: 1 - Type definitions and callback parsing
- Goal: Define shared types and extend callback functions to parse response bodies
- Touches:
  - `src/callback.ts`: Define CallbackResponseBody interface, extend CallbackResult, modify sendCallback to read and parse response.json()
- Dependencies: None - standalone changes to callback module

- Slice: 2 - MockServer enhancement for testing
- Goal: Enable MockServer to return custom response bodies for test scenarios
- Touches:
  - `__tests__/utils/mockServer.ts`: Add setResponseBody() method, modify sendResponse() to use configured body
- Dependencies: Slice 1 complete (to test with actual callback parsing)

- Slice: 3 - SSE route handler integration
- Goal: Extract shared event-send-and-close logic; apply callback response body actions in SSE route handler; add logging for disconnect callback responses
- Touches:
  - `src/routes/internal.ts`: Extract handleEventAndClose() from POST /internal/send into exported function (lines 114-167)
  - `src/routes/sse.ts`: Import handleEventAndClose from internal.ts; add logic after successful connect callback to re-check disconnected flag, then call handleEventAndClose if responseBody has event or close
  - `src/callback.ts`: Update sendDisconnectCallback to log WARN if disconnect callback has responseBody with event or close fields
- Dependencies: Slice 1 complete (CallbackResult has responseBody field)

- Slice: 4 - Test coverage
- Goal: Comprehensive tests for all callback response body scenarios
- Touches:
  - `__tests__/integration/sse.test.ts`: Add new test suites for callback response with event, close, both, invalid bodies
  - `__tests__/integration/send.test.ts`: Run existing tests to verify no regressions
- Dependencies: Slices 1-3 complete (full implementation ready for testing)

## 15) Risks & Open Questions

### Risks

- Risk: Python backend returns very large event data in callback response
- Impact: Slow callback processing, potential timeout if JSON parsing takes >5s
- Mitigation: Existing 5s timeout covers total callback time; document recommended event size limits in Python backend integration guide

- Risk: Backwards compatibility - existing Python backends don't send response bodies
- Impact: If parsing breaks on empty/missing bodies, existing integrations fail
- Mitigation: Lenient parsing with empty `{}` default; thoroughly test with no body, empty body, invalid JSON

- Risk: Change brief requires supporting disconnect callback response bodies, but these cannot be applied because disconnect callbacks are sent after connection cleanup (Map removal, timer cleared, stream ending)
- Impact: Developers may expect disconnect callback responses to work like connect callback responses, causing confusion when events/close directives are ignored
- Mitigation: Document clearly in callback.ts and plan that disconnect callback response bodies are parsed for forwards compatibility but never applied; log at WARN level (not INFO) to signal this is unexpected; consider clarifying with product owner if disconnect callback responses should be removed from scope entirely

- Risk: Event ordering confusion - callback event vs /internal/send events
- Impact: Developers may not understand when callback event appears in stream
- Mitigation: Clear documentation of event ordering; logging distinguishes callback events from send events (source field)

- Risk: Write failure when sending callback response event
- Impact: Connection fails after callback succeeded but before stream fully opens
- Mitigation: Existing error handling for write failures applies; send disconnect callback with reason="error"; client sees broken stream (acceptable edge case)

### Open Questions

None - change brief is clear and all design decisions resolved during research phase.

## 16) Confidence

Confidence: High - This is a straightforward extension of existing callback and event sending mechanisms with well-defined behavior, clear test scenarios, and no complex state management or external dependencies. The change reuses proven patterns from `/internal/send` and maintains strict backwards compatibility.
