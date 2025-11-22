# Plan Review — Error Response Refactor

## 1) Summary & Decision

**Readiness**

The plan is well-structured and demonstrates thorough research of the codebase. It correctly identifies all error response locations, understands the test coverage, and proposes a clear structural change from flat to nested error format. The plan shows good understanding of the SSEGateway architecture and maintains appropriate boundaries (no changes to health endpoints, logging, or callback formats). However, there are significant gaps in the deterministic test coverage section, missing consideration of TypeScript type safety, and incomplete analysis of the Python consumer impact.

**Decision**

`GO-WITH-CONDITIONS` — The plan is implementable but requires addressing missing TypeScript error types, expanding test scenarios to cover buffered error cases, and clarifying the Python backend coordination strategy. The core approach is sound, but the implementation needs stronger type safety and more comprehensive test coverage.

## 2) Conformance & Fit (with evidence)

**Conformance to refs**

- `docs/product_brief.md` — **Pass** — `plan.md:106-124` — Plan correctly preserves error handling rules from product brief section 6.2: "Unknown token → 404, Invalid types → 400, Write failure → treat as disconnect". The new structure maintains these status codes.
- `docs/product_brief.md` — **Pass** — `plan.md:54-59` — Plan correctly excludes health endpoints and callback response formats from scope, respecting product brief sections 3.4 and 3.3.
- `docs/commands/plan_feature.md` — **Fail** — `plan.md:106-144` — The plan defines error response structure but does NOT define a TypeScript type or interface for the new error format. Template requirement: "Data shapes new/changed (request/response bodies...)" should include TypeScript interface definitions, not just JSON examples.
- `CLAUDE.md` — **Pass** — `plan.md:217-226` — Plan correctly notes logging messages remain unchanged, preserving the plain text format required by CLAUDE.md.

**Fit with codebase**

- `src/routes/internal.ts` — `plan.md:70-78` — Assumption that all error responses use synchronous `.json()` calls is correct. However, the plan does not verify whether any middleware could intercept or transform error responses.
- `src/routes/sse.ts` — `plan.md:80-83` — Plan identifies error at line 137 uses dynamic `statusCode` and `errorMessage` variables, which is correct. However, gap: plan doesn't specify how to preserve this dynamic behavior with the new structure.
- `__tests__/integration/send.test.ts` — `plan.md:85-95` — Plan correctly identifies mix of exact string matching (line 336) and regex matching (lines 349-431). However, gap: doesn't specify which approach to use for the new structure (exact match on `code` field vs pattern match on `message` field).
- `src/connections.ts` — Missing from plan — The plan does not examine whether ConnectionRecord type or connection lifecycle could affect error response timing (specifically during buffered state).

## 3) Open Questions & Ambiguities

- Question: How will the Python backend be coordinated with this breaking change?
- Why it matters: The plan states "coordinate deployment with Python backend changes" (plan.md:308) but provides no detail on the coordination mechanism, backward compatibility window, or rollback strategy. If coordination fails, Python will receive unexpected error formats.
- Needed answer: Specify deployment sequence (Python first or SSEGateway first?), whether a feature flag is needed, or if this requires a synchronized deployment.

- Question: Should error codes be defined as TypeScript constants or literal strings?
- Why it matters: Using literal strings in each error response risks typos and inconsistency. Using constants/enums provides compile-time safety and ensures consistency across all error locations.
- Needed answer: Clarify whether a constants file (e.g., `src/errors.ts`) should be created or if inline literals are acceptable given the small number of error codes (11 total).

- Question: What is the error response format during the buffered state (connection.ready = false)?
- Why it matters: The plan addresses `/internal/send` buffering behavior (`plan.md:113-120`) but doesn't specify whether buffered events that fail validation should return the new error structure. Current code returns `{ status: 'buffered' }` for successful buffering, but validation happens before buffering check.
- Needed answer: Confirm that validation errors (400 responses) occur before buffering check, so they always use the new error format regardless of connection state.

