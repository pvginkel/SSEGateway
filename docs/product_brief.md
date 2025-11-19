# **SSEGateway – Complete Requirements Specification**

Version: **1.0**
Audience: **Developers**
Purpose: **Implement the SSEGateway sidecar service**

---

# **1. Overview**

## **1.1 Purpose**

The **SSEGateway** is an internal service that:

* Accepts and manages **Server-Sent Event (SSE)** connections from clients.
* Notifies the Python backend about connects and disconnects.
* Receives event instructions from the Python backend and forwards them to the corresponding SSE connection.
* Can optionally close a connection, either alone or after sending an event.
* Sends periodic heartbeats to keep long-lived SSE connections alive.
* Runs as a sidecar service in the same Kubernetes Pod as the Python backend.

The SSEGateway *terminates* the SSE connection.
It is **not** an HTTP reverse proxy.

## **1.2 Non-goals**

The gateway does **not**:

* Authenticate or authorize clients.
* Parse cookies or validate headers.
* Parse or validate the request URL.
* Persist state across restarts.
* Support horizontal scaling.
* Buffer events or reorder them.
* Perform WebSocket upgrades.

---

# **2. Architecture & Runtime**

## **2.1 Technology Stack**

* **Node.js 20 (LTS)**

  * Required for native `fetch()`
  * Required for stable ESM behavior
  * Single event loop ensures ordered writes

* **TypeScript 5.x**

* **Module System:** ESM only

  * `"type": "module"` in package.json
  * `"module": "NodeNext"` in tsconfig

* **Framework:** Express 5

  * Simple SSE support
  * Good for internal service use
  * No compression

## **2.2 Process Model**

* Single Node process
* Single-threaded event loop
* No clustering
* All connection state held in-memory

## **2.3 Performance Target**

* Thousands of concurrent SSE connections
* Ordered delivery guaranteed by the event loop
* Immediate flushing of all writes

---

# **3. Routing & Endpoints**

## **3.1 SSE Endpoint (Client → Gateway)**

### **Route**

```
GET /<any-path-and-query>
```

### **Rules**

* Accept **any** path without restriction
* Do not parse or validate the path or query string
* Store the **full raw URL** in callback payload
* Forward headers verbatim in callback payload

### **SSE Response Headers**

```
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive
X-Accel-Buffering: no
```

### **SSE Connection Initialization**

* Generate a UUID token using `crypto.randomUUID()`
* Store connection in `Map<token, ConnectionRecord>`
* Send callback to Python with `"action": "connect"`

### **If callback returns non-2xx**

* Immediately close SSE stream
* Return the same HTTP status code to the client

## **3.2 Python → Gateway: Send/Close Command**

### **Route**

```
POST /internal/send
```

### **Payload**

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

### **Rules**

* `token` is required
* `event` is optional
* `close` is optional
* If both are given → send event first, then close
* Unknown fields ignored
* If token not known → respond 404

### **Event Formatting Requirements**

* Follow full SSE spec:

  * If event name present:

    ```
    event: <name>
    ```
  * For event data:

    * Split `data` on newline
    * Send one `data:` line per data line
  * End event with blank line

* Immediately flush writes

### **Closing the stream**

* If `close = true`, terminate connection cleanly after event
* Send disconnect callback with:

  * `reason = "server_closed"`

## **3.3 Gateway → Python Callback**

### **Configured by environment:**

```
CALLBACK_URL=https://python-app/sse-callback
```

### **Route**

`POST` to the configured URL

### **Payload**

```json
{
  "action": "connect" | "disconnect",
  "reason": "client_closed" | "server_closed" | "error",
  "token": "string",
  "request": {
    "url": "string",
    "headers": { "header": "value" }
  }
}
```

### **Rules**

* `reason` is **required only** for `"disconnect"`
* `request.url` is the raw incoming URL, including query string
* `request.headers` are the raw incoming headers
* Best-effort:

  * No retries
  * Errors are logged only

## **3.4 Health Endpoints**

### **Healthz**

```
GET /healthz
```

* Always 200 unless server is in fatal state

### **Readyz**

```
GET /readyz
```

