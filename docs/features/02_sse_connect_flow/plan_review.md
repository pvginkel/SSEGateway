# Plan Review: SSE Connect Flow

## 1) Summary & Decision

**Readiness**

The updated plan demonstrates substantial improvement over the previous version. All five major issues identified in the prior review have been explicitly addressed with concrete technical solutions. The plan now includes: (1) proper ordering of callback-before-headers to enable status propagation, (2) cleaner null-based heartbeatTimer initialization avoiding no-op timer complexity, (3) race condition protection via disconnected flag and pre-callback listener registration, (4) explicit 5-second timeout on callbacks using AbortSignal.timeout(5000), and (5) header filtering to remove undefined values plus documentation of multi-value header handling. The implementation approach is well-structured with clear slices, comprehensive test coverage including race condition scenarios, and strong alignment with product_brief.md and CLAUDE.md requirements. Error handling is thorough, observability is adequate, and the connection lifecycle logic is sound.

**Decision**

`GO` — All previously identified blocking issues have been resolved with appropriate technical implementations. The plan is ready for implementation. Minor refinements may emerge during coding (e.g., exact error message formatting, specific test assertion details), but no architectural or design concerns remain.

---

## 2) Conformance & Fit (with evidence)

**Conformance to refs**

- `product_brief.md:80-113 (SSE Endpoint)` — Pass — `plan.md:183-190,203-227` — Plan correctly specifies accepting ANY path under /sse/, generating UUID tokens with crypto.randomUUID(), returning callback status to client on non-2xx, and setting proper SSE headers only after successful callback. Flow sequence now correctly sends callback FIRST (lines 207-221) before setting headers (line 216), resolving previous ordering issue.

- `product_brief.md:182-203 (Callback Contract)` — Pass — `plan.md:138-177` — Callback payload structure matches specification exactly with action, token, and request fields. Plan correctly includes reason field only for disconnect (line 156). Headers filtering added (line 345) to remove undefined values, addressing review finding.

- `product_brief.md:314-323 (ConnectionRecord)` — Pass — `plan.md:122-135` — ConnectionRecord interface matches spec with res, request, and heartbeatTimer fields. Plan correctly changes heartbeatTimer type to `NodeJS.Timeout | null` (line 130) instead of creating placeholder timers, resolving review finding. Addition of disconnected flag (line 131) properly handles race condition not explicitly in product_brief but necessary for correct implementation.

- `CLAUDE.md:19-22 (Event Loop & Flushing)` — Pass — `plan.md:286-301` — Plan correctly relies on Node.js event loop for serialization (line 297) and acknowledges immediate flushing requirement (though actual flushing deferred to future event-sending feature, which is appropriate for this connect-only scope).

- `CLAUDE.md:66-69 (Don't retry callbacks)` — Pass — `plan.md:292-293,238` — Plan explicitly states "No retries for callback failures (best-effort design)" and "disconnect callback is best-effort (failures only logged)".

**Fit with codebase**

- `src/config.ts:10-14` — `plan.md:104-108` — Config interface already provides callbackUrl and heartbeatIntervalSeconds. Plan correctly identifies no changes needed (line 105). Assumption that config.callbackUrl can be null is validated (line 335 references src/config.ts:39).

- `src/server.ts:18-31` — `plan.md:101-103,525-539` — Plan correctly identifies server.ts needs modification to mount new SSE router (Slice 5). Current server only mounts health router, so change is non-invasive. Integration is straightforward via Express router pattern already established.

- `src/routes/health.ts:42-54` — `plan.md:333-335` — Plan references existing readyz behavior (503 when CALLBACK_URL not configured) and plans consistent handling in SSE endpoint. Good alignment with existing health check pattern.

- `Express 5 'close' event` — `plan.md:230-249,402-408` — Plan relies on Express response 'close' event for disconnect detection. This is a well-documented Express feature and appropriate for the use case. Idempotency protection via Map.has(token) check (line 242) ensures robustness.

---

## 3) Open Questions & Ambiguities

