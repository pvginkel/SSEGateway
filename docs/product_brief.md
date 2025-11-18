# **SSEGateway – Requirements Specification**

## 1. Purpose

The **SSEGateway** is a standalone Node-based service that:

1. Accepts incoming **Server-Sent Events (SSE)** connections from clients.
2. Notifies a Python backend when:

   * A client connects
   * A client disconnects
3. Accepts event emission commands from the Python backend and delivers them to the corresponding SSE client.
4. Implements full SSE stream semantics, including heartbeats and protocol formatting.
5. Runs as an internal sidecar, behind the same reverse proxy as the Python app.

The gateway **terminates the SSE connection**; it is *not* an HTTP reverse proxy.

---

## 2. High-Level Overview

### 2.1 Responsibilities

The SSEGateway must:

* Handle any number of SSE connections without blocking (Node’s event loop).
* Track active connections by token.
* Expose a single **/internal/send** endpoint for Python to:

  * Send an event
  * Close the connection
  * Or both in a single call
* Send connect/disconnect callbacks to a Python endpoint (configurable).
* Implement built-in SSE heartbeats via comments.
* Preserve ordering of events per-connection.
* Flush all events immediately.
* Provide health and readiness endpoints.
* Output plain logs.

### 2.2 Non-Responsibilities

The SSEGateway must **not**:

* Perform authentication or authorization.
* Parse cookies or headers.
* Parse or validate the incoming SSE request URL beyond separating the internal vs external path.
* Maintain any persistent state across restarts.
* Attempt reconnect logic on behalf of the client.
* Buffer or batch events.

---

## 3. External Interfaces

### 3.1 SSE Client Interface (Browser/Frontend → Gateway)

**Route:**

```
GET /sse/<any-path-and-query>
```

All paths under `/sse/*` are accepted.

**Behaviour:**

* SSE protocol headers are returned:

  * Content-Type: text/event-stream
  * Cache-Control: no-cache
  * Connection: keep-alive
  * X-Accel-Buffering: no
* A UUID token is generated for this connection.
* The client’s request metadata is captured:

  * Full URL including query string (unparsed)
  * All headers (forwarded verbatim)
  * Remote address (from Node)
* The Python backend is notified via the callback endpoint.
* Heartbeats are sent at interval **HeartbeatIntervalSeconds** (configurable), default **15s**.
* Connection remains open indefinitely.
* On disconnect (client closes or server closes), Python is notified.

### 3.2 Python → Gateway Interface

**Route:**

```
POST /internal/send
```

**Payload:**

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

**Rules:**

* `token` is required.
* `event` is optional.
* `close` is optional.
* If both `event` and `close` are provided → send event first, then close.
* If only `close` is provided → close immediately.
* `event.data` may contain newlines; gateway must split into multiple `data:` lines per SSE spec.
* `event.name` becomes the SSE event name field.
* Event delivery preserves order (guaranteed by Node’s event loop).
* Unknown fields in the payload are ignored.

### 3.3 Gateway → Python Callback

**ENV variable:**

```
CALLBACK_URL=https://python-app/sse-callback
```

**Route:**
POST to `{CALLBACK_URL}`

**Payload:**

```json
{
  "action": "connect" | "disconnect",
  "reason": "client_closed" | "server_closed" | "error",
  "token": "string",
  "request": {
    "url": "string", 
    "headers": { "header": "value", ... }
  }
}
```

**Rules:**

* On **connect**:

  * `action` = `"connect"`
  * No `reason`
* On **disconnect**:

  * `action` = `"disconnect"`
  * `reason` must reflect:

    * `"client_closed"` (client terminated the connection)
    * `"server_closed"` (Python requested closure via `/internal/send`)
    * `"error"` (gateway crashed/errored or early termination)
* Gateway must forward:

  * The *exact* request URL including query string
  * Headers verbatim (unchanged)
* Any non-2xx response must:

  * Abort the SSE connection immediately
  * Pass the HTTP status code and message to the client
  * The client is expected to retry

---

## 4. SSE Protocol Requirements

### 4.1 Formatting Rules

The SSEGateway must implement the full SSE protocol:

* `event: <name>` when an event name is provided.
* `data:` repeated for each line of event data.
* Each SSE event terminated by a blank line.
* Newlines in `event.data` must be split into multiple `data:` lines.
* No encoding or escaping applied to forwarded data.
* UTF-8 output.
* Immediate flushing after every event.