## 4) Deterministic Backend Coverage (new/changed behavior only)

- Behavior: POST /internal/send validation errors (400 status with new structure)
- Scenarios:
  - Given no token, When POST to /internal/send, Then 400 with `{ error: { message: "...", code: "INVALID_TOKEN_MISSING" } }` (`__tests__/integration/send.test.ts::should return 400 when token is missing`)
  - Given token is number, When POST to /internal/send, Then 400 with code `INVALID_TOKEN_MISSING` (`__tests__/integration/send.test.ts::should return 400 when token is not a string`)
  - Given event is string, When POST to /internal/send, Then 400 with code `INVALID_EVENT_TYPE` (`__tests__/integration/send.test.ts::should return 400 when event is not an object`)
  - Given event.data missing, When POST to /internal/send, Then 400 with code `INVALID_EVENT_DATA_MISSING` (`__tests__/integration/send.test.ts::should return 400 when event.data is missing`)
  - Given event.data is number, When POST to /internal/send, Then 400 with code `INVALID_EVENT_DATA_MISSING` (`__tests__/integration/send.test.ts::should return 400 when event.data is not a string`)
  - Given event.name is number, When POST to /internal/send, Then 400 with code `INVALID_EVENT_NAME_TYPE` (`__tests__/integration/send.test.ts::should return 400 when event.name is not a string`)
  - Given close is string, When POST to /internal/send, Then 400 with code `INVALID_CLOSE_TYPE` (`__tests__/integration/send.test.ts::should return 400 when close must be a boolean`)
- Instrumentation: Existing error logs remain unchanged (confirmed in plan.md:217-226)
- Persistence hooks: None required (stateless error responses)
- Gaps: **Major** — Missing test scenario for verifying exact error structure shape. Tests verify `code` field exists but don't verify that `message` field is present or that `error` is an object with exactly these two fields. Need test like: `expect(response.body).toEqual({ error: { message: expect.any(String), code: 'INVALID_TOKEN_MISSING' } })`
- Evidence: `plan.md:245-256`

- Behavior: POST /internal/send resource errors (404, 500 with new structure)
- Scenarios:
  - Given unknown token, When POST to /internal/send, Then 404 with code `TOKEN_NOT_FOUND` (`__tests__/integration/send.test.ts::should return 404 for unknown token`)
  - Given connection closed during send, When POST to /internal/send, Then 500 with code `WRITE_FAILED` (existing test coverage mentioned in plan.md:264)
- Instrumentation: Existing error logs remain unchanged
- Persistence hooks: None required
- Gaps: **Major** — Plan.md:261-262 mentions "connection closed during send" scenario but does NOT specify which existing test covers this. Searching `__tests__/integration/send.test.ts:463-509` (mentioned as evidence) is required to verify coverage exists. If no test exists, this is a coverage gap.
- Evidence: `plan.md:258-264`

- Behavior: GET /<any-path> SSE connection errors (503, 401/403/500, 504 with new structure)
- Scenarios:
  - Given CALLBACK_URL not configured, When GET any path, Then 503 with code `SERVICE_NOT_CONFIGURED` (`__tests__/integration/sse.test.ts::should return 503 when CALLBACK_URL is null`)
  - Given callback returns 401, When GET any path, Then 401 with code `BACKEND_ERROR` (`__tests__/integration/sse.test.ts::should return 401 when Python callback returns 401`)
  - Given callback returns 403, When GET any path, Then 403 with code `BACKEND_ERROR` (`__tests__/integration/sse.test.ts::should return 403 when Python callback returns 403`)
  - Given callback returns 500, When GET any path, Then 500 with code `BACKEND_ERROR` (`__tests__/integration/sse.test.ts::should return 500 when Python callback returns 500`)
  - Given backend unreachable, When GET any path, Then 503 with code `BACKEND_UNAVAILABLE` (`__tests__/integration/sse.test.ts::should return 503 when callback URL is unreachable`)
  - Given callback timeout >5s, When GET any path, Then 504 with code `GATEWAY_TIMEOUT` (`__tests__/integration/sse.test.ts::should return 504 when callback times out`)