- Question: Should the gateway enforce a maximum header size or connection Map size limit?
- Why it matters: Large header objects or unbounded Map growth could cause memory exhaustion in production. Python backend may send many headers (proxied auth tokens, cookies, etc.) or malicious clients could open thousands of connections.
- Needed answer: Confirm whether (1) gateway should enforce limits, or (2) rely on external safeguards (NGINX connection limits, OS limits, Python backend payload validation). Product brief section 2.3 mentions "Thousands of concurrent SSE connections" but doesn't specify upper bound or memory limits.

- Question: What is the expected behavior if disconnected flag is true but callback succeeded (2xx) during race condition?
- Why it matters: Plan correctly avoids adding to Map (line 220) but doesn't specify if disconnect callback should be sent. Since client already disconnected, sending disconnect callback with reason "client_closed" would be correct, but plan doesn't explicitly state this.
- Needed answer: Clarify if early-disconnect scenario (client disconnects during connect callback) should send disconnect callback after callback completes, or silently skip it since client never entered "connected" state in Python's view.

- Question: Should the 5-second callback timeout apply to both connect AND disconnect callbacks, or only connect?
- Why it matters: Plan states 5-second timeout for connect callback (line 211, 469) but disconnect callback timeout is not explicitly specified in the flow description (lines 230-249). Disconnect is best-effort, so timeout behavior matters for cleanup timing.
- Needed answer: Confirm disconnect callback should also use 5-second timeout, or if it should use a different (possibly shorter) timeout since it's fire-and-forget.

---

## 4) Deterministic Backend Coverage (new/changed behavior only)

