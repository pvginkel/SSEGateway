# Code Review: Heartbeats & Polish Feature

**Reviewer:** Claude Code
**Date:** 2025-11-18
**Commit/Changes:** Unstaged changes + new test files for heartbeat functionality
**Plan Reference:** `/work/docs/features/04_heartbeats_polish/plan.md`

---

## 1) Summary & Decision

**Readiness**

The heartbeat implementation is architecturally sound and follows the plan structure correctly. Timer creation, storage, and cleanup logic are properly implemented. However, there is ONE critical blocker bug that prevents heartbeats from being received by clients: heartbeat comments are not properly terminated with double newlines as required by the SSE specification. This causes the SSE parser to not recognize heartbeat comments as complete messages, resulting in all heartbeat-related integration tests failing (15 failures). Once this bug is fixed, the implementation will be complete and ready for deployment.

**Decision**

`NO-GO` — Critical blocker: Heartbeat SSE format is incorrect. Heartbeats write `: heartbeat\n` but SSE spec requires `: heartbeat\n\n` for proper message delimitation. This single character bug breaks all heartbeat functionality.

---

## 2) Conformance to Plan (with evidence)

**Plan alignment**

- `Timer creation (Section 14, Slice 1)` ↔ `src/routes/sse.ts:154-182` — Heartbeat timer created using setInterval with config.heartbeatIntervalSeconds, stored in connectionRecord.heartbeatTimer
- `Timer callback sends heartbeat (Section 5)` ↔ `src/routes/sse.ts:155-179` — Timer callback writes `: heartbeat\n` to connection.res with defensive Map check and error handling
- `Timer cleanup (Section 5, Slice 3)` ↔ `src/routes/sse.ts:215 and src/routes/internal.ts:145,196` — clearInterval called in all disconnect paths (changed from clearTimeout as planned)
- `Heartbeat write error handling (Section 8)` ↔ `src/routes/sse.ts:173-178` — Catch block logs errors, doesn't crash process, lets 'close' event handle cleanup
- `Logging heartbeat creation (Section 9)` ↔ `src/routes/sse.ts:184-186` — Logs connection establishment with heartbeat interval
- `SSE stream reader utility (Section 14, Slice 6)` ↔ `__tests__/utils/sseStreamReader.ts:1-267` — Complete SSE parser with event and comment extraction
- `Integration tests (Section 14, Slices 4-5)` ↔ `__tests__/integration/heartbeat.test.ts and concurrency.test.ts` — Comprehensive test coverage for timing, delivery, cleanup, concurrency

**Gaps / deviations**

- `Heartbeat format (plan.md:239)` — Plan specifies `: heartbeat\n` (single newline) but SSE spec requires `: heartbeat\n\n` (double newline) for message delimitation. Implementation at `src/routes/sse.ts:165` writes `: heartbeat\n` which is incomplete. This is THE critical bug causing all test failures.
- `Timer cleanup semantic correctness (plan.md:582)` — Plan identified that clearInterval should be used instead of clearTimeout for setInterval timers. Implementation correctly changed to clearInterval at `src/routes/sse.ts:215` and `src/routes/internal.ts:145,196`. This is CORRECT (not a gap, just documenting the fix).
- `No missing deliverables` — All planned code files and tests are present. All plan requirements are implemented except for the heartbeat format bug.

---

## 3) Correctness — Findings (ranked)

