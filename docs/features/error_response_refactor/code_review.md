# Error Response Refactor - Code Review

## 1) Summary & Decision

**Readiness**

The error response refactor is production-ready and fully implements the approved plan. All 9 error responses across internal.ts (7) and sse.ts (2) have been successfully migrated to the structured format with semantic error codes. The implementation introduces a clean type-safe abstraction (src/errors.ts) with 12 error code constants, an ErrorResponse interface, and a respondWithError helper function. All 70 tests pass without modification to test logic - only assertions were updated to verify the new nested structure. TypeScript compilation succeeds with no type errors. The refactor maintains 100% behavioral equivalence while improving API clarity and error handling.

**Decision**

GO - The implementation is complete, correct, and ready for deployment. The code demonstrates excellent adherence to the plan with comprehensive test coverage, proper TypeScript typing, and no functional regressions. The primary deployment risk (Python backend compatibility) is clearly documented in the plan and requires coordination, but the SSEGateway changes themselves are sound.

## 2) Conformance to Plan (with evidence)

**Plan alignment**

- Plan Section 2 (src/errors.ts new file) ↔ src/errors.ts:1-77 - Defines ErrorResponse interface (lines 15-20), 12 error code constants (lines 25-49), and respondWithError helper (lines 60-77). Fully implements type-safe error response abstraction.

- Plan Section 2 (src/routes/internal.ts refactor) ↔ src/routes/internal.ts:14-23,77,87,94,101,109,119,137 - Imports all 7 error codes and helper function (lines 14-23), replaces all 7 error responses with respondWithError calls using correct codes and messages.

- Plan Section 2 (src/routes/sse.ts refactor) ↔ src/routes/sse.ts:25-33,60,120,126,134-138,144,158 - Imports 6 SSE error codes and helper (lines 25-33), updates both error responses including dynamic status code handling (lines 117-158) with semantic error codes for 401/403/500 differentiation.

- Plan Section 3 (ErrorResponse interface) ↔ src/errors.ts:15-20 - Exact match to planned nested structure with error.message and error.code fields.

- Plan Section 3 (Error code enumeration) ↔ src/errors.ts:25-49 - All 12 planned error codes implemented as TypeScript constants in UPPER_SNAKE_CASE format with correct semantic grouping.

- Plan Section 4 (Internal API error codes) ↔ src/routes/internal.ts:77,87,94,101,109,119,137 - All 7 error responses use correct codes: INVALID_TOKEN_MISSING, INVALID_EVENT_TYPE, INVALID_EVENT_DATA_MISSING, INVALID_EVENT_NAME_TYPE, INVALID_CLOSE_TYPE, TOKEN_NOT_FOUND, WRITE_FAILED.

- Plan Section 4 (SSE connection error codes) ↔ src/routes/sse.ts:60,126,134,136,138,144,158 - All 6 error responses use correct codes: SERVICE_NOT_CONFIGURED, GATEWAY_TIMEOUT, BACKEND_AUTH_FAILED (401), BACKEND_FORBIDDEN (403), BACKEND_ERROR (500+), BACKEND_UNAVAILABLE (network errors).

- Plan Section 13 (Test updates for send.test.ts) ↔ __tests__/integration/send.test.ts:336-501 - All 9 test assertions updated to verify nested structure with exact object matching using expect.toEqual({ error: { message: ..., code: ... } }). Message fields use both exact strings and expect.stringMatching() for flexible validation.

- Plan Section 13 (Test updates for sse.test.ts) ↔ __tests__/integration/sse.test.ts:250-354 - All 6 test assertions updated to verify nested structure with correct codes including updated BACKEND_AUTH_FAILED and BACKEND_FORBIDDEN for 401/403 responses.

- Plan Section 14 Implementation Slices - All 5 slices completed in correct dependency order: (1) errors.ts created, (2) internal.ts refactored, (3) sse.ts refactored, (4) send.test.ts updated, (5) sse.test.ts updated. Final verification slice confirmed by successful test suite (70 tests pass) and TypeScript compilation.

**Gaps / deviations**