- Behavior: GET /sse/* endpoint — successful connection establishment
- Scenarios:
  - Given CALLBACK_URL configured and Python returns 200, When client requests GET /sse/channel/updates?user=123, Then connect callback sent with full URL and headers, SSE headers set, status 200 returned, token stored in Map (`__tests__/integration/sse.test.ts::test_successful_connection`)
  - Given multiple simultaneous clients connect, When each requests different /sse/* paths, Then each receives unique token and all stored in Map independently (`__tests__/integration/sse.test.ts::test_concurrent_connections`)
- Instrumentation: Log connection establishment (token, URL) per plan.md:360-363; log callback success per plan.md:366-370
- Persistence hooks: Map insertion (line 218), no database persistence
- Gaps: None
- Evidence: plan.md:449-455

- Behavior: GET /sse/* endpoint — connect callback rejection (non-2xx)
- Scenarios:
  - Given Python returns 401, When client connects to /sse/protected, Then client receives 401, no SSE headers sent, token NOT in Map (`__tests__/integration/sse.test.ts::test_callback_rejection_401`)
  - Given Python returns 403, When client connects, Then client receives 403 (`__tests__/integration/sse.test.ts::test_callback_rejection_403`)
  - Given Python returns 500, When client connects, Then client receives 500 (`__tests__/integration/sse.test.ts::test_callback_rejection_500`)
- Instrumentation: Log callback failure with status code per plan.md:373-378
- Persistence hooks: Token NOT added to Map (line 215), heartbeat timer cleared (line 460)
- Gaps: None
- Evidence: plan.md:313-317,457-464

- Behavior: GET /sse/* endpoint — callback network failure and timeout
- Scenarios:
  - Given CALLBACK_URL unreachable, When client connects, Then fetch throws ECONNREFUSED, client receives 503, error logged, token NOT in Map (`__tests__/integration/sse.test.ts::test_callback_network_error`)
  - Given Python takes > 5 seconds to respond, When client connects, Then fetch times out via AbortSignal, client receives 504, timeout logged, token NOT in Map (`__tests__/integration/sse.test.ts::test_callback_timeout`)
- Instrumentation: Log network errors and timeouts per plan.md:373-378
- Persistence hooks: Token NOT added to Map
- Gaps: None — timeout testing is now in-scope (addresses prior review finding)
- Evidence: plan.md:307-311,319-323,467-472

- Behavior: Express 'close' event — client disconnect detection
- Scenarios:
  - Given active connection in Map, When client closes, Then 'close' event fires, disconnect callback sent with reason "client_closed", token removed from Map, heartbeatTimer cleared if not null, disconnect logged (`__tests__/integration/sse.test.ts::test_client_disconnect`)
  - Given disconnect callback fails, When client closes, Then error logged only, cleanup completes (Map.delete, timer cleared) (`__tests__/integration/sse.test.ts::test_disconnect_callback_failure`)
  - Given client disconnects DURING connect callback, When 'close' fires before callback returns, Then disconnected flag set true, callback completes but token NOT added to Map, early disconnect logged (`__tests__/integration/sse.test.ts::test_race_condition_early_disconnect`)
- Instrumentation: Log disconnect with token and reason per plan.md:380-384; log disconnect callback failures per plan.md:387-392
- Persistence hooks: Map.delete (line 236), heartbeatTimer clearTimeout (line 235)
- Gaps: Open question about whether early-disconnect scenario should send disconnect callback (see Section 3)
- Evidence: plan.md:229-249,481-489

- Behavior: Callback payload formatting with headers and query strings
- Scenarios:
  - Given request with query /sse/channel?user=123&room=456, When callback sent, Then request.url includes full query string (`__tests__/integration/sse.test.ts::test_callback_payload_query_string`)
  - Given request has multiple headers (Authorization, User-Agent, X-Custom), When callback sent, Then request.headers includes all (filtered for undefined) (`__tests__/integration/sse.test.ts::test_callback_payload_headers`)
  - Given request headers contain undefined values, When callback sent, Then request.headers does NOT include undefined entries (`__tests__/integration/sse.test.ts::test_undefined_headers_filtered`)
  - Given request has multi-value header (Set-Cookie as string[]), When callback sent, Then request.headers preserves array value (`__tests__/integration/sse.test.ts::test_multivalue_headers_preserved`)
  - Given req.url empty/undefined, When callback sent, Then request.url defaults to "/sse/unknown" (`__tests__/integration/sse.test.ts::test_url_fallback`)
- Instrumentation: Implicit via callback request logging
- Persistence hooks: None
- Gaps: None — addresses prior review findings on undefined values and multi-value headers
- Evidence: plan.md:492-501,337-347

- Behavior: GET /sse/* endpoint — CALLBACK_URL not configured
- Scenarios:
  - Given config.callbackUrl is null, When client requests GET /sse/any, Then response is 503 Service Unavailable, error logged, no callback attempted (`__tests__/integration/sse.test.ts::test_no_callback_url`)
- Instrumentation: Log error indicating CALLBACK_URL missing per plan.md:332-335
- Persistence hooks: None
- Gaps: None
- Evidence: plan.md:331-335,474-479

---

## 5) Adversarial Sweep (must find ≥3 credible issues or declare why none exist)

**Minor — Disconnect callback ambiguity in early-disconnect race condition**
**Evidence:** `plan.md:218-220` — "If callback returns 2xx BUT disconnected flag is true: cleanup only, do not add to Map (client already gone)"
**Why it matters:** Plan correctly prevents Map insertion but doesn't specify whether disconnect callback should be sent to Python in this case. From Python's perspective, connect callback was successful (2xx), so it expects a disconnect callback to complete the lifecycle. Omitting disconnect callback could leave Python in inconsistent state (thinks connection is active when it's not). This is a minor concern because Python should handle stale connections, but explicit specification would improve correctness.
**Fix suggestion:** Add to line 220: "Send disconnect callback with reason 'client_closed' to Python (best-effort) to close lifecycle loop, even though connection never entered Map." Add test scenario to verify this behavior.
**Confidence:** High

**Minor — Error message specificity for timeout vs network failure**
**Evidence:** `plan.md:309-311,319-323` — Both timeout (504) and network errors (503) are caught and logged, but log format not specified
**Why it matters:** Distinguishing between "callback timed out after 5 seconds" vs "callback failed: ECONNREFUSED" in logs is critical for debugging production issues. If logs just say "callback failed", operators can't tell if Python is down (network error) vs overloaded (timeout). Plan mentions logging "timeout error" and "error message" but doesn't guarantee operators can differentiate the failure modes.
**Fix suggestion:** In Section 9 (Observability), specify distinct log formats: `[ERROR] Connect callback timeout: token=<token> url=<url> timeout=5000ms` vs `[ERROR] Connect callback network error: token=<token> url=<url> error=ECONNREFUSED`. Ensures operational clarity.
**Confidence:** Medium

**Minor — HeartbeatTimer cleanup in rejection path not fully specified**
**Evidence:** `plan.md:213-215` — On callback rejection, plan says "cleanup, log error" but doesn't explicitly state heartbeatTimer clearing like disconnect flow does (line 235)
**Why it matters:** Since heartbeatTimer is set to null initially (line 130), clearing isn't strictly necessary for this feature. However, the plan mentions "heartbeat timer is cleared" in rejection test (line 460), creating expectation that cleanup code explicitly calls clearTimeout. If future implementation adds timer before callback, cleanup path must clear it. Plan should be explicit about cleanup steps for consistency.
**Fix suggestion:** In line 215 flow or Section 8 error handling, explicitly state: "Clear heartbeatTimer if not null (using `if (timer) clearTimeout(timer)`) before returning error status." Maintains consistency with disconnect cleanup (line 235).
**Confidence:** Low

**Checks attempted:**
- Transaction safety: No database transactions; Map operations are synchronous and atomic within event loop (plan.md:287-301) — passes
- Layering violations: Plan correctly isolates callback logic in separate module (src/callback.ts), connection state in src/connections.ts, route handler in src/routes/sse.ts — passes
- Missing test coverage: All new behaviors have explicit test scenarios with test file names (plan.md:449-511) — passes
- State corruption via filtering: Headers filtering (line 345) removes undefined but doesn't modify Express-provided data; no corruption risk — passes
- Memory leaks: Null-based heartbeatTimer eliminates placeholder timer leak; Map cleanup on disconnect prevents connection leak (lines 235-237) — passes
- Security: Plan correctly defers auth to Python (plan.md:414-424); crypto.randomUUID provides secure tokens (lines 426-430) — passes
- Missing migrations/persistence: No persistence by design; all state ephemeral — passes

---

## 6) Derived-Value & Persistence Invariants (stacked entries)

- Derived value: Connection existence in Map<token, ConnectionRecord>
  - Source dataset: Unfiltered — token generated via crypto.randomUUID() (no external input); ConnectionRecord built from req.url, req.headers, res object (Express-provided)
  - Write / cleanup triggered: Token added to Map ONLY if (1) connect callback returns 2xx AND (2) disconnected flag is false (plan.md:218). Token removed from Map on disconnect (line 236) or never added on callback rejection (line 215).
  - Guards: (1) crypto.randomUUID() guarantees token uniqueness (no collisions); (2) disconnected flag prevents race condition where client closes during callback; (3) Map.has(token) check before disconnect cleanup ensures idempotency; (4) callback-before-headers ordering ensures only successful connections enter Map
  - Invariant: If token exists in Map, then (a) response object is valid and open for writing, (b) disconnected flag is false, (c) heartbeatTimer is null for this feature. If token not in Map, then either (a) connection never succeeded, or (b) already cleaned up.
  - Evidence: plan.md:254-260

- Derived value: disconnected flag in ConnectionRecord
  - Source dataset: Unfiltered — flag starts false (line 209), set to true by 'close' event listener if client disconnects early (line 241)
  - Write / cleanup triggered: Flag written to true when Express 'close' event fires before callback completes. Read by callback completion handler to decide whether to add connection to Map (line 220).
  - Guards: 'close' listener registered BEFORE callback (line 210) ensures race detection; flag checked atomically after callback completes
  - Invariant: If disconnected is true AND token not in Map, then client disconnected during callback. If disconnected is false, then either callback hasn't completed or connection is in Map.
  - Evidence: plan.md:131,220,241,327-329

- Derived value: Callback payload request.url
  - Source dataset: Filtered — extracted from Express req.url (line 206), fallback to '/sse/unknown' if undefined (line 339)
  - Write / cleanup triggered: Included in connect callback payload (line 212) and disconnect callback payload (preserved from ConnectionRecord)
  - Guards: No parsing or validation; defensive fallback for undefined; stored as-is in ConnectionRecord.request.url
  - Invariant: request.url in callback exactly matches the URL Express received from client, OR is '/sse/unknown' if req.url was undefined. No modification, parsing, or transformation applied.
  - Evidence: plan.md:262-267

- Derived value: Callback payload request.headers
  - Source dataset: Filtered — extracted from Express req.headers (line 207), undefined values removed via Object.fromEntries filter (line 345)
  - Write / cleanup triggered: Included in connect and disconnect callback payloads; stored in ConnectionRecord.request.headers
  - Guards: Explicit filtering: `Object.fromEntries(Object.entries(req.headers).filter(([_, v]) => v !== undefined))` ensures no undefined values in JSON; multi-value headers (string[]) preserved as-is
  - Invariant: request.headers contains all non-undefined headers Express received; multi-value headers remain as string[] arrays; no header parsing or normalization beyond Express's lowercase key normalization
  - Evidence: plan.md:269-274,344-347

- Derived value: heartbeatTimer field value (null for this feature)
  - Source dataset: Unfiltered — hardcoded to null on ConnectionRecord creation (line 130)
  - Write / cleanup triggered: Set to null when creating ConnectionRecord; cleared via `if (timer) clearTimeout(timer)` on disconnect (line 235)
  - Guards: TypeScript type `NodeJS.Timeout | null` enforces null-check before clearTimeout; null value means no timer to clean
  - Invariant: heartbeatTimer is always null for this feature. Conditional clearTimeout is future-proof but no-op for this implementation.
  - Evidence: plan.md:276-282

None of these derived values use filtered datasets to drive persistent writes without guards. All guards are appropriate for in-memory state. No Major-level invariant violations.

---

## 7) Risks & Mitigations (top 3)

- Risk: Connect callback latency blocks client connection establishment for up to 5 seconds
- Mitigation: **IMPLEMENTED** — Plan includes explicit 5-second timeout via AbortSignal.timeout(5000) (line 211). Clients receive 504 Gateway Timeout if exceeded. Timeout duration (5s) is reasonable for internal sidecar communication but may need tuning in production based on Python backend p99 latency. Consider documenting timeout as configurable environment variable in future work if latency becomes issue.
- Evidence: plan.md:307-311,545-547

- Risk: Race condition between client disconnect and callback completion could orphan connections in Map
- Mitigation: **IMPLEMENTED** — Plan adds disconnected flag (line 131) and registers 'close' listener before callback (line 210). Callback completion checks flag before Map insertion (line 220). Test coverage includes race condition scenario (line 486). Mitigation is thorough but relies on Express 'close' event behavior being reliable (well-documented and widely used, so acceptable risk).
- Evidence: plan.md:224-226,327-329,561-563

- Risk: fetch() API does not reject on non-2xx HTTP status codes, requiring explicit response.ok check
- Mitigation: **ACKNOWLEDGED** — Plan identifies this risk (line 549-551) and proposes implementing explicit response.ok or response.status validation. This is correct approach. Recommendation: ensure callback module tests cover fetch() behavior with various status codes (200, 401, 403, 500) to verify response.ok check is correctly implemented.
- Evidence: plan.md:549-551

---

## 8) Confidence

Confidence: High — All five major issues from previous review have been addressed with concrete technical solutions: (1) callback-before-headers ordering enables status propagation, (2) null-based heartbeatTimer eliminates no-op timer complexity, (3) disconnected flag + pre-callback listener solves race condition, (4) 5-second timeout via AbortSignal is explicit and testable, (5) header filtering removes undefined values with test coverage for multi-value headers. Plan demonstrates strong understanding of Node.js event loop semantics, Express behavior, and SSE requirements. Implementation slices are logical and independently testable. Only minor clarifications remain (early-disconnect callback behavior, log message specificity, cleanup consistency), none of which block implementation. The plan is ready to execute.
