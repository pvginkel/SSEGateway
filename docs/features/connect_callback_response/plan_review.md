# Plan Review: Connect Callback Response

## 1) Summary & Decision

**Readiness**

The plan is comprehensive, well-structured, and demonstrates thorough research. It correctly identifies all affected areas, provides detailed behavioral specifications, and includes extensive test coverage. The plan addresses all previous review findings including module boundary violations, race conditions, and test scenario gaps. The implementation slices are logical and incremental. The plan demonstrates strong understanding of SSE mechanics, Node.js event loop ordering, and backwards compatibility requirements.

**Decision**

`GO` — The plan is ready for implementation. All critical risks have been identified and mitigated, module boundaries are respected, test coverage is deterministic and complete, and the feature aligns with product requirements and codebase architecture.

## 2) Conformance & Fit (with evidence)

**Conformance to refs**

- `docs/product_brief.md` — Pass — `plan.md:39,254-255` — "If both are given → send event first, then close" matches plan's ordering guarantee: "Maintain existing ordering guarantee: event sent first, then close"

- `docs/product_brief.md` — Pass — `plan.md:107-108` — "If Python returns non-2xx: SSE immediately terminated" matches plan preservation: "Preserve all existing behavior: non-2xx status still closes connection immediately"

- `docs/product_brief.md` — Pass — `plan.md:167-175` — CallbackResponseBody interface correctly mirrors SendRequest structure (lines 18-30 of internal.ts) without the token field, aligning with /internal/send contract

- `CLAUDE.md` — Pass — `plan.md:129-143` — Extraction location changed from src/sse.ts to src/routes/internal.ts, correctly preserving module boundaries ("src/sse.ts should remain a pure formatting utility with no dependencies")

- `change_brief.md` — Pass — `plan.md:31-32` — "This applies to all callback actions (both connect and disconnect)" correctly implemented in plan sections covering both callback types (lines 71-78, 125-127)

**Fit with codebase**

- `src/callback.ts` — Pass — `plan.md:109-120` — CallbackResult extension with optional responseBody field maintains backwards compatibility; existing callers can ignore the new field

- `src/routes/internal.ts` — Pass — `plan.md:129-143` — handleEventAndClose extraction from lines 114-167 respects existing module structure and reuses proven logic

- `src/routes/sse.ts` — Pass — `plan.md:121-124` — SSE route handler modification after successful callback (lines 131-151) aligns with existing connection lifecycle and race condition handling via disconnected flag

- `__tests__/utils/mockServer.ts` — Pass — `plan.md:145-153` — setResponseBody() enhancement with signature accepting `any` type enables testing invalid structures, aligning with lenient validation requirements

## 3) Open Questions & Ambiguities

None. The plan explicitly states "None - change brief is clear and all design decisions resolved during research phase" (line 665). This assertion is validated by:
- Clear behavioral specifications for all edge cases (invalid JSON, missing fields, race conditions)
- Explicit resolution of the disconnect callback response body conflict with documented rationale (lines 125-127, 285-296)
- Complete test scenario coverage (Section 13, lines 519-609)

## 4) Deterministic Backend Coverage (new/changed behavior only)

- Behavior: Connect callback with event in response body
- Scenarios:
  - Given Python returns 200 with event in body, When SSE connection opens, Then event is sent to client before normal stream opens (`__tests__/integration/sse.test.ts::test_connect_callback_event_sent`)
  - Given Python returns 200 with named event, When SSE connection opens, Then event includes correct event name in SSE format (`__tests__/integration/sse.test.ts::test_connect_callback_named_event`)
  - Given Python returns 200 with multi-line event data, When SSE connection opens, Then event is formatted with multiple data: lines per SSE spec (`__tests__/integration/sse.test.ts::test_connect_callback_multiline_data`)
- Instrumentation: INFO level logs with token, hasEvent/hasClose flags, eventName (lines 433-443); event send logs with source="callback_response" field (lines 465-475)
- Persistence hooks: No persistence (in-memory only); connection Map state correctly managed via handleEventAndClose function
- Gaps: None
- Evidence: `plan.md:521-531` — test scenarios; `plan.md:433-475` — logging