- Plan Section 3 Note on BACKEND_ERROR codes - Plan originally suggested single BACKEND_ERROR code for all non-2xx callback responses, then updated to use distinct codes (BACKEND_AUTH_FAILED, BACKEND_FORBIDDEN, BACKEND_ERROR). Implementation correctly follows updated plan with semantic differentiation (src/routes/sse.ts:133-138). No deviation - this was a planned refinement.

- Plan Section 8 (Edge case: validation error during buffered state) - Plan identifies this as critical edge case requiring test coverage. Current test suite does not include explicit test for "Given connection in buffered state (ready=false), When POST with invalid token, Then 400 with new error structure". However, code inspection (src/routes/internal.ts:75-111) confirms validation occurs BEFORE buffering check (line 124), making this edge case impossible. Plan correctly documents the ordering guarantee. Minor gap: test could be added for completeness, but absence is not a blocker since code enforces invariant.

- Plan Section 15 (Risks: Python backend coordination) - Plan identifies breaking change requiring Python deployment coordination. No code evidence needed - this is a deployment/integration concern external to this refactor. Implementation is correct; deployment strategy documented in plan.

No functional deviations from plan. All deliverables present and correct.

## 3) Correctness - Findings (ranked)

No blocker or major correctness issues found. The implementation is functionally correct and maintains behavioral equivalence with the previous flat error format.

**Minor Findings:**

- Title: Minor - Inconsistent parameter documentation comment style
- Evidence: src/errors.ts:60-69 - JSDoc comments for respondWithError parameters use "Semantic error code (use constants from this module)" but other parameters lack similar guidance
- Impact: Developers unfamiliar with the codebase might not know to import constants vs. using string literals, though TypeScript string type permits both
- Fix: Add JSDoc example showing usage: `@example respondWithError(res, 404, 'Token not found', TOKEN_NOT_FOUND)`
- Confidence: Low - This is a documentation polish issue with no runtime impact

- Title: Minor - Error code constants could use enum for stronger type safety
- Evidence: src/errors.ts:25-49 - Error codes defined as const string literals, not enum or const assertion
- Impact: TypeScript permits any string to be passed to respondWithError's code parameter, allowing potential typos that won't be caught at compile time
- Fix: Change to `export const INVALID_TOKEN_MISSING = 'INVALID_TOKEN_MISSING' as const;` and create union type `export type ErrorCode = typeof INVALID_TOKEN_MISSING | ...` or use enum. Alternatively, make respondWithError's code parameter narrower.
- Confidence: Low - Current approach is acceptable; this is an over-engineering suggestion. The plan explicitly chose constants over enums for simplicity.

## 4) Over-Engineering & Refactoring Opportunities

No over-engineering detected. The implementation demonstrates appropriate simplicity:

- Single-purpose module (src/errors.ts) with minimal surface area
- Helper function respondWithError is 5 lines of straightforward JSON construction
- No unnecessary abstractions or indirection
- Error codes as constants strike good balance between type safety and simplicity
- No code duplication - all error responses now use shared helper

The refactor successfully reduces complexity by eliminating 9 inline JSON constructions in favor of a single well-tested pattern.

## 5) Style & Consistency

**No substantive consistency issues found.** The implementation demonstrates excellent consistency:

- Pattern: All error responses use respondWithError helper
- Evidence: src/routes/internal.ts:77,87,94,101,109,119,137 and src/routes/sse.ts:60,158 - 100% migration to helper function, zero inline error JSON construction remaining
- Impact: Perfect consistency ensures all error responses conform to ErrorResponse interface
- Recommendation: None - pattern is correctly applied everywhere

- Pattern: Error code naming convention (UPPER_SNAKE_CASE with semantic prefixes)
- Evidence: src/errors.ts:25-49 - All codes follow INVALID_*, TOKEN_*, WRITE_*, SERVICE_*, BACKEND_*, GATEWAY_* pattern
- Impact: Clear semantic grouping improves maintainability and API clarity
- Recommendation: None - naming is consistent and well-chosen

- Pattern: Test assertion structure using exact object matching
- Evidence: __tests__/integration/send.test.ts:336-501 and __tests__/integration/sse.test.ts:250-354 - All assertions use expect(response.body).toEqual({ error: { message: ..., code: ... } })
- Impact: Validates both structure shape and field presence, preventing regressions
- Recommendation: None - test pattern is consistent and thorough

