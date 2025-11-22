# Error Response Refactor - Technical Plan

## 0) Research Log & Findings

### Codebase Discovery

I examined the SSEGateway codebase to identify all error response locations:

**Error responses found:**
- `src/routes/internal.ts` (lines 67, 77, 84, 91, 99, 109, 127): Multiple validation errors and 404/500 responses
- `src/routes/sse.ts` (lines 51, 137): Service configuration errors and callback failures

**Test coverage found:**
- `__tests__/integration/send.test.ts`: Tests for `/internal/send` error scenarios
- `__tests__/integration/sse.test.ts`: Tests for SSE connection error scenarios

**Key findings:**
1. All error responses currently use flat structure: `{ error: "message" }`
2. Error responses span multiple HTTP status codes: 400, 404, 500, 503, 504
3. Tests use direct string matching and regex matching for error messages
4. The codebase is TypeScript ESM with Express 5
5. Health endpoints (`src/routes/health.ts`) return success responses only (lines 26, 45-54)

### Conflicts and Resolutions

**Conflict:** Tests use both exact string matching and regex matching for error messages
**Resolution:** Update tests to match new structure while maintaining semantic equivalence

**Conflict:** No existing error code conventions in the codebase
**Resolution:** Establish UPPER_SNAKE_CASE convention as specified in change brief

## 1) Intent & Scope

**User intent**

Refactor all error responses to use a structured, nested format with semantic error codes. This improves API clarity and enables better error handling by consumers.

**Prompt quotes**

"Refactor all error responses in the codebase to use a structured format with `message` and `code` fields"

"Error codes should be: UPPER_SNAKE_CASE format, Descriptive and semantic, Consistent with the error message"

**In scope**

- Refactor all error responses in `src/routes/internal.ts`
- Refactor all error responses in `src/routes/sse.ts`
- Update test expectations in `__tests__/integration/send.test.ts`
- Update test expectations in `__tests__/integration/sse.test.ts`
- Define semantic error codes for each error scenario
- Maintain existing HTTP status codes unchanged

**Out of scope**

- Health check endpoints (`src/routes/health.ts`) - return success responses, not errors
- Success response formats (remain unchanged)
- HTTP status code changes
- Callback response formats
- Logging message changes

**Assumptions / constraints**

- TypeScript type system will catch structural errors at compile time
- Tests must pass after refactoring with no behavior changes
- Error messages remain human-readable and descriptive
- HTTP status codes are correct and should not be changed

## 2) Affected Areas & File Map

- Area: `src/errors.ts` (new file)
- Why: Define TypeScript interface for error response structure, error code constants, and helper function to ensure type-safe error responses
- Evidence: Review finding requires TypeScript type definitions for compile-time safety and consistency

- Area: `src/routes/internal.ts`
- Why: Contains 7 error responses that need refactoring from flat to nested structure; will use new error helper function
- Evidence: `src/routes/internal.ts:67` - `res.status(400).json({ error: 'Invalid request: token is required and must be a string' })`
  `src/routes/internal.ts:77` - `res.status(400).json({ error: 'Invalid request: event must be an object' })`
  `src/routes/internal.ts:84` - `res.status(400).json({ error: 'Invalid request: event.data is required and must be a string' })`
  `src/routes/internal.ts:91` - `res.status(400).json({ error: 'Invalid request: event.name must be a string' })`
  `src/routes/internal.ts:99` - `res.status(400).json({ error: 'Invalid request: close must be a boolean' })`
  `src/routes/internal.ts:109` - `res.status(404).json({ error: 'Token not found' })`
  `src/routes/internal.ts:127` - `res.status(500).json({ error: 'Write failed: connection closed' })`

- Area: `src/routes/sse.ts`
- Why: Contains 2 error responses that need refactoring from flat to nested structure; dynamic error construction at line 137 requires preserving statusCode/errorMessage variables
- Evidence: `src/routes/sse.ts:51` - `res.status(503).json({ error: 'Service not configured' })`
  `src/routes/sse.ts:137` - `res.status(statusCode).json({ error: errorMessage })` - uses dynamic variables for status/message based on callback result

