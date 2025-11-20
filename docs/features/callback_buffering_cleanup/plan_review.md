# Plan Review: Callback Buffering Cleanup

## 1) Summary & Decision

**Readiness**

The updated plan successfully addresses all previous review concerns and is ready for implementation. The plan correctly identifies this as a cleanup task for an already-working buffering implementation. The scope is well-defined: convert a debug log to INFO level, improve a comment about defensive flush() code, add comprehensive test coverage for buffering scenarios, and document the buffering exception in CLAUDE.md. All updates to address previous feedback are adequate—test coverage now includes callback failure and client disconnect with buffered events, flush() strategy is clarified with improved commenting instead of removal, CLAUDE.md documentation placement is precisely specified, line number corrections are in place, debug log is converted to INFO instead of removed, and eventBuffer clearing is verified in all test scenarios (line 223 confirms clearing, test plan requires verification).

**Decision**

`GO` — Plan is thorough, addresses all previous concerns, and correctly characterizes this as cleanup-only work with no functional changes. Implementation risk is minimal.

---

## 2) Conformance & Fit (with evidence)

**Conformance to refs**

- `docs/product_brief.md:34` — Pass — `plan.md:101` — Product brief states "Buffer events or reorder them" as a non-goal. Plan correctly documents this as an intentional exception for the callback window only, with clear bounds and rationale. The exception is justified by the race condition it solves.

- `docs/product_brief.md:247-248` — Pass — `plan.md:142-167` — Product brief states "All events for a token are serialized automatically due to Node's event loop." Plan correctly preserves this guarantee through synchronous buffer flush (line 209 in plan references synchronous operation).

- `docs/product_brief.md:158-159` — Pass — `plan.md:236-238` — Product brief requires immediate flushing of writes. Plan preserves this with the flush() defensive code at `src/routes/internal.ts:167-172`, even though Express doesn't expose flush().

- `CLAUDE.md:101` — Fail → Pass (with this plan) — `plan.md:96-104` — Current CLAUDE.md states "No event buffering/reordering" as absolute. Plan correctly adds footnote and new subsection to document the callback window exception with clear bounds and rationale.

- `CLAUDE.md:120` — Pass — `plan.md:219-220` — "Don't buffer events - flush immediately after every write" is correctly preserved. The callback window buffering is a necessary exception that doesn't violate the spirit of this rule since buffering duration is bounded by callback timeout (5s max).

**Fit with codebase**

- `src/connections.ts:28-30` — Pass — `plan.md:110-118` — ConnectionRecord interface already includes `ready: boolean` and `eventBuffer` array. No data model changes needed—plan correctly identifies this.

- `src/routes/sse.ts:165` — Pass — `plan.md:79-82` — Debug log exists as claimed. Conversion to INFO level with reduced verbosity (`hasEvent` and `hasClose` flags instead of full JSON) is appropriate.

- `src/routes/internal.ts:167-172` — Pass — `plan.md:84-87` — Flush() code exists as described. Plan correctly identifies it as defensive code that doesn't harm despite Express not exposing flush().

- `src/routes/sse.ts:223` — Pass — `plan.md:181-184, 313-314, 364` — EventBuffer is cleared after flush, validating the plan's invariant. Test plan requires verification of this clearing in all scenarios.

- `__tests__/utils/mockServer.ts:159-161` — Pass — `plan.md:330` — MockServer.setResponseBody() exists and supports testing callback response bodies.

- `__tests__/utils/mockServer.ts:146-148` — Pass — `plan.md:331` — MockServer.setDelay() exists for simulating slow callbacks.

---

## 3) Open Questions & Ambiguities

No open questions remain. All implementation details are clear:

- Line numbers have been corrected (167-172, not 159-163)
- Debug log conversion to INFO level is specified with exact format
- Flush() comment improvement is clearly scoped (improve comment, keep defensive code)
- CLAUDE.md documentation placement is precise (line 101 footnote + new subsection after line 172)
- Test coverage scenarios are exhaustive (8 scenarios covering buffering, failures, and edge cases)
- EventBuffer clearing verification is required in all test scenarios

---

## 4) Deterministic Backend Coverage (new/changed behavior only)

**Behavior: Event buffering during callback window**

