# Change Brief: Heartbeats & Polish

## Description

Implement periodic heartbeats for SSE connections and finalize error handling, logging, and integration testing.

## Functional Requirements

- Implement heartbeat system:
  - Send heartbeat comment for each active SSE connection: `: heartbeat\n`
  - Use interval from `HEARTBEAT_INTERVAL_SECONDS` environment variable (default: 15 seconds)
  - Flush immediately after writing heartbeat
  - Create timer when connection is established
  - Store timer in ConnectionRecord
  - Clear timer when connection is disconnected
  - Heartbeats are not visible to Python (no callback)

- Enhance error handling:
  - Catch and log all gateway errors
  - Close connections on error if applicable
  - Send disconnect callback with `reason: "error"` if connection was established
  - For callback errors: log only, no retries
  - Do not close SSE stream for disconnect callback failures
  - Close SSE stream if connect callback fails (already implemented in chunk 2)

- Complete logging coverage:
  - Server startup (port, environment config)
  - New connections with token
  - Callback results (success/failure with status codes)
  - Event sends
  - Connection closes
  - All errors with context

- Create integration tests:
  - Full connection lifecycle (connect → send event → heartbeat → close)
  - Multiple concurrent connections
  - Heartbeat timing verification
  - Error scenarios (write failures, callback failures)
  - Connection cleanup verification

## Success Criteria

- Heartbeats are sent at configured intervals to all active connections
- Heartbeat timers are properly created and cleaned up
- All error paths are handled gracefully with appropriate logging
- Disconnect callbacks include correct reason codes
- Integration tests verify end-to-end functionality
- All logging requirements from product brief are satisfied
- Server handles multiple concurrent connections correctly
- Memory cleanup is verified (no leaks from timers or connection records)