### 4.2 Heartbeats

* Heartbeats are mandatory, via SSE **comments**:

  ```
  : heartbeat
  ```
* Heartbeat interval controlled by an environment variable:

  ```
  HEARTBEAT_INTERVAL_SECONDS=15
  ```
* Default is **15 seconds**.
* Changing interval must not require restart (if feasible, but not required).
* Heartbeat comments must be flushed immediately.

### 4.3 Timeouts & Reconnection

* No idle timeouts; connections may remain open indefinitely.
* Gateway does not support sending comments via `/internal/send`.
* Gateway does not handle reconnections; client handles it.

---

## 5. Connection Lifecycle Requirements

### 5.1 On Connect

* Accept SSE request.
* Generate `token` (UUID).
* Store `token → connection`.
* Collect:

  * full request URL (string)
  * headers (verbatim key/value pairs)
  * remote address
* POST callback with `action = "connect"`.
* If callback returns:

  * **2xx** → proceed normally.
  * **non-2xx** → immediately close SSE connection with same status.

### 5.2 On Event Send

* Validate that `token` exists.
* If not found, return 404.
* If `event` exists, send SSE event.
* If `close = true`, close SSE after event (if any).
* If multiple sends arrive back-to-back, preserve ordering strictly.

### 5.3 On Disconnect

Triggered when:

* client closes the connection, or
* `/internal/send { close: true }` instructs the gateway to close, or
* internal errors occur.

Gateway must:

* Identify reason:

  * client_closed
  * server_closed
  * error
* POST callback with `action = "disconnect"`.
* Delete the token from internal store.

### 5.4 Restart Behavior

* On gateway restart all connections are lost.
* No state must be reloaded.
* No callback for restarts.

---

## 6. Routing Requirements

### 6.1 Accepted Routes

| Route            | Purpose                                         |
|------------------|-------------------------------------------------|
| `/sse/*`         | Accept client SSE connections, any path allowed |
| `/internal/send` | Receive event/close commands from Python        |
| `/healthz`       | Liveness check                                  |
| `/readyz`        | Readiness check                                 |

### 6.2 Routing Rules

* Any path under `/sse/` is valid.
* `/internal/*` namespace is reserved.
* NGINX or equivalent handles external routing; gateway expects to sit behind that.

---

## 7. Security Requirements

### 7.1 Authentication

* None.
* Python is responsible for request-level authentication using forwarded headers.

### 7.2 Authorization

* None.

### 7.3 Header Handling

* All inbound headers must be forwarded as-is in callback.
* Gateway must not inspect, parse, or modify them.

### 7.4 Transport

* All communication is internal; HTTPS optional but allowed.

---

## 8. Logging

* Plain console logging only.
* Must log:

  * Connect events
  * Disconnect events
  * Internal send errors (token not found, invalid payload)
  * Callback failures

---

## 9. Environment Variables

| Variable                     | Default        | Description                                                                  |
|------------------------------|----------------|------------------------------------------------------------------------------|
| `HEARTBEAT_INTERVAL_SECONDS` | `15`           | Interval for sending SSE comment heartbeats (`: heartbeat`)                  |
| `CALLBACK_URL`               | none, required | The Python callback endpoint. Used for connect and disconnect notifications. |

---

## 10. Non-Functional Requirements

* Must handle thousands of concurrent SSE connections.
* Single-instance operation only (no horizontal scaling).
* Must flush SSE output immediately (no buffering).
* Must not require local storage or shared persistence.
* Should run as a sidecar container in the same Kubernetes Pod as the Python service.

---

# **11. Final Protocol Definitions**

### 11.1 Send Endpoint (Python → Gateway)

```
POST /internal/send
```

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

* `token` required.
* `event.name` optional.
* `event.data` optional text (may contain `\n`).
* `close` optional.
* If both provided: send event then close.

---

### 11.2 Callback Payload (Gateway → Python)

```
POST {CALLBACK_URL}
```

```json
{
  "action": "connect" | "disconnect",
  "reason": "client_closed" | "server_closed" | "error",
  "token": "string",
  "request": {
    "url": "string",
    "headers": {
      "...": "..."
    }
  }
}
```

* `reason` included only for `disconnect`.