- Area: `__tests__/integration/send.test.ts`
- Why: Contains test assertions that verify error response structure
- Evidence: `__tests__/integration/send.test.ts:336` - `expect(response.body).toEqual({ error: 'Token not found' })`
  `__tests__/integration/send.test.ts:349` - `expect(response.body.error).toMatch(/token is required/i)`
  `__tests__/integration/send.test.ts:363` - `expect(response.body.error).toMatch(/token.*must be a string/i)`
  `__tests__/integration/send.test.ts:375` - `expect(response.body.error).toMatch(/event must be an object/i)`
  `__tests__/integration/send.test.ts:390` - `expect(response.body.error).toMatch(/event\.data.*required/i)`
  `__tests__/integration/send.test.ts:404` - `expect(response.body.error).toMatch(/event\.data.*must be a string/i)`
  `__tests__/integration/send.test.ts:419` - `expect(response.body.error).toMatch(/event\.name.*must be a string/i)`
  `__tests__/integration/send.test.ts:431` - `expect(response.body.error).toMatch(/close must be a boolean/i)`
  `__tests__/integration/send.test.ts:456` - `expect(response.body).toEqual({ error: 'Token not found' })`

- Area: `__tests__/integration/sse.test.ts`
- Why: Contains test assertions that verify error response structure for SSE connection errors
- Evidence: `__tests__/integration/sse.test.ts:250` - `expect(response.body).toEqual({ error: 'Backend returned 401' })`
  `__tests__/integration/sse.test.ts:267` - `expect(response.body).toEqual({ error: 'Backend returned 403' })`
  `__tests__/integration/sse.test.ts:277` - `expect(response.body).toEqual({ error: 'Backend returned 500' })`
  `__tests__/integration/sse.test.ts:300` - `expect(response.body).toEqual({ error: 'Backend unavailable' })`
  `__tests__/integration/sse.test.ts:311` - `expect(response.body).toEqual({ error: 'Gateway timeout' })`
  `__tests__/integration/sse.test.ts:327` - `expect(response.body).toEqual({ error: 'Service not configured' })`

## 3) Data Model / Contracts

- Entity / contract: Error response TypeScript interface
- Shape:
  ```typescript
  // TypeScript interface for all error responses
  interface ErrorResponse {
    error: {
      message: string;
      code: string;
    };
  }

  // Current format (flat structure)
  { "error": "Token not found" }

  // New format (nested structure conforming to ErrorResponse)
  {
    "error": {
      "message": "Token not found",
      "code": "TOKEN_NOT_FOUND"
    }
  }
  ```
- Refactor strategy: Define TypeScript interface to enforce type safety. Create helper function `respondWithError(res: Response, status: number, message: string, code: string)` to ensure all error responses conform to ErrorResponse interface. Direct replacement - all error responses will be updated simultaneously. No backwards compatibility needed since this is an internal service with single consumer (Python backend).
- Evidence: All error responses across `src/routes/internal.ts` and `src/routes/sse.ts`

- Entity / contract: Error code enumeration
- Shape:
  ```typescript
  // Internal API errors (/internal/send)
  INVALID_TOKEN_MISSING         // 400: token missing or not a string
  INVALID_EVENT_TYPE           // 400: event is not an object
  INVALID_EVENT_DATA_MISSING   // 400: event.data missing or not a string
  INVALID_EVENT_NAME_TYPE      // 400: event.name is not a string
  INVALID_CLOSE_TYPE           // 400: close is not a boolean
  TOKEN_NOT_FOUND              // 404: token not in connections map
  WRITE_FAILED                 // 500: SSE write operation failed

  // SSE connection errors
  SERVICE_NOT_CONFIGURED       // 503: CALLBACK_URL not set
  BACKEND_AUTH_FAILED          // 401: Python callback returned 401
  BACKEND_FORBIDDEN            // 403: Python callback returned 403
  BACKEND_ERROR                // 500: Python callback returned 500
  BACKEND_UNAVAILABLE          // 503: Network error reaching backend
  GATEWAY_TIMEOUT              // 504: Callback exceeded 5 second timeout
  ```
- Refactor strategy: Error codes will be defined as TypeScript string constants in a new `src/errors.ts` file to ensure consistency and enable compile-time validation. This prevents typos and provides IDE autocomplete support. Alternative inline approach acceptable given small number of codes (12 total), but constants provide better maintainability.
- Evidence: Error scenarios documented in `src/routes/internal.ts:56-59` and `src/routes/sse.ts:38-46`

Note on BACKEND_ERROR codes: Originally planned single `BACKEND_ERROR` for all non-2xx callback responses. Updated to use distinct codes (`BACKEND_AUTH_FAILED`, `BACKEND_FORBIDDEN`, `BACKEND_ERROR`) to provide semantic clarity for different HTTP status codes from Python backend, enabling consumers to distinguish authentication/authorization failures from server errors without parsing message field.

## 4) API / Integration Surface

