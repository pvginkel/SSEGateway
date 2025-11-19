# SSEGateway

A lightweight Node.js sidecar service that terminates Server-Sent Event (SSE) connections and coordinates with a Python backend. SSEGateway is designed to handle the long-lived nature of SSE connections while allowing your Python application to focus on business logic.

## Features

- **SSE Connection Management**: Handles SSE connection lifecycle (connect, send events, disconnect)
- **Backend Coordination**: Notifies Python backend of connection events via callbacks
- **Immediate Callback Responses**: Python can send events or close connections directly in callback responses
- **Universal Path Support**: Accepts SSE connections on any path, forwarding raw URLs to backend
- **Automatic Heartbeats**: Configurable heartbeat mechanism to keep connections alive
- **Health Checks**: Built-in `/healthz` and `/readyz` endpoints for orchestration
- **TypeScript**: Fully typed with TypeScript for better developer experience
- **Production Ready**: Docker support, comprehensive test suite, and CI/CD pipeline

## Architecture

SSEGateway is **not** an HTTP reverse proxy. It owns the SSE connection lifecycle and acts as a coordinator between clients and your Python backend:

```
Client (SSE) <---> SSEGateway <---> Python Backend (HTTP callbacks)
```

### How It Works

1. Client connects to any path (e.g., `/events`, `/channel/123`)
2. SSEGateway generates a unique token and makes a `connect` callback to Python
3. Python validates the connection and returns 200 (accept) or non-2xx (reject)
   - Python can optionally include events/close directives in the callback response for immediate action
4. Python sends events via `POST /internal/send` with the connection token
5. SSEGateway forwards events to the client over SSE
6. On disconnect, SSEGateway notifies Python with a `disconnect` callback

### Design Principles

- **Single process, single-threaded**: No clustering (ensures event ordering)
- **In-memory state only**: No persistence layer
- **Immediate flushing**: Every SSE write flushes immediately
- **Best-effort callbacks**: No retries on callback failures
- **No compression**: SSE output never compressed

## Installation

### Requirements

- Node.js 20 LTS or higher
- Python backend service (for callbacks)

### Install Dependencies

```bash
npm install
```

### Build

```bash
npm run build
```

### Run

```bash
npm start
```

## Configuration

Configure via environment variables:

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `CALLBACK_URL` | **Yes** | - | Python backend callback endpoint (e.g., `http://localhost:8000/sse/callback`) |
| `PORT` | No | `3000` | Port for SSEGateway to listen on |
| `HEARTBEAT_INTERVAL_SECONDS` | No | `15` | Interval for SSE heartbeat comments |

### Example

```bash
export CALLBACK_URL=http://localhost:8000/sse/callback
export PORT=3000
export HEARTBEAT_INTERVAL_SECONDS=15
npm start
```

## API

### SSE Endpoint

**`GET /*`** - Accept SSE connections on any path

SSEGateway accepts connections on **any path** and forwards the raw URL to your Python backend.

**Example:**
```bash
curl -N http://localhost:3000/channel/updates?user=123
```

**Flow:**
1. Client connects
2. SSEGateway generates token: `550e8400-e29b-41d4-a716-446655440000`
3. Calls Python: `POST $CALLBACK_URL`
   ```json
   {
     "action": "connect",
     "token": "550e8400-e29b-41d4-a716-446655440000",
     "request": {
       "url": "/channel/updates?user=123",
       "headers": {
         "user-agent": "curl/7.68.0",
         ...
       }
     }
   }
   ```
4. Python responds:
   - If 200: connection stays open
   - If non-2xx: connection closes immediately with same status
   - **Optional response body**: Python can include event/close in the response (see below)

**Callback Response Body (Optional):**

Python can optionally include a response body in the connect callback to send events or close the connection immediately:

```json
{
  "event": {
    "name": "welcome",
    "data": "Connection established"
  },
  "close": true
}
```

**Fields:**
- `event` (optional): Event to send immediately upon connection
  - `name` (optional): SSE event name
  - `data` (required): Event data (string)
- `close` (optional): If true, close connection immediately (after sending event if present)

**Examples:**

Send a welcome message:
```json
{
  "event": {
    "name": "welcome",
    "data": "Connected to channel updates"
  }
}
```

Reject with an error event:
```json
{
  "event": {
    "name": "error",
    "data": "Unauthorized access"
  },
  "close": true
}
```
*(Note: In this case, you should also return a non-2xx status code)*

**Behavior:**
- Empty response body `{}` (default): Connection opens normally
- Invalid JSON or malformed structures: Logged and ignored, connection proceeds normally
- If both `event` and `close` are present: Event is sent first, then connection closes
- **Backwards compatible**: Existing Python backends work unchanged

### Send/Close Endpoint

**`POST /internal/send`** - Send events or close connections (called by Python)

**Request Body:**
```json
{
  "token": "550e8400-e29b-41d4-a716-446655440000",
  "event": {
    "name": "message",
    "data": "Hello, World!"
  },
  "close": true
}
```

**Fields:**
- `token` (required): Connection token from connect callback
- `event` (optional): Event to send
  - `name` (optional): SSE event name
  - `data` (required): Event data (string)