- Instrumentation: Existing error logs remain unchanged
- Persistence hooks: None required
- Gaps: **Major** — Same issue as above: tests verify exact object equality with old structure (`expect(response.body).toEqual({ error: 'Backend returned 401' })`), but plan doesn't specify how to update these to verify both `message` and `code` fields. Tests should verify structure shape, not just field presence.
- Evidence: `plan.md:266-276`

## 5) Adversarial Sweep (must find ≥3 credible issues or declare why none exist)

**Major — Missing TypeScript type definition for error response structure**

**Evidence:** `plan.md:106-144` defines error response structure in JSON/prose but no TypeScript interface is proposed. Current codebase uses inline `.json({ error: string })` calls without type safety.

**Why it matters:** Without a TypeScript type/interface for the new error structure, developers could introduce inconsistencies (e.g., misspell "code" as "errorCode", use camelCase vs UPPER_SNAKE_CASE). TypeScript compilation won't catch structural errors in the JSON responses. This defeats a key benefit of TypeScript mentioned in plan.md:63: "TypeScript type system will catch structural errors at compile time."

**Fix suggestion:** Add to Section 3 (Data Model / Contracts):
```typescript
interface ErrorResponse {
  error: {
    message: string;
    code: string;
  };
}
```
Then update Section 2 (Affected Areas) to include creating a helper function or type guard that enforces this structure at all error response sites. Example: `respondWithError(res, status, message, code)` that ensures type safety.

**Confidence:** High

---

**Major — Incomplete test strategy for error structure validation**

**Evidence:** `plan.md:245-276` lists test scenarios that verify error `code` fields exist using regex matching (e.g., `expect(response.body.error).toMatch(/token is required/i)`), but doesn't specify how to verify the complete nested structure shape.

**Why it matters:** Tests could pass even if the response is `{ error: "message", code: "CODE" }` (flat with separate fields) instead of `{ error: { message: "...", code: "CODE" } }` (nested). The plan's approach of updating regex patterns doesn't guarantee structural correctness. Based on evidence from `__tests__/integration/send.test.ts:336` showing exact equality checks, and `plan.md:312` noting tests should "use exact structure matching where possible", the plan contradicts itself by proposing regex matching for the refactored tests.

**Fix suggestion:** Add to Section 13 (Deterministic Test Plan): "Update test assertions to use exact object matching for error structure: `expect(response.body).toEqual({ error: { message: expect.stringMatching(/pattern/), code: 'ERROR_CODE' } })`. This verifies both the nested structure and the presence of both required fields while allowing flexible message content validation."

**Confidence:** High

---

**Major — No analysis of error response timing during callback window buffering**

**Evidence:** `plan.md:113-120` correctly identifies that buffered events during callback window return `{ status: 'buffered' }`, but `plan.md:70-78` claims to refactor ALL error responses in `src/routes/internal.ts`. The interaction between buffering logic and validation error responses is not analyzed.

**Why it matters:** Looking at `src/routes/internal.ts:64-101`, validation checks occur BEFORE the buffering check at line 114. This means validation errors will always use the new error format. However, the plan doesn't explicitly state this, creating ambiguity about whether buffered state affects error response format. If validation order changes during implementation, errors during buffering could return inconsistent formats.

**Fix suggestion:** Add to Section 8 (Errors & Edge Cases):
- Failure: Validation error occurs while connection is in buffered state (ready=false)
- Surface: POST /internal/send
- Handling: Validation errors occur before buffering check (src/routes/internal.ts:64-101 precedes line 114 buffering check), so always return new error format regardless of connection state
- Guardrails: Maintain validation order before buffering check. Add test scenario: "Given connection in buffered state (ready=false), When POST with invalid token type, Then 400 with new error structure"
- Evidence: `src/routes/internal.ts:64-120`

