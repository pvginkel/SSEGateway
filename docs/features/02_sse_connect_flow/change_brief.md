# Change Brief: SSE Connect Flow

## Description

Implement the Server-Sent Events (SSE) connection endpoint that accepts client connections, notifies the Python backend, and handles disconnections.

## Functional Requirements

- Implement `GET /sse/*` endpoint that:
  - Accepts any path and query string under `/sse/`
  - Stores the full raw URL without parsing or validation
  - Returns SSE headers:
    - `Content-Type: text/event-stream`
    - `Cache-Control: no-cache`
    - `Connection: keep-alive`
    - `X-Accel-Buffering: no`
  - Generates a UUID token using `crypto.randomUUID()`
  - Stores connection in `Map<token, ConnectionRecord>` where ConnectionRecord contains:
    - Express Response object
    - Request metadata (url, headers)
    - Heartbeat timer (placeholder for now)

- Implement connect callback to Python backend:
  - POST to configured CALLBACK_URL
  - Payload format:
    ```json
    {
      "action": "connect",
      "token": "uuid",
      "request": {
        "url": "raw-url-with-query",
        "headers": { "header": "value" }
      }
    }
    ```
  - If callback returns non-2xx status:
    - Immediately close SSE stream
    - Return same HTTP status code to client

- Implement disconnect detection:
  - Detect when client closes connection
  - Send disconnect callback to Python:
    ```json
    {
      "action": "disconnect",
      "reason": "client_closed",
      "token": "uuid",
      "request": { "url": "...", "headers": {...} }
    }
    ```
  - Remove token from connection map
  - Log all connection and disconnection events

## Success Criteria

- Clients can establish SSE connections to any path under `/sse/`
- Connection tokens are generated and stored
- Connect callback is sent to Python backend with correct payload
- Connections are rejected when Python returns non-2xx
- Client disconnects are detected and callback is sent with `reason: "client_closed"`
- Connection state is properly cleaned up on disconnect
- Tests cover connect, reject, and disconnect scenarios