- **Title:** `Blocker — Heartbeat SSE format missing terminating newline`
- **Evidence:** `src/routes/sse.ts:165` — `connection.res.write(': heartbeat\n');` writes single newline but SSE spec requires double newline to delimit messages
- **Impact:** Heartbeat comments are never recognized as complete SSE messages by client parsers. Clients buffer the incomplete message indefinitely waiting for the terminating blank line. All 15 heartbeat integration tests fail because SseStreamReader never receives complete heartbeat comments. Heartbeats don't function in production.
- **Fix:** Change line 165 to `connection.res.write(': heartbeat\n\n');` to add the required blank line terminator per SSE spec
- **Confidence:** High
- **Proof:** SSE specification (https://html.spec.whatwg.org/multipage/server-sent-events.html) states that stream consists of messages delimited by blank lines (two U+000A LINE FEED characters). `src/sse.ts:58` shows that formatSseEvent() adds `\n` terminator which combines with data line's `\n` to create `\n\n`. Heartbeat must follow same pattern. Test evidence: `__tests__/integration/heartbeat.test.ts:102-135` expects heartbeats in getHeartbeats() array but receives 0 heartbeats because parser can't detect message boundaries.

---

- **Title:** `Minor — Heartbeat backpressure logging may spam logs in high-backpressure scenarios`
- **Evidence:** `src/routes/sse.ts:168-171` — Logs INFO level message on every heartbeat write that returns false (backpressure)
- **Impact:** If client is consistently slow (e.g., mobile on poor connection), heartbeat timer fires every 15 seconds and logs backpressure each time. This could generate 4 log lines/minute per slow client. With 100 slow clients, this is 400 lines/minute. While not as severe as logging every successful heartbeat (which plan explicitly avoided), it's still potential log spam.
- **Fix:** Either downgrade to DEBUG level or add throttling (e.g., only log first backpressure occurrence per connection, or rate-limit to once per minute). Alternatively, accept current behavior as backpressure is notable event worth logging.
- **Confidence:** Medium — Depends on production traffic patterns and log volume tolerance.

---

- **Title:** `Minor — Comment in connections.ts is outdated (line 23)`
- **Evidence:** `src/connections.ts:23` — Comment says "Heartbeat timer (null for this feature - actual heartbeat implementation deferred)" but heartbeat is now implemented
- **Impact:** Comment is misleading to future developers reading the code. No functional impact.
- **Fix:** Change comment to "Heartbeat timer for periodic SSE keep-alive comments" or similar accurate description
- **Confidence:** High

---

## 4) Over-Engineering & Refactoring Opportunities

- **Hotspot:** No significant over-engineering detected
- **Evidence:** Implementation follows plan structure directly without unnecessary abstraction. Timer management is straightforward. Error handling is appropriate. Test utilities (SseStreamReader) are purpose-built and reusable.
- **Suggested refactor:** None required
- **Payoff:** N/A

---

## 5) Style & Consistency

- **Pattern:** Consistent error handling across heartbeat writes and event writes
- **Evidence:** `src/routes/sse.ts:173-178` heartbeat write error handling matches pattern from `src/routes/internal.ts:139-161` event write error handling - both catch exceptions, log errors, don't call disconnect handler (let 'close' event handle it)
- **Impact:** Positive consistency - makes codebase predictable and maintainable
- **Recommendation:** Maintain this pattern in any future write operations

---

- **Pattern:** Consistent timer cleanup with conditional check
- **Evidence:** `src/routes/sse.ts:214-216` and `src/routes/internal.ts:145-147,195-197` all use `if (connection.heartbeatTimer) clearInterval(connection.heartbeatTimer);` pattern
- **Impact:** Defensive programming prevents issues if timer is null. clearInterval(null) is safe but explicit check is clearer.
- **Recommendation:** Continue this pattern for clarity

---

## 6) Tests & Deterministic Coverage (new/changed behavior only)

- **Surface:** Heartbeat timer creation and storage
- **Scenarios:**
  - Given successful SSE connection, When connection added to Map, Then heartbeat timer created and stored (`__tests__/integration/heartbeat.test.ts::should create heartbeat timer when connection is established`) — PASSES
  - Given timer created, When connection in Map, Then timer field is not null (`__tests__/integration/heartbeat.test.ts::should log heartbeat interval when connection is established`) — PASSES
- **Hooks:** Spy on connections Map, verify timer ID is NodeJS.Timeout, use 1s interval for fast tests
- **Gaps:** None - timer creation is fully tested
- **Evidence:** Tests pass, verify timer exists in ConnectionRecord

---

- **Surface:** Heartbeat sending to SSE stream
- **Scenarios:**
  - Given active connection with timer, When interval elapses, Then heartbeat comment written to stream (`__tests__/integration/heartbeat.test.ts:102-135`) — FAILS (due to format bug)
  - Given multiple intervals, When timers fire, Then multiple heartbeats received (`__tests__/integration/heartbeat.test.ts:137-160`) — FAILS (due to format bug)
  - Given events and heartbeats, When both sent, Then interleaved in stream (`__tests__/integration/heartbeat.test.ts:162-220`) — FAILS (due to format bug)
- **Hooks:** SseStreamReader captures SSE output, 1s interval for testing
- **Gaps:** Tests are comprehensive but all fail due to heartbeat format bug. Once bug fixed, coverage will be complete.
- **Evidence:** Test structure is correct, failure is in implementation not tests

---

- **Surface:** Heartbeat timer cleanup on disconnect
- **Scenarios:**
  - Given active connection with timer, When client disconnects, Then timer cleared and Map empty (`__tests__/integration/heartbeat.test.ts:224-259`) — PASSES
  - Given server close, When connection closed, Then timer cleared (`__tests__/integration/heartbeat.test.ts:261-298`) — PASSES
  - Given write error, When disconnect triggered, Then timer cleared (`__tests__/integration/heartbeat.test.ts:300-336`) — PASSES
- **Hooks:** Verify connections.has(token) false after disconnect, check disconnect callbacks
- **Gaps:** None - cleanup is fully tested and working
- **Evidence:** All cleanup tests pass

---

- **Surface:** Multiple concurrent connections with independent timers
- **Scenarios:**
  - Given 10 connections, When all active, Then each has unique timer (`__tests__/integration/concurrency.test.ts:52-112`) — FAILS (heartbeat capture fails due to format bug, but timer creation works)
  - Given 5 connections, When heartbeats sent, Then each receives independently (`__tests__/integration/concurrency.test.ts:114-157`) — FAILS (format bug)
  - Given staggered connections, When established at different times, Then independent heartbeats (`__tests__/integration/concurrency.test.ts:159-205`) — FAILS (format bug)
  - Given 50 connections stress test, When all timers active, Then all cleanup correctly (`__tests__/integration/concurrency.test.ts:481-519`) — PASSES
- **Hooks:** Create multiple connections in parallel, verify Map size, check timer uniqueness
- **Gaps:** Stress test passes (focuses on timer creation/cleanup), but heartbeat delivery tests fail due to format bug. Once fixed, coverage will be complete.
- **Evidence:** Tests demonstrate comprehensive concurrency scenarios

---

- **Surface:** Memory cleanup verification
- **Scenarios:**
  - Given 20 connections, When all closed, Then Map empty and timers cleared (`__tests__/integration/heartbeat.test.ts:482-515`) — PASSES
  - Given connection never reaches Map (race condition), When callback delayed, Then no leaks (`__tests__/integration/heartbeat.test.ts:517-531`) — PASSES
- **Hooks:** Verify connections.size === 0, spy on clearInterval calls
- **Gaps:** None - memory cleanup is proven
- **Evidence:** Tests pass, demonstrate no timer leaks

---

## 7) Adversarial Sweep (must attempt ≥3 credible failures or justify none)

**Attack 1: Heartbeat timer fires after connection removed from Map (race condition)**
- **Evidence:** `src/routes/sse.ts:157-161` implements defensive check: `if (!connection) return;`
- **Attempted failure:** Timer fires → disconnect handler removes from Map → timer callback executes → getConnection returns undefined
- **Why code held up:** Defensive check at line 157 detects missing connection and returns early without attempting write. No crash, no error log spam. Race window is milliseconds between timer fire and callback execution.

**Attack 2: Heartbeat write throws exception crashes Node process**
- **Evidence:** `src/routes/sse.ts:164-178` wraps write in try-catch
- **Attempted failure:** Timer fires → connection.res stream closed → write() throws → uncaught exception crashes process
- **Why code held up:** Try-catch at line 164 catches any exception from write(), logs error at line 176, continues execution. Timer keeps firing (will be cleared by 'close' event handler). Process never crashes from heartbeat write failures.

**Attack 3: Timer not cleared on disconnect causes memory leak**
- **Evidence:** `src/routes/sse.ts:214-216`, `src/routes/internal.ts:145-147,195-197` all clear timer before Map removal
- **Attempted failure:** Connection closes → disconnect handler forgets to clear timer → timer keeps firing forever → holds reference to ConnectionRecord → memory leak → OOM after many connections
- **Why code held up:** All three disconnect code paths (client close, server close, error) clear timer using clearInterval. Timer cleanup happens before Map removal. Integration test `__tests__/integration/heartbeat.test.ts:482-515` creates/closes 20 connections and verifies Map is empty, proving no leaks.

**Attack 4: Multiple timers created for same connection**
- **Evidence:** `src/routes/sse.ts:154-182` creates timer once after connection established, stores in heartbeatTimer field
- **Attempted failure:** Timer creation code runs multiple times → multiple setInterval timers → duplicate heartbeats → timers not all cleared → leak
- **Why code held up:** Timer created in connection establishment flow which runs exactly once per connection. No code path creates second timer. ConnectionRecord.heartbeatTimer holds single timer reference. Only one clearInterval call needed.

**Attack 5: Heartbeat backpressure (write returns false) blocks event loop**
- **Evidence:** `src/routes/sse.ts:168-171` checks write return value, logs but continues
- **Attempted failure:** Slow client → write() returns false (backpressure) → timer callback blocks waiting for drain → event loop starved → all connections hang
- **Why code held up:** Timer callback doesn't await drain event. Just logs INFO and returns. Write operation is non-blocking. Timer continues firing on schedule. Client will catch up or disconnect. Best-effort heartbeat design prevents event loop blocking.

---

## 8) Invariants Checklist (stacked entries)

- **Invariant:** Every connection in Map has a non-null heartbeatTimer that is actively firing
  - **Where enforced:** `src/routes/sse.ts:154-182` creates timer immediately after adding connection to Map (line 151), stores at line 182
  - **Failure mode:** Connection added to Map but timer is null → no heartbeats sent → connection may timeout at proxy/NAT layer → unexpected disconnect
  - **Protection:** Timer creation is synchronous and unconditional after Map.set(). Integration test `__tests__/integration/heartbeat.test.ts:51-74` verifies heartbeatTimer field is not null after connection establishment.
  - **Evidence:** Code inspection shows no code path that adds connection without creating timer. All tests verify timer exists.

---

- **Invariant:** Heartbeat timer is cleared before connection removed from Map (no dangling timers)
  - **Where enforced:** `src/routes/sse.ts:214-216` clears timer before removeConnection() at line 218. Same pattern in `src/routes/internal.ts:145-147 then 148` and `195-197 then 200`.
  - **Failure mode:** Connection removed from Map but timer not cleared → timer keeps firing → timer callback tries to access removed connection → logs errors every interval forever → memory leak
  - **Protection:** Defensive check in timer callback (line 157) returns early if connection missing. Timer cleanup is explicit and precedes Map removal in all code paths. Integration test `__tests__/integration/heartbeat.test.ts:482-515` verifies Map is empty after 20 connect/disconnect cycles.
  - **Evidence:** All three disconnect code paths clear timer. Test proves no leaks.

---

- **Invariant:** Heartbeat write failures do not trigger manual disconnect (only 'close' event handler disconnects)
  - **Where enforced:** `src/routes/sse.ts:173-178` catch block logs error but does NOT call disconnect handler or removeConnection()
  - **Failure mode:** Heartbeat write fails → code calls disconnect handler → disconnect callback sent to Python → but client might reconnect → Python sees duplicate disconnect callbacks → confused state
  - **Protection:** Heartbeat write error handling only logs, doesn't modify connection state. Comment at line 177 explicitly states "Do not call disconnect handler here - let 'close' event handle cleanup". Express will emit 'close' event when stream actually closes, triggering proper cleanup with single disconnect callback.
  - **Evidence:** Error handling code has no disconnect call. Comment documents design decision.

---

## 9) Questions / Needs-Info

- **Question:** Should heartbeat backpressure logging be throttled or downgraded to DEBUG level?
- **Why it matters:** Current INFO level logging on every backpressure event could generate significant log volume if many clients are slow (mobile, poor connections). Plan explicitly avoided logging routine successful heartbeats to prevent spam, but didn't address backpressure logging frequency.
- **Desired answer:** Product decision: Keep INFO level (backpressure is notable event) OR downgrade to DEBUG (backpressure is expected during normal operation) OR add throttling (log first occurrence per connection only).

---

## 10) Risks & Mitigations (top 3)

- **Risk:** Heartbeat format bug (missing terminating newline) breaks all heartbeat functionality in production
- **Mitigation:** Fix `src/routes/sse.ts:165` to write `: heartbeat\n\n` before deployment. Re-run integration tests to verify all 15 failures become passes. Manual test with browser EventSource to confirm heartbeats received.
- **Evidence:** Finding #1 (Blocker), all heartbeat integration tests fail, `src/sse.ts:58` shows correct pattern with double newline

---

- **Risk:** Heartbeat backpressure logging spam in production with many slow clients
- **Mitigation:** Before deployment, decide on logging level/throttling strategy (see Question #1). Monitor log volume in staging environment with simulated slow clients. Add log volume alerts to catch unexpected spam.
- **Evidence:** Finding #2 (Minor), `src/routes/sse.ts:168-171` logs every backpressure event

---

- **Risk:** Timer precision drift over long connection durations (Node.js setInterval jitter)
- **Mitigation:** Accept approximate timing - heartbeats are for keep-alive, not precise timing. setInterval maintains average rate. If drift becomes issue in production (unlikely), consider setTimeout with manual rescheduling to calculate exact next fire time. Current implementation is sufficient for keep-alive use case.
- **Evidence:** plan.md:572-575 identified this risk, determined setInterval is adequate for approximate heartbeat timing

---

## 11) Confidence

**Confidence:** High — Single blocker bug is trivial one-character fix with clear root cause and verification path. Implementation structure is sound, matches plan precisely, and demonstrates thorough error handling and resource cleanup. Tests are comprehensive and will validate fix once applied. No architectural concerns or complex state management issues. Risk profile is low after format bug fix.

---

## ACTIONABLE SUMMARY

**Required before GO:**

1. **BLOCKER FIX:** Change `src/routes/sse.ts:165` from `connection.res.write(': heartbeat\n');` to `connection.res.write(': heartbeat\n\n');`
2. **Run tests:** Verify all 15 heartbeat/concurrency test failures become passes after fix
3. **Update comment:** Change `src/connections.ts:23` to accurately describe heartbeat timer (no longer deferred)
4. **Decide logging:** Determine if heartbeat backpressure logging should be throttled/downgraded (Minor, can defer to post-deployment monitoring)

**Expected outcome after blocker fix:**
- All integration tests pass (75/75)
- Heartbeats function correctly in production
- Ready for deployment
