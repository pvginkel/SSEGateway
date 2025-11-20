# Change Brief: Callback Buffering Cleanup

## Summary

Clean up and refine the event buffering implementation that addresses the race condition where Python sends events during SSE connection establishment.

## Background

The backend dev identified and fixed a race condition where Python might send events via `/internal/send` before SSE headers are sent. The fix adds event buffering during the callback window.

## Changes Needed

1. **Remove debug logging** - The DEBUG log statement in src/routes/sse.ts:165 should be removed or converted to proper info-level logging.

2. **Fix flush() call** - The attempted flush() call in src/routes/internal.ts:159-163 doesn't work with Express. Replace with a comment explaining Express's automatic flushing behavior.

3. **Add test coverage** for the race condition scenarios:
   - Events arriving before connection is ready (headers not sent)
   - Buffered events being flushed in correct order
   - Multiple buffered events preserving order
   - Response status 'buffered' when event arrives before ready
   - Mixed callback response events and buffered events

4. **Update CLAUDE.md** to document this buffering exception to the "no event buffering" rule.

## Core Implementation (Already Done)

The following are already implemented correctly and should be kept:
- Event buffer mechanism (ready flag + eventBuffer in ConnectionRecord)
- Early connection registration (before callback)
- Proper cleanup on callback failure
- Event ordering (callback event → buffered events → heartbeats)
