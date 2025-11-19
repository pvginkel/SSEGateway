# Change Brief: Connect Callback Response

## Overview

Allow the Python backend to send an event and/or close the connection immediately when responding to a connect (or disconnect) callback.

## Current Behavior

- When SSEGateway sends a connect callback to Python, it only checks the HTTP status code
- If status code is non-2xx, the connection is immediately closed
- If status code is 2xx, the connection remains open and waits for future events via `/internal/send`
- The response body is currently ignored

## Desired Behavior

- Maintain current behavior: non-2xx status code closes the connection
- Extend callback response to optionally include a response body matching the `SendRequest` contract (without the `token` field):
  ```json
  {
    "event": {              // optional
      "name": "string",
      "data": "string"
    },
    "close": true           // optional
  }
  ```
- Default response body is `{}` (no action taken)
- If `event` is specified in the response, send it to the client immediately
- If `close` is true in the response, close the connection after sending any event
- If both `event` and `close` are present: send event first, then close (same as existing `/internal/send` logic)
- This applies to all callback actions (both connect and disconnect)

## Rationale

This allows Python to immediately send a welcome message or reject a connection with a specific error event without needing a separate `/internal/send` call.