- Scenarios:
  - Given SSE connection initiated and callback in progress, When `/internal/send` sends event before headers sent, Then event is buffered and API returns `{ status: 'buffered' }`, and event is delivered after headers sent, And `eventBuffer` is cleared after flush (`__tests__/integration/send.test.ts::new test`)
  - Given multiple events sent during callback window (3+ events), When callback completes successfully, Then all buffered events are delivered in order after callback response event, And `eventBuffer.length === 0` after flush (`__tests__/integration/send.test.ts::new test`)
  - Given callback response includes event and buffered events exist, When connection becomes ready, Then callback event is sent first, then buffered events in FIFO order, then heartbeats start (`__tests__/integration/send.test.ts::new test`)
  - Given 2+ events buffered and callback fails with 403, When connection is rejected, Then buffered events are discarded without writing to stream, And no disconnect callback sent, And connection removed from Map (`__tests__/integration/send.test.ts::new test`)
  - Given 2+ events buffered and client disconnects during callback (via abort), When disconnect detected before headers sent, Then buffered events are discarded without writes, And connection cleanup completes, And `disconnected: true` flag prevents header send (`__tests__/integration/send.test.ts::new test`)
  - Given buffered event with close flag and NO subsequent buffered events, When buffer is flushed, Then event is sent and connection is closed with reason "server_closed" (`__tests__/integration/send.test.ts::new test`)
  - Given callback response has event+close (no buffered events), When processing response, Then callback event sent, then connection closed immediately with reason "server_closed" (`__tests__/integration/send.test.ts::new test`)
  - Given buffered event with close=true followed by another buffered event, When buffer is flushed, Then verify first event sent, close executed, second event discarded (connection already closed) (`__tests__/integration/send.test.ts::new test`)

- Instrumentation:
  - Existing: `logger.info` at `src/routes/internal.ts:116` logs "Buffering event for token={token} (connection not ready)"
  - New: Converted debug log at `src/routes/sse.ts:165` becomes `logger.info` with format: `Callback response for token=${token}: hasEvent=${!!responseBody?.event} hasClose=${!!responseBody?.close}`
  - Existing: `logger.info` at `src/routes/sse.ts:178-180` logs "Applying callback response"

- Persistence hooks: None required (in-memory only, ephemeral state)

- Gaps: None. All scenarios are covered with specific assertions, including eventBuffer clearing verification.

- Evidence: `plan.md:307-342`

**Behavior: Flush() defensive code documentation**

- Scenarios: No new scenarios needed—existing send tests already exercise the flush() code path indirectly

- Instrumentation: No new instrumentation (comment-only change)

- Persistence hooks: None

- Gaps: None. This is a comment improvement only.

- Evidence: `plan.md:84-87`

**Behavior: CLAUDE.md documentation update**

- Scenarios: Not applicable (documentation only)

- Instrumentation: Not applicable

- Persistence hooks: Not applicable

- Gaps: None

- Evidence: `plan.md:94-104`

---

## 5) Adversarial Sweep (must find ≥3 credible issues or declare why none exist)

**Attempted checks and why the plan holds:**

- **Check 1: EventBuffer memory leak on failed callback**
  - Targeted invariant: Buffered events should not accumulate if callback fails
  - Evidence: `plan.md:318-319`, `src/routes/sse.ts:142-148`
  - Why the plan holds: When callback fails (non-2xx), connection is removed from Map before headers are sent. The ConnectionRecord (including eventBuffer) is garbage collected. Test scenario explicitly verifies "buffered events are discarded without writing to stream" and "connection removed from Map."

- **Check 2: EventBuffer not cleared after successful flush (duplicate sends)**
  - Targeted invariant: Buffer must be cleared after flush to prevent duplicate sends
  - Evidence: `plan.md:181-184`, `src/routes/sse.ts:223`
  - Why the plan holds: Line 223 in implementation shows `connectionRecord.eventBuffer = []` after flush loop. Plan explicitly requires test assertion `eventBuffer.length === 0` after flush in all test scenarios (lines 313, 315, 320, 364 in plan). This is a "Derived State & Invariants" entry (plan section 6).

- **Check 3: Race condition between buffer flush and new events arriving**
  - Targeted invariant: Events arriving during buffer flush should not interleave with buffered events
  - Evidence: `plan.md:206-210`, `src/routes/internal.ts:114`
  - Why the plan holds: Once `ready: true` is set (line 161 in sse.ts), new events skip buffering and write directly. Buffer flush is synchronous (for-loop at lines 205-222), and Node.js event loop serializes all operations for a token. The `ready` flag provides a clean state transition: before flush → buffer, after `ready: true` → direct write.

- **Check 4: Callback response event vs buffered event ordering**
  - Targeted invariant: Callback response event must be sent before buffered events
  - Evidence: `plan.md:162-163`, `src/routes/sse.ts:183-202` (callback response), `src/routes/sse.ts:204-222` (buffer flush)
  - Why the plan holds: Code structure enforces ordering: callback response processed at lines 183-202, then buffer flushed at lines 204-222. Test scenario explicitly verifies "callback event is sent first, then buffered events in FIFO order" (plan line 316-317).

