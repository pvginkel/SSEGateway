# Change Brief: Send & Close Operations

## Description

Implement the internal API endpoint that allows the Python backend to send SSE events to clients and optionally close connections.

## Functional Requirements

- Implement `POST /internal/send` endpoint that accepts:
  ```json
  {
    "token": "string",
    "event": {
      "name": "string",
      "data": "string"
    },
    "close": true
  }
  ```
  Where:
  - `token` is required
  - `event` is optional
  - `close` is optional
  - Unknown fields are ignored

- Implement SSE event formatting following the full SSE specification:
  - If event name is present, write: `event: <name>\n`
  - Split event data on newlines
  - Write one `data: <line>` for each line of data
  - End event with blank line (`\n\n`)
  - Immediately flush after writing

- Implement connection closing:
  - If `close: true` is provided, terminate connection after sending event (if present)
  - Send disconnect callback to Python:
    ```json
    {
      "action": "disconnect",
      "reason": "server_closed",
      "token": "uuid",
      "request": { "url": "...", "headers": {...} }
    }
    ```
  - Remove token from connection map

- Implement error handling:
  - Return 404 if token is unknown
  - Return 400 for invalid request types
  - If write fails, treat as disconnect with `reason: "error"` and send callback

- Log all send and close operations

## Success Criteria

- Python backend can send events to connected clients via token
- SSE events are formatted correctly per specification
- Multiline data is properly split and sent
- Event names are included when provided
- Connections close cleanly when requested
- Disconnect callback is sent with `reason: "server_closed"` after close
- Unknown tokens return 404
- Write failures trigger disconnect callback with `reason: "error"`
- Tests cover event sending, closing, multiline data, and error cases