**Confidence:** High

---

**Minor — Inconsistent error code naming convention for BACKEND_ERROR**

**Evidence:** `plan.md:138-141` defines a single `BACKEND_ERROR` code for multiple distinct HTTP status codes (401, 403, 500) from Python backend.

**Why it matters:** Using the same error code for different HTTP statuses reduces API clarity. Consumers cannot distinguish between authentication failure (401), authorization failure (403), and server error (500) without parsing the message field, which defeats the purpose of semantic error codes. The plan states error codes should be "Descriptive and semantic" (plan.md:42), but `BACKEND_ERROR` is generic.

**Fix suggestion:** Consider using distinct error codes: `BACKEND_AUTH_FAILED` (401), `BACKEND_FORBIDDEN` (403), `BACKEND_ERROR` (500). OR justify why a single code is acceptable (e.g., SSEGateway doesn't need to distinguish between these failure modes and treats all non-2xx callback responses identically). Add justification to Section 3 (Data Model / Contracts).

**Confidence:** Medium (could be acceptable design choice if justified)

## 6) Derived-Value & Persistence Invariants (stacked entries)

None applicable. This refactor changes error response serialization format only. No derived values affect storage, cleanup, or cross-context state. Error responses are stateless transformations of error conditions to JSON payloads with no persistence side effects.

**Proof:**
- Checks attempted: Examined all error response locations (`src/routes/internal.ts:67-127`, `src/routes/sse.ts:51-137`) for writes, cleanup triggers, or state dependencies
- Evidence: `plan.md:186-194` explicitly states "No derived state applies to this refactor. Error responses are stateless transformations"
- Why the plan holds: Error responses are synchronous HTTP JSON writes triggered by validation failures or resource lookup failures. No database operations, no connection state mutations (except cleanup already handled by existing error paths), no derived calculations that drive persistence actions.

## 7) Risks & Mitigations (top 3)

- Risk: Breaking change impacts Python backend error parsing
- Mitigation: Plan.md:306-308 mentions coordination but lacks specifics. **Strengthen mitigation:** Identify all Python code locations that parse SSEGateway error responses, update them to expect nested structure, deploy Python changes before or simultaneously with SSEGateway changes. Consider adding a deployment runbook to plan.md:300-314.
- Evidence: `plan.md:306-308`

- Risk: Incomplete refactoring leaves inconsistent error format across endpoints
- Mitigation: Plan.md:315-316 proposes comprehensive grep for `{ error:` pattern. **Strengthen mitigation:** Add to Section 14 (Implementation Slices): "After code changes, run grep pattern `\.json\(\s*\{\s*error:` to verify all locations updated. Run full integration test suite and verify no tests expect old format. Manual code review of all changes in src/routes/*.ts files."
- Evidence: `plan.md:315-316`

- Risk: Error code typos or inconsistent casing (e.g., `TOKEN_NOT_FOUND` vs `Token_Not_Found`)
- Mitigation: Plan.md:200-202 states "TypeScript compilation and code review will catch inconsistencies. Tests verify exact error codes." This is insufficient because TypeScript does not validate string literal contents. **Strengthen mitigation:** Define error codes as TypeScript constants (see Adversarial Finding #1) OR add comprehensive test coverage that verifies exact error code strings using `expect(response.body.error.code).toBe('EXPECTED_CODE')` for all error scenarios.
- Evidence: `plan.md:200-202`

## 8) Confidence

Confidence: Medium — The plan correctly identifies scope and demonstrates thorough code research, but has significant gaps in type safety, test coverage specifications, and deployment coordination. These gaps are addressable with additions to the plan (TypeScript error type definition, clarified test assertions, Python coordination strategy). Once these conditions are met, implementation risk is low because the change is a straightforward structural refactor with comprehensive existing test coverage to verify behavioral equivalence.