- **Check 5: Heartbeat timer starting before buffer flush completes**
  - Targeted invariant: Heartbeats should not interleave with buffered events
  - Evidence: `plan.md:276-279`, `src/routes/sse.ts:225-254`
  - Why the plan holds: Heartbeat timer creation happens at line 226 AFTER buffer flush completes (line 223 clears buffer). Synchronous flush ensures heartbeat timer isn't created until all buffered events are sent.

- **Check 6: Info log exposing sensitive data in callback response**
  - Targeted invariant: Production logs should not expose potentially sensitive callback response bodies
  - Evidence: `plan.md:371-373`
  - Why the plan holds: Plan converts debug log from `JSON.stringify(responseBody)` to `hasEvent=${!!responseBody?.event} hasClose=${!!responseBody?.close}`, which only logs boolean flags. This reduces exposure while maintaining debugging capability.

No credible blocking issues found. The plan demonstrates strong attention to invariants and includes explicit verification in tests.

---

## 6) Derived-Value & Persistence Invariants (stacked entries)

- **Derived value: `ready` flag**
  - Source dataset: Set to `true` after `res.flushHeaders()` succeeds at `src/routes/sse.ts:161`
  - Write / cleanup triggered: Controls whether events are buffered (ready=false) or written directly (ready=true)
  - Guards: Checked before every event write at `src/routes/internal.ts:114`
  - Invariant: Once `ready: true`, must never revert to `false` (one-way transition). This prevents buffering after headers are sent.
  - Evidence: `plan.md:172-177`

- **Derived value: `eventBuffer` contents**
  - Source dataset: Populated by `/internal/send` requests arriving before `ready: true`
  - Write / cleanup triggered: Flushed after callback response event (lines 204-222), then cleared at line 223
  - Guards: Only written when `ready: false` (line 114-119), only read when `ready: true` (line 204-222)
  - Invariant: Buffer must be cleared after flush to prevent duplicate sends. Test plan requires `eventBuffer.length === 0` verification in all scenarios.
  - Evidence: `plan.md:179-184`, `src/routes/sse.ts:223`

- **Derived value: `disconnected` flag**
  - Source dataset: Set by 'close' event handler if client disconnects during callback
  - Write / cleanup triggered: Prevents header sending and Map insertion after callback returns
  - Guards: Checked before header send at `src/routes/sse.ts:142` and before callback response application at `src/routes/sse.ts:169`
  - Invariant: Once `disconnected: true`, connection must not become active. Buffered events are discarded without writes.
  - Evidence: `plan.md:186-191`

**Filtered-view write risk assessment:**

No filtered-view risks. All derived values operate on unfiltered connection state. EventBuffer contains raw events without filtering. The `ready` flag is set only after successful callback (no filtering applied). The `disconnected` flag is set by Express event listener (direct signal, not derived from filtered data).

---

## 7) Risks & Mitigations (top 3)

- **Risk:** Test timing sensitivity with async callback delays
  - **Mitigation:** Plan specifies sufficient delay in tests (200-300ms) and requires explicit verification of `ready: false` before sending buffered events to ensure race condition window is tested. MockServer.setDelay() supports this.
  - **Evidence:** `plan.md:375-377`, `plan.md:331`, `plan.md:334`

- **Risk:** Line numbers may drift between plan writing and implementation time
  - **Mitigation:** Plan explicitly notes "Verify line numbers at implementation time (may have drifted)" in implementation notes. Previous review identified line number errors (159-163 vs 167-172) and plan corrected them.
  - **Evidence:** `plan.md:360`

- **Risk:** INFO log level might still be too verbose or not verbose enough
  - **Mitigation:** Plan specifies exact log format with boolean flags (`hasEvent`, `hasClose`) instead of full JSON, balancing debugging capability with production noise reduction. This is a measured middle ground between removal (too little) and debug full JSON (too much).
  - **Evidence:** `plan.md:371-373`

---

## 8) Confidence

**Confidence: High** — This is cleanup-only work with no functional changes. The core buffering implementation is already correct and working (verified in code review at `src/routes/sse.ts:161-223`). Test infrastructure fully supports the required scenarios (MockServer has setDelay, setStatusCode, setResponseBody, clearCallbacks). All previous review concerns have been adequately addressed with specific, measurable updates. The plan demonstrates strong understanding of invariants, event ordering, and edge cases.