- Surface: POST /internal/send
- Inputs: `{ token: string, event?: { name?: string, data: string }, close?: boolean }`
- Outputs: Error responses with new structure (success responses unchanged)
- Errors:
  - 400 `INVALID_TOKEN_MISSING` - token missing or invalid type
  - 400 `INVALID_EVENT_TYPE` - event is not an object
  - 400 `INVALID_EVENT_DATA_MISSING` - event.data missing or invalid type
  - 400 `INVALID_EVENT_NAME_TYPE` - event.name invalid type
  - 400 `INVALID_CLOSE_TYPE` - close is not a boolean
  - 404 `TOKEN_NOT_FOUND` - connection token not found
  - 500 `WRITE_FAILED` - SSE write operation failed
- Evidence: `src/routes/internal.ts:60-133`

- Surface: GET /<any-path>
- Inputs: Any URL path and headers
- Outputs: SSE stream or error response with new structure
- Errors:
  - 503 `SERVICE_NOT_CONFIGURED` - CALLBACK_URL not configured
  - 401 `BACKEND_AUTH_FAILED` - Python callback returned 401
  - 403 `BACKEND_FORBIDDEN` - Python callback returned 403
  - 500 `BACKEND_ERROR` - Python callback returned 500
  - 503 `BACKEND_UNAVAILABLE` - Network error reaching Python backend
  - 504 `GATEWAY_TIMEOUT` - Callback exceeded timeout
- Evidence: `src/routes/sse.ts:47-139`

## 5) Algorithms & State Machines

- Flow: Error response formatting
- Steps:
  1. Error condition detected (validation failure, resource not found, write failure, etc.)
  2. Determine HTTP status code (unchanged from current behavior)
  3. Determine semantic error code (UPPER_SNAKE_CASE)
  4. Construct nested error object: `{ error: { message: string, code: string } }`
  5. Send JSON response with status code and error object
- States / transitions: None - stateless error formatting
- Hotspots: No performance concerns - simple object construction
- Evidence: All error responses in `src/routes/internal.ts` and `src/routes/sse.ts`

## 6) Derived State & Invariants

No derived state applies to this refactor. Error responses are stateless transformations of error conditions to JSON payloads.

## 7) Consistency, Transactions & Concurrency

- Transaction scope: Not applicable - error responses are synchronous and stateless
- Atomic requirements: None - each error response is independent
- Retry / idempotency: Not applicable - error responses don't modify state
- Ordering / concurrency controls: None required
- Evidence: Error responses are synchronous JSON writes with no side effects

## 8) Errors & Edge Cases

- Failure: Malformed error code (typo, inconsistent casing)
- Surface: Compile-time or runtime in any error response location
- Handling: Define error codes as TypeScript constants in `src/errors.ts` to enable compile-time validation. Use helper function `respondWithError()` that accepts constants. Tests verify exact error codes.
- Guardrails: TypeScript constants prevent typos (must import valid constant). Test assertions verify error codes match expected constant values using exact string matching.
- Evidence: Test expectations in `__tests__/integration/send.test.ts` and `__tests__/integration/sse.test.ts`

- Failure: Test regex patterns no longer match new structure
- Surface: Test execution
- Handling: Update all test assertions to use exact object matching with nested structure: `expect(response.body).toEqual({ error: { message: expect.stringMatching(/pattern/), code: 'ERROR_CODE' } })`
- Guardrails: Test suite must pass before refactor is complete. Exact structure matching verifies both nesting and presence of both message and code fields.
- Evidence: `__tests__/integration/send.test.ts:349-431` uses regex matching; will be updated to verify structure shape