- `close` (optional): If true, close connection after sending event

**Responses:**
- `200`: Success
- `400`: Invalid request (bad types or missing required fields)
- `404`: Unknown token (connection not found)

**Examples:**

Send an event:
```bash
curl -X POST http://localhost:3000/internal/send \
  -H "Content-Type: application/json" \
  -d '{
    "token": "550e8400-e29b-41d4-a716-446655440000",
    "event": {
      "name": "update",
      "data": "New data available"
    }
  }'
```

Send event and close:
```bash
curl -X POST http://localhost:3000/internal/send \
  -H "Content-Type: application/json" \
  -d '{
    "token": "550e8400-e29b-41d4-a716-446655440000",
    "event": {
      "name": "goodbye",
      "data": "Connection closing"
    },
    "close": true
  }'
```

Close without event:
```bash
curl -X POST http://localhost:3000/internal/send \
  -H "Content-Type: application/json" \
  -d '{
    "token": "550e8400-e29b-41d4-a716-446655440000",
    "close": true
  }'
```

### Health Endpoints

**`GET /healthz`** - Liveness probe
- Returns `200` unless fatal error

**`GET /readyz`** - Readiness probe
- Returns `200` when `CALLBACK_URL` configured and server ready
- Returns `503` otherwise

### Disconnect Callback

When a connection closes, SSEGateway calls your Python backend:

```json
{
  "action": "disconnect",
  "reason": "client_closed",
  "token": "550e8400-e29b-41d4-a716-446655440000",
  "request": {
    "url": "/channel/updates?user=123",
    "headers": { ... }
  }
}
```

**Disconnect Reasons:**
- `"client_closed"`: Client disconnected
- `"server_closed"`: Python sent `close: true` (via `/internal/send` or callback response)
- `"error"`: Write failure or other error

**Note:** Disconnect callbacks can also include a response body with `event`/`close` fields, but these are informational only and cannot be applied (the connection is already closing). Such response bodies are logged at WARN level.

## Development

### Run in Development Mode

```bash
npm run dev
```

### Run Tests

```bash
# Run all tests
npm test

# Run with coverage
npm run test:coverage

# Watch mode
npm run test:watch
```

### Project Structure

```
ssegateway/
├── src/
│   ├── index.ts              # Entry point
│   ├── server.ts             # Express app and routes
│   ├── connections.ts        # Connection state management
│   ├── sse.ts               # SSE formatting utilities
│   ├── callback.ts          # Python callback logic
│   ├── config.ts            # Environment configuration
│   ├── logger.ts            # Logging utilities
│   └── routes/
│       ├── sse.ts           # SSE connection handler
│       ├── internal.ts      # /internal/send handler
│       └── health.ts        # Health check handlers
├── __tests__/               # Test files
├── docs/                    # Documentation
├── package.json
├── tsconfig.json
└── Dockerfile
```

## Docker Deployment

### Build Image

```bash
docker build -t ssegateway:latest .
```

### Run Container

```bash
docker run -d \
  -p 3000:3000 \
  -e CALLBACK_URL=http://python-backend:8000/sse/callback \
  -e HEARTBEAT_INTERVAL_SECONDS=15 \
  --name ssegateway \
  ssegateway:latest
```

### Docker Compose Example

```yaml
version: '3.8'

services:
  ssegateway:
    build: .
    ports:
      - "3000:3000"
    environment:
      - CALLBACK_URL=http://python-backend:8000/sse/callback
      - HEARTBEAT_INTERVAL_SECONDS=15
    depends_on:
      - python-backend
    restart: unless-stopped

  python-backend:
    # Your Python service configuration
    ...
```

## SSE Event Format

Events follow the SSE specification strictly:

```
event: message
data: First line
data: Second line

: heartbeat

event: update
data: {"status": "ok"}

```

- Event name line (if present): `event: <name>\n`
- Data lines: `data: <line>\n` (one per line of data)
- Blank line to terminate event
- Comments for heartbeats: `: heartbeat\n`

## Contributing

We welcome contributions! Please follow these guidelines:

1. **Fork the repository** and create your branch from `main`
2. **Make your changes** with clear, descriptive commits
3. **Add tests** for any new functionality
4. **Ensure tests pass**: `npm test`
5. **Follow code style**: TypeScript with ESM modules
6. **Update documentation** if needed
7. **Submit a pull request** with a clear description of changes

### Code Style

- TypeScript strict mode
- ESM modules (`import`/`export`)
- Descriptive variable names
- Comprehensive error handling
- Inline comments for complex logic

### Reporting Issues

Please open an issue on GitHub with:
- Clear description of the problem
- Steps to reproduce
- Expected vs actual behavior
- Environment details (Node version, OS, etc.)

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Support

For questions, issues, or feature requests, please open an issue on GitHub.

## Acknowledgments

Built with:
- [Node.js](https://nodejs.org/) - JavaScript runtime
- [Express](https://expressjs.com/) - Web framework
- [TypeScript](https://www.typescriptlang.org/) - Type safety
- [Jest](https://jestjs.io/) - Testing framework