- Behavior: Connect callback with close in response body
- Scenarios:
  - Given Python returns 200 with close=true only, When SSE connection opens, Then stream opens and immediately closes with reason="server_closed" (`__tests__/integration/sse.test.ts::test_connect_callback_close_only`)
  - Given Python returns 200 with event and close=true, When SSE connection opens, Then event sent first, then stream closes with reason="server_closed" (`__tests__/integration/sse.test.ts::test_connect_callback_event_and_close`)
  - Given Python returns 200 with close=false, When SSE connection opens, Then stream remains open normally (`__tests__/integration/sse.test.ts::test_connect_callback_close_false`)
- Instrumentation: INFO level logs for close with source="callback_response" and eventSent flag (lines 477-486)
- Persistence hooks: Connection removed from Map, heartbeat timer cleared, disconnect callback sent
- Gaps: None
- Evidence: `plan.md:533-543` — test scenarios

- Behavior: Connect callback with invalid response body
- Scenarios:
  - Given Python returns 200 with invalid JSON body, When parsing response, Then treated as empty `{}` and logged, stream opens normally (`__tests__/integration/sse.test.ts::test_connect_callback_invalid_json`)
  - Given Python returns 200 with event missing data field, When parsing response, Then event ignored, logged, stream opens normally (`__tests__/integration/sse.test.ts::test_connect_callback_event_missing_data`)
  - Given Python returns 200 with close as string "true", When parsing response, Then close ignored, logged, stream opens normally (`__tests__/integration/sse.test.ts::test_connect_callback_close_wrong_type`)
  - Given Python returns 200 with empty body `{}`, When parsing response, Then stream opens normally (no event, no close) (`__tests__/integration/sse.test.ts::test_connect_callback_empty_body`)
- Instrumentation: ERROR level logs for parse failures with token, action, and error message (lines 445-453)
- Persistence hooks: No state changes on parse failure; connection proceeds normally
- Gaps: None
- Evidence: `plan.md:545-556` — test scenarios; `plan.md:176-179,383-402` — lenient validation and error handling

- Behavior: Connect callback response with client disconnect race condition
- Scenarios:
  - Given Python returns 200 with event+close AND client disconnects between callback return and event write, When disconnect detected, Then no write attempted, no spurious error callback, disconnect reason is client_closed not error (`__tests__/integration/sse.test.ts::test_connect_callback_response_client_disconnect_race`)
- Instrumentation: Existing race condition logging in src/routes/sse.ts lines 132-138
- Persistence hooks: Connection not added to Map, no heartbeat timer started, no disconnect callback sent (connection never established in Python)
- Gaps: None
- Evidence: `plan.md:558-566` — test scenario added to address race condition; `plan.md:267-270` — Step 11 re-check guard

- Behavior: Disconnect callback with response body (informational only)
- Scenarios:
  - Given client disconnects and Python returns disconnect callback with event, When disconnect processed, Then event ignored (connection closed) and WARN log written (`__tests__/integration/sse.test.ts::test_disconnect_callback_event_ignored`)
  - Given server closes and Python returns disconnect callback with close=true, When disconnect processed, Then close ignored and WARN logged (`__tests__/integration/sse.test.ts::test_disconnect_callback_close_ignored`)
  - Given disconnect callback returns invalid JSON, When disconnect processed, Then error logged but cleanup completes (best-effort) (`__tests__/integration/sse.test.ts::test_disconnect_callback_invalid_json`)
- Instrumentation: WARN level logs when disconnect callback returns event or close fields (lines 455-463)
- Persistence hooks: None (connection already cleaned up before disconnect callback sent)
- Gaps: **Documented limitation** — Disconnect callback response bodies parsed but never applied because connection cleanup happens before callback is sent; documented at `plan.md:577` and `plan.md:125-127`
- Evidence: `plan.md:568-578` — test scenarios; `plan.md:285-296` — disconnect flow

## 5) Adversarial Sweep (must find ≥3 credible issues or declare why none exist)

- Checks attempted:
  1. Module boundary violations (extraction location)
  2. Race condition handling (client disconnect during callback response processing)
  3. Response body parsing timeout implications (5s includes parsing time)
  4. Event ordering guarantees (callback event vs /internal/send events vs heartbeats)
  5. Disconnect callback applicability (connection already closed)
  6. Write failure during callback response event send
  7. Backwards compatibility with Python backends not sending response bodies
  8. Type validation strictness (lenient vs strict validation trade-offs)
  9. Mock testing infrastructure sufficiency
  10. Event/close ordering guarantee preservation
  11. Connection Map lifecycle correctness (add/remove timing)
  12. Heartbeat timer initialization timing