- Failure: Missing error response in refactor
- Surface: Any error scenario in production
- Handling: Comprehensive search for all `.json({ error:` patterns. Run grep pattern `\.json\(\s*\{\s*error:` after implementation.
- Guardrails: Full test suite coverage ensures all error paths tested. Manual code review of all changes in src/routes/*.ts files.
- Evidence: Tests cover all error responses

- Failure: Validation error occurs while connection is in buffered state (ready=false)
- Surface: POST /internal/send
- Handling: Validation errors occur before buffering check (src/routes/internal.ts:64-101 precedes line 114 buffering check), so always return new error format regardless of connection state. This ordering is critical and must be preserved.
- Guardrails: Maintain validation order before buffering check. Add test scenario to verify error structure during buffered state.
- Evidence: `src/routes/internal.ts:64-120`

## 9) Observability / Telemetry

No observability changes required. Error logging already exists and uses message strings which remain unchanged.

- Signal: Error log messages
- Type: Structured logs
- Trigger: Existing error conditions (unchanged)
- Labels / fields: Existing token, url, error message fields (unchanged)
- Consumer: Log aggregation systems (unchanged)
- Evidence: `src/routes/internal.ts:66,76,83,90,98` - logger.error calls remain unchanged

## 10) Background Work & Shutdown

Not applicable - error responses are synchronous HTTP responses with no background work.

## 11) Security & Permissions

- Concern: Information disclosure via error codes
- Touchpoints: All error responses
- Mitigation: Error codes and messages remain semantically equivalent to current messages. No new information disclosed.
- Residual risk: None - error messages already expose validation and resource existence information
- Evidence: Current error messages like "Token not found" and "Service not configured" already expose this information

## 12) UX / UI Impact

Not applicable - this is a backend API service with no UI.

## 13) Deterministic Test Plan

- Surface: POST /internal/send validation errors (400 status)
- Scenarios:
  - Given no token, When POST to /internal/send, Then 400 with `{ error: { message: "Invalid request: token is required and must be a string", code: "INVALID_TOKEN_MISSING" } }` - use exact object match to verify structure shape
  - Given token is number, When POST to /internal/send, Then 400 with `{ error: { message: expect.stringMatching(/token.*must be a string/i), code: "INVALID_TOKEN_MISSING" } }` - verify both fields present
  - Given event is string, When POST to /internal/send, Then 400 with code `INVALID_EVENT_TYPE`
  - Given event.data missing, When POST to /internal/send, Then 400 with code `INVALID_EVENT_DATA_MISSING`
  - Given event.data is number, When POST to /internal/send, Then 400 with code `INVALID_EVENT_DATA_MISSING`
  - Given event.name is number, When POST to /internal/send, Then 400 with code `INVALID_EVENT_NAME_TYPE`
  - Given close is string, When POST to /internal/send, Then 400 with code `INVALID_CLOSE_TYPE`
- Fixtures / hooks: Existing test setup with mock server and supertest
- Gaps: Add test for structure validation (verify `error` is object with exactly `message` and `code` fields). Add test for buffered state: "Given connection in buffered state (ready=false), When POST with invalid token, Then 400 with new error structure"
- Evidence: `__tests__/integration/send.test.ts:324-461`

- Surface: POST /internal/send resource errors (404, 500)
- Scenarios:
  - Given unknown token, When POST to /internal/send, Then 404 with `{ error: { message: "Token not found", code: "TOKEN_NOT_FOUND" } }` - use exact match
  - Given connection closed during send, When POST to /internal/send, Then 500 with code `WRITE_FAILED` - verify existing test coverage at lines 463-509
- Fixtures / hooks: Existing test setup
- Gaps: Verify test coverage exists for write failure scenario (lines 463-509); if missing, add test
- Evidence: `__tests__/integration/send.test.ts:325-337, 463-509`

- Surface: GET /<any-path> SSE connection errors
- Scenarios:
  - Given CALLBACK_URL not configured, When GET any path, Then 503 with `{ error: { message: "Service not configured", code: "SERVICE_NOT_CONFIGURED" } }`
  - Given callback returns 401, When GET any path, Then 401 with code `BACKEND_AUTH_FAILED` (updated from `BACKEND_ERROR`)
  - Given callback returns 403, When GET any path, Then 403 with code `BACKEND_FORBIDDEN` (updated from `BACKEND_ERROR`)
  - Given callback returns 500, When GET any path, Then 500 with code `BACKEND_ERROR`
  - Given backend unreachable, When GET any path, Then 503 with code `BACKEND_UNAVAILABLE`
  - Given callback timeout >5s, When GET any path, Then 504 with code `GATEWAY_TIMEOUT`
- Fixtures / hooks: MockServer with configurable status codes and delays
- Gaps: Update test assertions to verify exact structure shape using `expect(response.body).toEqual({ error: { message: expect.any(String), code: 'EXPECTED_CODE' } })`
- Evidence: `__tests__/integration/sse.test.ts:242-330`

Test assertion strategy: Use exact object matching `expect(response.body).toEqual({ error: { message: ..., code: ... } })` to verify nested structure. For message field, use either exact string match or `expect.stringMatching(/pattern/)` for flexible validation. For code field, always use exact string match to ensure semantic correctness.

## 14) Implementation Slices

- Slice: Create error definitions and helper function
- Goal: TypeScript interface, error code constants, and type-safe helper function defined
- Touches: New file `src/errors.ts` with ErrorResponse interface, error code constants, and respondWithError() helper
- Dependencies: None - foundation for all other slices

- Slice: Update error responses in src/routes/internal.ts
- Goal: All /internal/send errors use new structure via helper function
- Touches: `src/routes/internal.ts` lines 67, 77, 84, 91, 99, 109, 127 - import error constants and use respondWithError()
- Dependencies: Requires src/errors.ts to exist

- Slice: Update error responses in src/routes/sse.ts
- Goal: All SSE connection errors use new structure via helper function
- Touches: `src/routes/sse.ts` lines 51, 137 - import error constants and use respondWithError() with dynamic message/code
- Dependencies: Requires src/errors.ts to exist

- Slice: Update test expectations in send.test.ts
- Goal: All /internal/send tests expect new error structure with exact object matching
- Touches: `__tests__/integration/send.test.ts` lines 336, 349, 363, 375, 390, 404, 419, 431, 456 - update assertions to verify nested structure
- Dependencies: Must be done with or after internal.ts changes; tests will fail until updated

- Slice: Update test expectations in sse.test.ts
- Goal: All SSE connection tests expect new error structure with exact object matching
- Touches: `__tests__/integration/sse.test.ts` lines 250, 267, 277, 300, 311, 327 - update assertions for new error codes (BACKEND_AUTH_FAILED, BACKEND_FORBIDDEN)
- Dependencies: Must be done with or after sse.ts changes; tests will fail until updated

- Slice: Verification and cleanup
- Goal: Ensure all error responses updated and no old format remains
- Touches: Run grep pattern `\.json\(\s*\{\s*error:` to verify all locations updated. Run full test suite. Manual code review of src/routes/*.ts files.
- Dependencies: All previous slices complete

## 15) Risks & Open Questions

**Risks:**

- Risk: Breaking change impacts Python backend error parsing
- Impact: Python code that parses SSEGateway error responses will fail when expecting `response['error']` as string but receiving nested object
- Mitigation: **REQUIRED BEFORE DEPLOYMENT** - Identify all Python code locations that parse SSEGateway error responses (likely in error handlers for `/internal/send` calls and SSE connection establishment). Update Python to expect nested structure: `response['error']['message']` and `response['error']['code']`. Deploy Python changes BEFORE or simultaneously with SSEGateway changes. Consider: (1) Deploy Python first with backward-compatible parsing (try nested, fallback to flat), then deploy SSEGateway, or (2) Coordinate synchronized deployment if Python and SSEGateway deployed together.

- Risk: Inconsistent error code naming or typos
- Impact: Consumer confusion, harder API to use, potential bugs from mismatched error codes
- Mitigation: Define error codes as TypeScript constants in `src/errors.ts` to enable compile-time validation and IDE autocomplete. Use helper function `respondWithError()` that accepts constants. Naming convention: `INVALID_*` for validation errors, `*_NOT_FOUND` for 404s, `BACKEND_*` for backend callback errors, `SERVICE_*` for service configuration errors. All tests verify exact error code strings.

- Risk: Incomplete refactoring leaves inconsistent error format across endpoints
- Impact: API inconsistency confuses consumers, mix of old and new formats
- Mitigation: After code changes, run grep pattern `\.json\(\s*\{\s*error:` to verify all locations updated. Run full integration test suite to catch any tests expecting old format. Manual code review of all changes in src/routes/*.ts files. All error responses go through `respondWithError()` helper to ensure consistency.

- Risk: Test assertions don't properly validate nested structure
- Impact: Tests pass but implementation could have wrong structure (e.g., flat with separate fields instead of nested)
- Mitigation: Use exact object matching: `expect(response.body).toEqual({ error: { message: expect.stringMatching(/pattern/), code: 'ERROR_CODE' } })`. This verifies both nesting and presence of both required fields. At least one test per error surface should use exact string match on message to verify full structure.

**Open Questions:**

- Question: Python backend deployment coordination strategy
- Why it matters: Breaking change requires careful deployment sequencing or backward compatibility handling
- Owner / follow-up: Coordinate with Python backend team to identify error parsing locations and agree on deployment sequence (Python-first, synchronized, or feature-flagged)

## 16) Confidence

Confidence: High — This is a straightforward structural refactor with clear scope, comprehensive test coverage, and no complex business logic changes. All error locations are identified (9 total across internal.ts and sse.ts). TypeScript type safety enforced through ErrorResponse interface and error code constants in src/errors.ts. Helper function ensures consistency. Test plan includes exact structure validation. Primary risk is Python backend coordination, which is mitigated through explicit deployment strategy requirement. Implementation slices provide clear path from types to implementation to verification.