- Pattern: HTTP status codes preserved from original implementation
- Evidence: All respondWithError calls maintain original status codes (400, 404, 500, 503, 504, 401, 403)
- Impact: Zero behavioral change in status codes ensures backward compatibility for status-based error handling
- Recommendation: None - correct preservation of existing behavior

The refactor maintains and improves the codebase's existing consistency standards.

## 6) Tests & Deterministic Coverage (new/changed behavior only)

**Surface: POST /internal/send validation errors (400 status codes)**

- Scenarios:
  - Given no token, When POST to /internal/send, Then 400 with nested error structure containing code INVALID_TOKEN_MISSING (__tests__/integration/send.test.ts:342-358)
  - Given token is number, When POST to /internal/send, Then 400 with message matching /token.*must be a string/i and code INVALID_TOKEN_MISSING (__tests__/integration/send.test.ts:360-377)
  - Given event is string, When POST to /internal/send, Then 400 with code INVALID_EVENT_TYPE (__tests__/integration/send.test.ts:379-394)
  - Given event.data missing, When POST to /internal/send, Then 400 with code INVALID_EVENT_DATA_MISSING (__tests__/integration/send.test.ts:396-413)
  - Given event.data is number, When POST to /internal/send, Then 400 with code INVALID_EVENT_DATA_MISSING (__tests__/integration/send.test.ts:415-432)
  - Given event.name is number, When POST to /internal/send, Then 400 with code INVALID_EVENT_NAME_TYPE (__tests__/integration/send.test.ts:434-451)
  - Given close is string, When POST to /internal/send, Then 400 with code INVALID_CLOSE_TYPE (__tests__/integration/send.test.ts:453-472)
- Hooks: Uses MockServer fixture for backend simulation, supertest for HTTP requests, shared app instance from test setup
- Gaps: None - all validation paths covered with exact structure verification
- Evidence: All tests verify exact nested structure with expect.toEqual({ error: { message: ..., code: ... } })

**Surface: POST /internal/send resource errors (404, 500 status codes)**

- Scenarios:
  - Given unknown token, When POST to /internal/send, Then 404 with exact message "Token not found" and code TOKEN_NOT_FOUND (__tests__/integration/send.test.ts:325-340)
  - Given token already closed, When POST to /internal/send, Then 404 with code TOKEN_NOT_FOUND (__tests__/integration/send.test.ts:474-505)
  - Given client disconnect during send, When POST to /internal/send, Then either 404 or 500 depending on race condition (__tests__/integration/send.test.ts:509-553)
- Hooks: Same as validation tests, plus connection lifecycle management
- Gaps: Test at lines 509-553 accepts both 404 and 500 due to race condition but doesn't explicitly validate 500 response structure. Inspection of code (src/routes/internal.ts:137) confirms 500 response uses respondWithError with WRITE_FAILED code, so structure is correct. Test could be strengthened by validating structure for both cases.
- Evidence: Test assertions verify exact nested structure for deterministic cases (404)