- Evidence:
  - `plan.md:129-143` — Extraction correctly placed in src/routes/internal.ts (not src/sse.ts)
  - `plan.md:267-270` — Step 11 adds re-check of disconnected flag before event/close execution
  - `plan.md:408-412` — Timeout handling verified (5s covers total callback time including parsing)
  - `plan.md:590-599` — Event ordering test scenarios defined
  - `plan.md:125-127, 285-296` — Disconnect callback limitation documented
  - `plan.md:403-407` — Write failure error handling specified
  - `plan.md:176-179` — Lenient validation with default to `{}` ensures backwards compatibility
  - `plan.md:145-153` — MockServer.setResponseBody() signature accepts `any` for testing invalid structures

- Why the plan holds:
  1. All module boundaries respected after correction in updated plan
  2. Race condition guard added (Step 11) prevents write after client disconnect
  3. Timeout scope correctly understood (covers entire callback including parsing)
  4. Event loop ordering guarantees leveraged (no additional synchronization needed)
  5. Disconnect callback limitation explicitly documented and justified (forwards compatibility)
  6. All error paths have explicit handling and logging
  7. Backwards compatibility guaranteed via lenient parsing
  8. Test infrastructure enhanced to support all test scenarios
  9. All critical invariants preserved (event-before-close, Map lifecycle, timer cleanup)

**No remaining credible issues found.** The plan has been thoroughly stress-tested against the following failure modes:
- Layer violations ✓ Resolved
- Transaction safety ✓ No transactions (in-memory only)
- Test coverage ✓ Complete with deterministic scenarios
- Data lifecycle ✓ Correct Map/timer management
- Metrics/logging ✓ Comprehensive instrumentation
- Race conditions ✓ Guarded via disconnected flag re-check
- Backwards compatibility ✓ Lenient validation with defaults
- Module boundaries ✓ Extraction in correct module

## 6) Derived-Value & Persistence Invariants (stacked entries)

- Derived value: Callback response body actions (event/close directives)
  - Source dataset: Filtered/validated JSON from response.json() - invalid fields stripped, malformed JSON treated as `{}`
  - Write / cleanup triggered: Event write to SSE stream (if event present), connection close with Map removal and timer clear (if close=true)
  - Guards:
    - JSON parse wrapped in try-catch (`plan.md:177-179`)
    - Type validation for event.data (string), event.name (string|undefined), close (boolean) (`plan.md:177-179`)
    - disconnected flag re-checked before write (`plan.md:267-270`)
    - Write success/failure detection with error cleanup (`plan.md:403-407`)
  - Invariant: Only valid CallbackResponseBody structures trigger actions; invalid data never causes writes or state corruption
  - Evidence: `plan.md:351-362` — Response body parsing result derivation

- Derived value: Connection state after callback response processing
  - Source dataset: Combination of callback HTTP status (2xx vs non-2xx) + parsed response body close field (filtered: must be boolean true)
  - Write / cleanup triggered:
    - Non-2xx status: No Map entry, no timer, no stream opened
    - 2xx + close=true: Temporary Map entry, event write (if present), immediate Map removal, timer clear, disconnect callback with reason="server_closed"
    - 2xx + no close: Map entry added, heartbeat timer started, stream remains open
  - Guards:
    - disconnected flag check before Map insertion (`plan.md:131-138`)
    - close field type validation (must be boolean) (`plan.md:396-399`)
    - Heartbeat timer cleared before Map removal (`plan.md:317-323`)
    - Disconnect callback sent only if connection was in Map (`plan.md:317-323`)
  - Invariant: Connection in Map ⟺ connection successfully opened AND not yet closed; Map entry always paired with valid heartbeat timer (or null before timer set)
  - Evidence: `plan.md:314-326` — Connection state after callback derivation