* Returns 200 once:

  * `CALLBACK_URL` is configured
  * Server initialization complete
* Otherwise 503

---

# **4. Connection Lifecycle**

## **4.1 Connect**

1. Client sends `GET <any-path>`
2. Gateway generates `token`
3. Gateway stores connection state
4. Gateway POSTs callback:

   ```
   { action: "connect", token, request: {...} }
   ```
5. If Python returns non-2xx:

   * SSE immediately terminated
   * HTTP error returned to client

## **4.2 Sending Events**

* All events for a token are serialized automatically due to Node’s event loop.
* No additional ordering logic required.

## **4.3 Heartbeats**

### **Format**

```
: heartbeat
```

### **Interval**

* Controlled by environment variable:

  ```
  HEARTBEAT_INTERVAL_SECONDS=15
  ```
* Default: **15 seconds**

### **Behaviour**

* Sent for each active SSE connection
* Flushed immediately
* Not visible to Python (not in callback)
* Always implemented internally by gateway

## **4.4 Disconnect Handling**

Disconnect can be triggered by:

* Client closing the browser
* Network interruption
* Server error (write failure)
* Python sending `close: true`

### **On Disconnect**

Gateway sends callback:

```json
{
  "action": "disconnect",
  "reason": "client_closed" | "server_closed" | "error",
  "token": "...",
  "request": { ... }
}
```

### **Deletion**

* After disconnect callback, token removed from memory

## **4.5 Restart Behaviour**

* All connections lost immediately
* No callbacks sent
* No state reloaded

---

# **5. Data Structures**

## **5.1 Connection Record**

Developers must implement:

```ts
interface ConnectionRecord {
  res: express.Response;
  request: {
    url: string;
    headers: Record<string, string | string[] | undefined>;
  };
  heartbeatTimer: NodeJS.Timeout;
}
```

---

# **6. Error Handling**

## **6.1 Gateway Errors**

* Log error
* Close connection if applicable
* Send disconnect callback if connection had been established

## **6.2 Internal/Send Errors**

* Unknown token → 404
* Invalid types → 400
* Write failure → treat as disconnect, reason `"error"`

## **6.3 Callback Errors**

* Log only
* No retries
* Do not close SSE stream for disconnect callbacks
* Do close SSE stream if connect callback fails (per connect rules)

---

# **7. Security Requirements**

* No authentication
* No authorization
* No header parsing beyond passing through to callback
* Rely on Python and NGINX for access control
* No modification of headers or cookies

---

# **8. Logging Requirements**

## **8.1 Format**

Plain text:

```
[INFO] message
[ERROR] message
```

## **8.2 Events to Log**

* Server startup (port, env)
* New connection with token
* Callback results (success/failure)
* Event sends
* Closing connections
* Errors

---

# **9. Configuration**

## **9.1 Required Environment Variables**

| Variable                     | Default | Required | Description                              |
| ---------------------------- | ------- | -------- | ---------------------------------------- |
| `CALLBACK_URL`               | none    | Yes      | Callback endpoint for connect/disconnect |
| `HEARTBEAT_INTERVAL_SECONDS` | `15`    | No       | Heartbeat interval per connection        |

---

# **10. Non-Functional Requirements**

* Must run as a sidecar inside the same Kubernetes Pod as Python backend.
* No persistence or shared state.
* Operational correctness depends on single-instance deployment.
* Event ordering guaranteed per token.
* SSE output must not be compressed by gateway.
* Flush after every write.

---

# **11. Summary of All Developer Decisions**

| Category        | Decision                          |
| --------------- | --------------------------------- |
| Framework       | Express 5                         |
| Language        | TypeScript 5                      |
| Module System   | ESM                               |
| Node Version    | Node 20                           |
| Validation      | Minimal (manual)                  |
| Ordering        | Guaranteed by event loop          |
| Heartbeats      | Internally generated, default 15s |
| Close Semantics | Event then close                  |
| Persistence     | None                              |
| Scaling         | Single instance only              |
| Logging         | Plain text                        |
| Headers         | Forward unchanged                 |
| URL             | Forward raw                       |
| Spec Compliance | Full SSE spec                     |