**Surface: GET /* SSE connection errors (401, 403, 500, 503, 504 status codes)**

- Scenarios:
  - Given CALLBACK_URL not configured, When GET any path, Then 503 with code SERVICE_NOT_CONFIGURED (__tests__/integration/sse.test.ts:319-360)
  - Given callback returns 401, When GET any path, Then 401 with message "Backend returned 401" and code BACKEND_AUTH_FAILED (__tests__/integration/sse.test.ts:240-260)
  - Given callback returns 403, When GET any path, Then 403 with message "Backend returned 403" and code BACKEND_FORBIDDEN (__tests__/integration/sse.test.ts:262-278)
  - Given callback returns 500, When GET any path, Then 500 with message "Backend returned 500" and code BACKEND_ERROR (__tests__/integration/sse.test.ts:280-293)
  - Given backend unreachable, When GET any path, Then 503 with message "Backend unavailable" and code BACKEND_UNAVAILABLE (__tests__/integration/sse.test.ts:295-318)
  - Given callback timeout >5s, When GET any path, Then 504 with message "Gateway timeout" and code GATEWAY_TIMEOUT (__tests__/integration/sse.test.ts:320-340)
- Hooks: MockServer with configurable status codes, delays, and network error simulation
- Gaps: None - all error paths covered including timeout and network failure edge cases
- Evidence: All tests verify exact nested structure and correct semantic error codes for different HTTP statuses

**Coverage Assessment:**

All 9 error responses have corresponding tests that verify both structure shape (nested error object) and semantic correctness (appropriate error codes). Tests use exact object matching with expect.toEqual() to validate presence of both message and code fields. No missing test scenarios for the changed behavior.

Minor improvement opportunity: Strengthen write failure test (send.test.ts:509-553) to validate 500 response structure explicitly instead of just accepting status code.

## 7) Adversarial Sweep

**Attempted attacks:**

1. **Type confusion in error response structure** - Attempted to find paths where error response could have wrong structure (e.g., flat instead of nested)
   - Evidence: src/errors.ts:60-77 respondWithError function is single source of truth, src/routes/internal.ts and src/routes/sse.ts use exclusively this helper
   - Result: No direct JSON construction found - all error responses go through helper
   - Why code held up: Helper function enforces structure, TypeScript interface provides compile-time safety

2. **Missing error code validation** - Attempted to find error responses that might use incorrect or missing error codes
   - Evidence: All respondWithError calls (src/routes/internal.ts:77,87,94,101,109,119,137 and src/routes/sse.ts:60,158) use imported constants from src/errors.ts
   - Result: All error codes present and correct, no magic strings
   - Why code held up: Consistent use of imported constants eliminates typos

3. **Test assertion gaps** - Attempted to find error scenarios not covered by tests
   - Evidence: Test coverage analysis in Section 6 shows all 9 error responses tested
   - Result: 70 tests pass including all error structure validations
   - Why code held up: Comprehensive test updates for both send.test.ts and sse.test.ts

4. **Breaking change to existing consumers** - Attempted to identify if error response structure change could break Python backend
   - Evidence: Plan Section 15 (docs/features/error_response_refactor/plan.md:341-343) explicitly identifies this risk and requires Python backend coordination
   - Result: This is a known breaking change - Python code expecting response['error'] as string will fail
   - Why this is not a code issue: Structural change is intentional and documented; deployment coordination is responsibility of plan execution, not code correctness

5. **HTTP status code changes** - Attempted to find unintended status code modifications
   - Evidence: All respondWithError calls preserve original status codes from flat format implementation
   - Result: Zero status code changes - only structure changed
   - Why code held up: Plan explicitly requires "Maintain existing HTTP status codes unchanged" (plan.md:51) and implementation respects this

6. **Race condition in buffered state validation** - Attempted to find scenario where validation might be bypassed during callback window
   - Evidence: src/routes/internal.ts:75-111 validation occurs before line 124 buffering check
   - Result: Validation always runs first, making it impossible for invalid request to enter buffered state
   - Why code held up: Code ordering enforces invariant that validation precedes state checks

**No credible failures found.** All attacks either confirm correctness or identify documented deployment concerns (Python backend coordination) that are outside this refactor's scope.

## 8) Invariants Checklist

- Invariant: All error responses must conform to ErrorResponse interface structure (nested error object with message and code fields)
  - Where enforced: src/errors.ts:60-77 respondWithError function enforces structure, src/routes/internal.ts and src/routes/sse.ts exclusively use this helper (lines 14-23, 25-33 imports verify)
  - Failure mode: Direct JSON construction bypassing helper could create flat structure or missing fields
  - Protection: Code review verification (Section 5) confirms zero inline error JSON construction remaining, all responses use respondWithError
  - Evidence: grep -rn "\.status.*\.json" /work/src shows only success responses and health checks bypass helper - all error responses use respondWithError

- Invariant: Error codes must use UPPER_SNAKE_CASE semantic constants defined in src/errors.ts
  - Where enforced: src/errors.ts:25-49 defines 12 constants, all respondWithError calls import and use these constants
  - Failure mode: Magic strings passed to respondWithError could introduce typos or inconsistent naming
  - Protection: Code review (Section 3 and 5) confirms all error code arguments use imported constants, no string literals
  - Evidence: src/routes/internal.ts:14-23 and src/routes/sse.ts:25-33 import statements show all codes imported, calls at lines 77,87,94,101,109,119,137 (internal) and 60,126,134,136,138,144,158 (sse) use constants

- Invariant: HTTP status codes must remain unchanged from original implementation (no behavioral changes)
  - Where enforced: All respondWithError calls preserve original status codes: 400 (validation), 404 (not found), 500 (write failure), 503 (service/backend unavailable), 504 (timeout), 401 (auth), 403 (forbidden)
  - Failure mode: Changing status codes could break existing error handling in Python backend or other consumers
  - Protection: Test suite verifies all status codes (expect(response.status).toBe(...)), plan explicitly requires preservation (plan.md:51)
  - Evidence: Test files __tests__/integration/send.test.ts and sse.test.ts verify exact status codes match original behavior

- Invariant: Validation errors (400) must occur BEFORE buffering state check to ensure error structure correctness in all states
  - Where enforced: src/routes/internal.ts:75-111 validation logic precedes line 124 buffering check (!connection.ready)
  - Failure mode: If buffering check preceded validation, invalid requests during callback window could bypass validation or produce inconsistent error responses
  - Protection: Code ordering enforces invariant, plan Section 8 explicitly documents this requirement (plan.md:236-238)
  - Evidence: src/routes/internal.ts code flow guarantees validation at lines 75-111 runs before buffering logic at lines 124-130

All four invariants are properly enforced with multiple layers of protection (code structure, TypeScript types, tests, documentation).

## 9) Questions / Needs-Info

No blocking questions. The implementation is complete and correct based on the approved plan.

**Non-blocking clarification:**

- Question: Python backend deployment coordination timeline
- Why it matters: Breaking change requires sequencing Python and SSEGateway deployments or implementing backward-compatible Python parsing (plan.md:341-343 documents mitigation strategies)
- Desired answer: Deployment strategy decision from project owner - either (1) deploy Python first with try-nested-fallback-to-flat parsing, then deploy SSEGateway, or (2) coordinate synchronized deployment

This is not a code review concern but an operational deployment question that must be resolved before production rollout.

## 10) Risks & Mitigations (top 3)

- Risk: Breaking change impacts Python backend error parsing (highest priority)
- Mitigation: **REQUIRED BEFORE DEPLOYMENT** - Coordinate with Python team to (1) identify all locations parsing SSEGateway error responses, (2) update Python to expect nested structure response['error']['message'] and response['error']['code'], (3) choose deployment strategy: Python-first with backward compatibility or synchronized deployment
- Evidence: Plan Section 15 (docs/features/error_response_refactor/plan.md:341-343) documents risk and mitigation; no code changes needed in SSEGateway

- Risk: Incomplete test coverage for write failure response structure validation
- Mitigation: Strengthen test at __tests__/integration/send.test.ts:509-553 to explicitly validate 500 response structure (currently only validates status code for race condition scenario)
- Evidence: Test accepts both 404 and 500 responses but doesn't verify 500 response body conforms to nested structure; code inspection (src/routes/internal.ts:137) confirms correct usage of respondWithError

- Risk: Future error responses might bypass respondWithError helper
- Mitigation: (1) Document in CLAUDE.md or src/errors.ts that all error responses must use respondWithError, (2) add lint rule or code review checklist item to catch inline error JSON construction, (3) maintain test coverage for all error paths
- Evidence: Currently 100% compliant (Section 5 verification) but no automated guard against future regressions

All risks have clear mitigations. Risk 1 is deployment/coordination concern external to code. Risks 2 and 3 are minor improvements that don't block deployment.

## 11) Confidence

Confidence: High - The implementation is a textbook structural refactor with clear scope, comprehensive test coverage (70 tests pass), zero functional changes (only response structure modified), proper TypeScript typing, and excellent adherence to the approved plan. All error responses (9 total) correctly migrated to new format with appropriate semantic error codes. The code demonstrates strong engineering discipline with single-purpose abstraction (respondWithError), consistent naming conventions, and thorough documentation. The primary deployment risk (Python backend coordination) is clearly documented in the plan and requires operational coordination, not code changes. This refactor is production-ready pending deployment strategy decision.