- Derived value: Disconnect callback reason classification
  - Source dataset: Event that triggered disconnect (client 'close' event, server close=true directive, write error exception)
  - Write / cleanup triggered: Sent in disconnect callback payload to Python; determines whether disconnect callback response body should be logged as WARN (hint: disconnect responses always logged as WARN if present, because connection already closing)
  - Guards:
    - client_closed: Set by handleDisconnect when 'close' event fires (src/routes/sse.ts:202-243)
    - server_closed: Set by handleServerClose when close=true in /internal/send OR callback response (src/routes/internal.ts:185-216)
    - error: Set when write fails in /internal/send OR callback response event write (plan.md:403-407)
  - Invariant: Disconnect callback includes exactly one reason; reason accurately reflects disconnect trigger; once connection cleanup begins, reason is immutable
  - Evidence: `plan.md:339-350` — Disconnect callback reason derivation

- Derived value: Event formatting from callback response
  - Source dataset: Filtered event object from callback response body (event.data required string, event.name optional string)
  - Write / cleanup triggered: formatSseEvent() call producing SSE-compliant string, written to response stream, flushed immediately
  - Guards:
    - event.data type check (must be string) (`plan.md:390-393`)
    - event.name type check (must be string or undefined) (`plan.md:390-393`)
    - formatSseEvent() handles multi-line data correctly (splits on \n, sends multiple data: lines) (`src/sse.ts:50-55`)
    - Write failure detection with error cleanup (`plan.md:403-407`)
  - Invariant: Only valid SSE-formatted events written to stream; malformed events logged and skipped; stream never corrupted by invalid event data
  - Evidence: `plan.md:327-338` — Event content from callback response derivation

**Filtered view risk assessment:** The callback response body parsing uses a **filtered** view (invalid fields stripped, malformed JSON defaulted to `{}`), but this is **safe** because:
1. **Guards present:** Type validation at `plan.md:177-179` ensures only valid data triggers writes
2. **No persistence:** All state is in-memory (Map + timers); no database writes that could orphan data
3. **Cleanup atomicity:** Map removal and timer clear are synchronous operations (`plan.md:317-323`)
4. **Error recovery:** Invalid data logged and ignored, never propagated to stream (`plan.md:383-402`)
5. **Backwards compatibility:** Default to `{}` ensures existing Python backends (no response body) continue working

No Major severity issues related to filtered views driving persistence without guards.

## 7) Risks & Mitigations (top 3)

- Risk: Python backend sends very large event.data in callback response, causing JSON parsing to exceed 5-second timeout
- Mitigation: Existing 5s timeout via AbortSignal.timeout(5000) covers entire callback duration including response.json() parsing (`plan.md:278, 408-412`); if timeout occurs, responseBody remains undefined and stream opens normally (backwards compatible); document recommended event size limits for Python backend developers
- Evidence: `plan.md:641-644` — Large event data risk; `src/callback.ts:136-143` — timeout implementation

- Risk: Disconnect callback response body parsing added even though responses cannot be applied (connection already closed), potentially confusing developers and wasting processing time
- Mitigation: (1) Clearly document in callback.ts that disconnect responses are informational only and never applied (`plan.md:125-127`); (2) Log at WARN level (not INFO) when disconnect callback returns event/close to signal unexpected usage (`plan.md:455-463`); (3) Include explicit documentation in plan that this is a limitation (`plan.md:577`); (4) Architectural justification provided: forwards compatibility with future Python features (e.g., analytics pipelines) (`plan.md:125-127`)
- Evidence: `plan.md:650-653` — Disconnect callback response risk; `plan.md:285-296` — Disconnect flow showing connection already closed

- Risk: Race condition window between first disconnected flag check (Step 7, `plan.md:263-267`) and event write (Step 8, `plan.md:264-265`) allows client disconnect to go undetected, causing write to fail and triggering spurious "error" disconnect callback instead of "client_closed"
- Mitigation: Step 11 added (`plan.md:267-270`) to re-check connectionRecord.disconnected flag immediately before calling handleEventAndClose; if disconnected=true, skip event/close entirely, remove from Map if present, log "Client disconnected before callback response applied"; test scenario added at `plan.md:558-566` to verify race condition handling
- Evidence: `plan.md:267-270` — Step 11 race guard; `plan.md:558-566` — Race condition test scenario

## 8) Confidence

Confidence: High — The plan demonstrates thorough analysis of the codebase, correctly identifies all affected areas, provides explicit behavioral specifications for all edge cases, includes comprehensive test coverage with deterministic scenarios, preserves all architectural invariants (event-before-close ordering, Map lifecycle, event loop serialization), addresses all previous review findings (module boundaries, race conditions, test gaps), and maintains strict backwards compatibility through lenient validation.
