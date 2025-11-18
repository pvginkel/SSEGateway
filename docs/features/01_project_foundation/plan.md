# Implementation Plan: Project Foundation

## 0) Research Log & Findings

### Discovery Work

I examined the repository structure and found:
- Empty directory skeleton exists: `src/`, `__tests__/`, `docs/`
- Subdirectories present: `src/routes/`, `src/utils/`, `__tests__/integration/`, `__tests__/utils/`
- No configuration files yet (no package.json, tsconfig.json, or jest config)
- Project is a fresh start requiring complete foundation setup
- Git repository already initialized

### Key Documentation References

- `/work/CLAUDE.md`: Defines SSEGateway as a Node.js 20 + TypeScript 5 + Express 5 service with ESM modules
- `/work/docs/product_brief.md`: Complete specification including SSE endpoints, health checks, and callback contracts
- Change brief requires: package.json with ESM, TypeScript config, Express server, environment variables, health endpoints, logging, and testing framework

### Findings & Decisions

1. **Module System**: Must use ESM (`"type": "module"` in package.json) with TypeScript configured for `"NodeNext"` - this is non-negotiable per CLAUDE.md
2. **Testing Framework**: Jest is the standard choice for Node.js testing; requires ESM-compatible configuration
3. **Express Version**: Express 5 specified in CLAUDE.md (currently in beta, using 5.0.1)
4. **Logging**: Simple console-based logging with `[INFO]` and `[ERROR]` prefixes - no external libraries needed
5. **Port Configuration**: Not specified in change brief; will default to 3000 with PORT environment variable override
6. **Directory Structure**: Follows CLAUDE.md guidance - config.ts, server.ts in src/, with routes/ and utils/ subdirectories already created

---

## 1) Intent & Scope

**User intent**

Establish the minimal viable Node.js + TypeScript + Express foundation for SSEGateway that supports ESM modules, basic configuration loading, health check endpoints, and testing infrastructure. This is the first deliverable before implementing SSE connection handling.

**Prompt quotes**

- "Set up the SSEGateway project foundation with TypeScript, Node.js 20, and Express 5 using ESM modules"
- "Configure package.json with Node 20 ESM support (`"type": "module"`)"
- "Configure TypeScript 5.x with `"module": "NodeNext"` for ESM compatibility"
- "Implement basic logging infrastructure using plain text format: `[INFO]` and `[ERROR]` prefixes"
- "Set up testing framework with at least one sample test to verify the configuration works"

**In scope**

- Create package.json with ESM configuration and all required dependencies
- Create tsconfig.json with NodeNext module resolution
- Implement configuration loader for CALLBACK_URL and HEARTBEAT_INTERVAL_SECONDS
- Create Express 5 server with startup logic
- Implement GET /healthz endpoint (always 200)
- Implement GET /readyz endpoint (200 when configured, 503 otherwise)
- Create simple logging utility with [INFO] and [ERROR] prefixes
- Set up Jest with ESM support
- Create one sample test verifying health endpoint behavior
- Create basic npm scripts for build, test, and dev

**Out of scope**

- SSE connection handling (future feature)
- POST /internal/send endpoint (future feature)
- Python callback implementation (future feature)
- Heartbeat timers (future feature)
- Connection state management (future feature)
- Docker or Kubernetes configuration
- CI/CD pipeline configuration
- Production deployment scripts

**Assumptions / constraints**

- Node.js 20 LTS is available in the deployment environment
- npm is the package manager (not yarn or pnpm)
- Development occurs on Linux or macOS with standard POSIX shell
- The server runs as a single process (no clustering)
- Environment variables are provided externally (no .env file handling required)
- Health endpoints have no authentication requirements

---

## 2) Affected Areas & File Map

### New Files to Create

- **Area**: `package.json`
  - **Why**: Define project metadata, dependencies (Express 5, TypeScript 5), scripts, and ESM configuration
  - **Evidence**: CLAUDE.md:53-54 requires `"type": "module"` in package.json; product_brief.md:42-45 requires Node 20 and Express 5

- **Area**: `tsconfig.json`
  - **Why**: Configure TypeScript compiler with NodeNext module system for ESM compatibility, specify output directory for compiled JavaScript
  - **Evidence**: CLAUDE.md:54 requires `"module": "NodeNext"` and `"moduleResolution": "NodeNext"`; product_brief.md:49-54 mandates TypeScript 5.x with ESM; standard practice requires `outDir: "./dist"` and `rootDir: "./src"` to separate source from compiled output

- **Area**: `src/config.ts`
  - **Why**: Load and validate environment variables (CALLBACK_URL, HEARTBEAT_INTERVAL_SECONDS, PORT)
  - **Evidence**: product_brief.md:383-389 defines required CALLBACK_URL and optional HEARTBEAT_INTERVAL_SECONDS with default 15; change_brief.md:12-14 requires environment variable configuration system

- **Area**: `src/logger.ts`
  - **Why**: Provide consistent logging functions with [INFO] and [ERROR] prefixes
  - **Evidence**: product_brief.md:362-378 specifies plain text logging with severity prefixes; CLAUDE.md:147-155 lists required log events; change_brief.md:18 requires basic logging infrastructure

- **Area**: `src/routes/health.ts`
  - **Why**: Implement /healthz and /readyz endpoints with correct status code logic
  - **Evidence**: product_brief.md:204-224 defines health endpoint contracts; change_brief.md:15-17 requires both endpoints with specific 200/503 behavior

- **Area**: `src/server.ts`
  - **Why**: Create Express 5 application, register routes, start HTTP server
  - **Evidence**: CLAUDE.md:45 requires Express 5 framework; product_brief.md:42-61 defines Express as the framework choice; change_brief.md:11 requires Express 5 server that listens on configurable port

- **Area**: `src/index.ts`
  - **Why**: Entry point that loads config, initializes logger, and starts server
  - **Evidence**: Standard Node.js project pattern; change_brief.md:27 requires server to log startup information including port and environment configuration

- **Area**: `jest.config.js`
  - **Why**: Configure Jest for ESM compatibility with TypeScript using ts-jest with ESM preset
  - **Evidence**: change_brief.md:19 requires testing framework setup; ESM requires special Jest configuration with `preset: 'ts-jest/presets/default-esm'`, `extensionsToTreatAsEsm: ['.ts']`, and `transform` configured for TypeScript ESM support

- **Area**: `__tests__/integration/health.test.ts`
  - **Why**: Sample test verifying health endpoint responses
  - **Evidence**: change_brief.md:19 requires "at least one sample test to verify the configuration works"; change_brief.md:27 success criteria includes "At least one test passes"

- **Area**: `.gitignore`
  - **Why**: Exclude node_modules, build artifacts (dist/ directory), and IDE files from version control
  - **Evidence**: Standard Node.js project requirement; directories like node_modules/ and coverage/ already exist; TypeScript compilation outputs to dist/ directory

---

## 3) Data Model / Contracts

### Config Schema

- **Entity / contract**: Application configuration loaded from environment variables
- **Shape**:
  ```typescript
  interface Config {
    port: number;              // Default 3000, from PORT env var
    callbackUrl: string | null; // Required for readiness, from CALLBACK_URL
    heartbeatIntervalSeconds: number; // Default 15, from HEARTBEAT_INTERVAL_SECONDS
  }
  ```
- **Refactor strategy**: This is the initial implementation; no backward compatibility concerns. Future changes will add fields without removing existing ones.
- **Evidence**: product_brief.md:383-389 (configuration table); CLAUDE.md:92-96 (config section); change_brief.md:12-14 (environment variables requirement)

### Health Endpoint Responses

- **Entity / contract**: GET /healthz response
- **Shape**:
  ```json
  {
    "status": "ok"
  }
  ```
  HTTP Status: 200 (always, unless fatal error)
- **Refactor strategy**: Simple contract unlikely to change; if expanded, add optional fields for diagnostics
- **Evidence**: product_brief.md:206-212 defines /healthz as "Always 200 unless server is in fatal state"

- **Entity / contract**: GET /readyz response
- **Shape**:
  ```json
  {
    "status": "ready",
    "configured": true
  }
  ```
  HTTP Status: 200 when ready, 503 when not configured
- **Refactor strategy**: Add optional fields for readiness checks without breaking clients that only check status code
- **Evidence**: product_brief.md:214-224 defines /readyz returning 200 when CALLBACK_URL configured and server initialized, otherwise 503; change_brief.md:17 specifies same logic

### Log Message Format

- **Entity / contract**: Log output format
- **Shape**:
  ```
  [INFO] Server starting on port 3000
  [ERROR] Failed to bind to port: EADDRINUSE
  ```
  Plain text with severity prefix, single line per message
- **Refactor strategy**: Format is fixed per specification; no changes planned
- **Evidence**: product_brief.md:362-378 shows exact format `[INFO] message` and `[ERROR] message`; CLAUDE.md:147 confirms "Plain text with severity prefix"

---

## 4) API / Integration Surface

### GET /healthz

- **Surface**: HTTP GET /healthz
- **Inputs**: None
- **Outputs**:
  - Status: 200 OK
  - Body: `{"status": "ok"}`
  - Headers: `Content-Type: application/json`
- **Errors**: None expected in foundation phase (always returns 200)
- **Evidence**: product_brief.md:206-212; change_brief.md:16 requires "/healthz - Always returns 200 unless server is in fatal state"

### GET /readyz

- **Surface**: HTTP GET /readyz
- **Inputs**: None
- **Outputs**:
  - When ready (CALLBACK_URL configured):
    - Status: 200 OK
    - Body: `{"status": "ready", "configured": true}`
  - When not ready:
    - Status: 503 Service Unavailable
    - Body: `{"status": "not_ready", "configured": false}`
  - Headers: `Content-Type: application/json`
- **Errors**: No error states beyond the 503 not-ready response
- **Evidence**: product_brief.md:214-224; change_brief.md:17 requires "200 when CALLBACK_URL is configured and server is initialized, otherwise 503"

---

## 5) Algorithms & State Machines

### Server Startup Flow

- **Flow**: Application initialization and HTTP server binding
- **Steps**:
  1. Load configuration from environment variables (CALLBACK_URL, HEARTBEAT_INTERVAL_SECONDS, PORT)
  2. Validate PORT is numeric and in range 1-65535; exit with error if invalid
  3. Validate HEARTBEAT_INTERVAL_SECONDS is integer >= 1 if provided; use default 15 if invalid
  4. Initialize logger (no state, just functions)
  5. Create Express application instance
  6. Register health check routes (/healthz, /readyz)
  7. Ensure compression middleware is NOT registered (verified by not including compression package in dependencies)
  8. Start HTTP server on configured port
  9. Log startup message with port and configuration summary
  10. Set up graceful shutdown handlers (SIGTERM, SIGINT)
- **States / transitions**: No explicit state machine; server transitions from "starting" to "listening" to "shutting down"
- **Hotspots**: Port binding can fail if port is already in use (EADDRINUSE) or if PORT is invalid; Express 5 is beta so may have unexpected behavior
- **Evidence**: change_brief.md:11-12, 27-28 requires configurable port server that logs startup; product_brief.md:62-67 defines single process model; CLAUDE.md:22 requires "No Compression" as non-negotiable

### Readiness Check Logic

- **Flow**: Determine if server is ready to accept traffic
- **Steps**:
  1. Check if CALLBACK_URL environment variable is set and non-empty
  2. Check if server has completed initialization (listening on port)
  3. If both true: return 200 with ready status
  4. Otherwise: return 503 with not-ready status
- **States / transitions**: Binary state - ready or not ready
- **Hotspots**: None (simple boolean logic)
- **Evidence**: product_brief.md:214-224; change_brief.md:17

---

## 6) Derived State & Invariants

### Server Listening State

- **Derived value**: Whether HTTP server is bound to port
- **Source**: Result of `server.listen()` callback or error event
- **Writes / cleanup**: No persistent writes; only affects readiness endpoint response
- **Guards**: Port number must be valid (1-65535), not in use by another process
- **Invariant**: If server.listening === true, then readiness check passes (assuming CALLBACK_URL configured)
- **Evidence**: Node.js http.Server API; change_brief.md:23-24 requires server starts successfully

### Configuration Validity

- **Derived value**: Whether required configuration is present
- **Source**: Environment variables at startup (process.env.CALLBACK_URL)
- **Writes / cleanup**: No writes; stored in memory as Config object
- **Guards**: CALLBACK_URL presence checked before marking ready; HEARTBEAT_INTERVAL_SECONDS validated as positive number
- **Invariant**: If readyz returns 200, then CALLBACK_URL is non-null and server is listening
- **Evidence**: change_brief.md:12-14, 17; product_brief.md:383-389

### Heartbeat Interval Default

- **Derived value**: Effective heartbeat interval to use
- **Source**: HEARTBEAT_INTERVAL_SECONDS environment variable with fallback to 15
- **Writes / cleanup**: No immediate use in foundation; stored for future SSE implementation
- **Guards**: Must be integer >= 1; values <= 0, non-integer, or non-numeric log warning and default to 15
- **Invariant**: heartbeatIntervalSeconds >= 1 (minimum one second; zero or negative are invalid)
- **Evidence**: product_brief.md:258-266 defines default as 15 seconds; CLAUDE.md:95 confirms default

---

## 7) Consistency, Transactions & Concurrency

### Transaction scope

No database or transaction management in foundation phase. All operations are in-memory and synchronous or single-callback async.

### Atomic requirements

- Server startup is atomic: either the server successfully binds to port and begins accepting requests, or startup fails and process exits
- Configuration loading is atomic: all environment variables read in single synchronous operation at startup

### Retry / idempotency

- No retry logic needed in foundation phase
- Server startup failures should cause process exit (fail-fast)
- Health endpoints are idempotent GET requests

### Ordering / concurrency controls

- Single-threaded Node.js event loop ensures sequential request handling
- No explicit locks or concurrency controls needed
- Express 5 handles concurrent HTTP requests naturally via event loop

### Evidence

CLAUDE.md:61-67 specifies "Single process, single-threaded" with "In-memory state only"; product_brief.md:62-68 confirms "Single Node process" with "Single-threaded event loop"

---

## 8) Errors & Edge Cases

### Port Already in Use

- **Failure**: Another process is bound to the configured port
- **Surface**: Server startup in src/index.ts
- **Handling**: Log error with [ERROR] prefix, include port number and error code (EADDRINUSE), exit process with code 1
- **Guardrails**: No prevention possible; operational concern resolved by port management; log clearly for debugging
- **Evidence**: Standard Node.js http.Server error; change_brief.md:27 requires startup success

### Invalid PORT Value

- **Failure**: PORT environment variable is non-numeric, zero, negative, or > 65535
- **Surface**: Configuration loading in src/config.ts
- **Handling**: Log error with [ERROR] prefix showing invalid value and valid range (1-65535), exit process with code 1
- **Guardrails**: Parse with Number(), validate value is integer in range 1-65535 before attempting server startup
- **Evidence**: Standard TCP port range; fail-fast principle prevents confusing runtime errors

### Invalid HEARTBEAT_INTERVAL_SECONDS

- **Failure**: Environment variable is non-numeric or negative
- **Surface**: Configuration loading in src/config.ts
- **Handling**: Log warning with [ERROR] prefix, fall back to default value of 15 seconds, continue startup
- **Guardrails**: Parse with Number(), check isNaN() and value > 0; documented default behavior prevents hard failure
- **Evidence**: product_brief.md:389 shows default value; defensive programming practice

### Missing CALLBACK_URL

- **Failure**: CALLBACK_URL environment variable not set
- **Surface**: GET /readyz endpoint in src/routes/health.ts
- **Handling**: Return 503 status with {"status": "not_ready", "configured": false}; server continues running
- **Guardrails**: /readyz exists specifically to signal this non-ready state; Kubernetes will not route traffic until ready
- **Evidence**: product_brief.md:219-224 explicitly handles this case; change_brief.md:17 requires 503 when not configured

### Express 5 Beta Instability

- **Failure**: Express 5 (beta) has undiscovered bugs or breaking changes
- **Surface**: Any Express usage in src/server.ts or routes
- **Handling**: Pin exact version in package.json, monitor for updates, be prepared to report issues upstream
- **Guardrails**: Use stable, documented Express APIs only; comprehensive testing
- **Evidence**: product_brief.md:56-60 requires Express 5; known to be beta release

---

## 9) Observability / Telemetry

### Server Startup Log

- **Signal**: `[INFO] Server starting on port 3000`
- **Type**: Structured log (plain text with severity prefix)
- **Trigger**: When server.listen() callback fires successfully
- **Labels / fields**: Port number, configuration summary (CALLBACK_URL presence, heartbeat interval)
- **Consumer**: Deployment logs, startup verification scripts
- **Evidence**: change_brief.md:28 requires "Server logs startup information including port and environment configuration"; CLAUDE.md:148 lists "Server startup (port, environment config)"

### Configuration Load Log

- **Signal**: `[INFO] Configuration loaded: callbackUrl=https://backend/callback heartbeatInterval=15s`
- **Type**: Structured log
- **Trigger**: After environment variables are parsed in src/config.ts
- **Labels / fields**: Presence of CALLBACK_URL (masked URL), heartbeat interval value
- **Consumer**: Debugging configuration issues, startup verification
- **Evidence**: change_brief.md:28; CLAUDE.md:148

### Health Check Requests

- **Signal**: No logging for health checks (too noisy)
- **Type**: N/A
- **Trigger**: N/A
- **Labels / fields**: N/A
- **Consumer**: N/A
- **Evidence**: Common practice to avoid flooding logs; health checks are frequent

### Startup Errors

- **Signal**: `[ERROR] Failed to start server: EADDRINUSE port=3000`
- **Type**: Structured log with error details
- **Trigger**: When server.listen() fails or process encounters fatal error
- **Labels / fields**: Error code, error message, relevant context (port, config)
- **Consumer**: Operational alerts, debugging deployment failures
- **Evidence**: CLAUDE.md:155 requires "All errors" be logged; change_brief.md:18 requires [ERROR] prefix

---

## 10) Background Work & Shutdown

### HTTP Server Listener

- **Worker / job**: Express HTTP server event loop
- **Trigger cadence**: Startup-only (server.listen()), then runs continuously
- **Responsibilities**: Accept TCP connections, route to Express handlers, maintain keep-alive connections
- **Shutdown handling**:
  - Listen for SIGTERM and SIGINT signals
  - Call server.close() to stop accepting new connections
  - Wait for existing requests to complete (with timeout)
  - Exit process with code 0
- **Evidence**: Standard Node.js server lifecycle; change_brief.md:23 requires "Server starts successfully and listens on configured port"

### Graceful Shutdown Flow

- **Worker / job**: Signal handlers for SIGTERM / SIGINT
- **Trigger cadence**: Event-driven (on process signal)
- **Responsibilities**:
  1. Log shutdown initiation
  2. Stop accepting new requests (server.close())
  3. Allow in-flight requests to complete (with 10s timeout)
  4. Log shutdown complete
  5. Exit process
- **Shutdown handling**: This is the shutdown handler itself
- **Evidence**: Production best practice; CLAUDE.md:118 mentions "shutdown coordination" in context of observability

---

## 11) Security & Permissions

Not applicable for project foundation phase. The change brief explicitly states health endpoints have no authentication requirements. Security will be handled by NGINX and Python backend per CLAUDE.md.

**Evidence**: CLAUDE.md:94-100 states "No authentication/authorization - Python and NGINX handle this"; product_brief.md:347-356 confirms "No authentication, No authorization"

---

## 12) UX / UI Impact

Not applicable - this is a backend service with no user interface. The only "users" are:
- Kubernetes readiness probes (interacting with /healthz and /readyz)
- Developers running tests and viewing logs

---

## 13) Deterministic Test Plan

### Surface: GET /healthz endpoint

- **Scenarios**:
  - Given server is running, When GET /healthz is requested, Then return 200 status with {"status": "ok"}
  - Given server just started, When GET /healthz is requested multiple times, Then always return 200 status
  - Given server is running, When GET /healthz is requested, Then response headers must not include Content-Encoding (verifies no compression)
- **Fixtures / hooks**: Supertest library for HTTP testing, test server instance created before each test
- **Gaps**: Not testing fatal error states (out of scope for foundation)
- **Evidence**: change_brief.md:19, 27 requires at least one passing test; product_brief.md:206-212; CLAUDE.md:22 requires "No Compression"

### Surface: GET /readyz endpoint

- **Scenarios**:
  - Given CALLBACK_URL is set, When GET /readyz is requested, Then return 200 status with {"status": "ready", "configured": true}
  - Given CALLBACK_URL is not set, When GET /readyz is requested, Then return 503 status with {"status": "not_ready", "configured": false}
  - Given server has not finished initializing, When GET /readyz is requested, Then return 503 status
- **Fixtures / hooks**: Mock process.env for testing different configurations, test server lifecycle management
- **Gaps**: None for foundation phase
- **Evidence**: change_brief.md:16-17; product_brief.md:214-224

### Surface: Configuration loading (src/config.ts)

- **Scenarios**:
  - Given CALLBACK_URL env var is set, When config loads, Then config.callbackUrl equals the env var value
  - Given CALLBACK_URL is missing, When config loads, Then config.callbackUrl is null
  - Given HEARTBEAT_INTERVAL_SECONDS is "30", When config loads, Then config.heartbeatIntervalSeconds equals 30
  - Given HEARTBEAT_INTERVAL_SECONDS is invalid, When config loads, Then config.heartbeatIntervalSeconds equals 15 (default)
  - Given HEARTBEAT_INTERVAL_SECONDS is "0", When config loads, Then logs error and defaults to 15
  - Given PORT is "8080", When config loads, Then config.port equals 8080
  - Given PORT is "abc", When config loads, Then throws error or exits with message about valid range
  - Given PORT is "0", When config loads, Then throws error (0 is not a valid port)
  - Given PORT is "99999", When config loads, Then throws error (exceeds 65535 max)
- **Fixtures / hooks**: Mock process.env, restore original env after each test
- **Gaps**: None for foundation phase
- **Evidence**: change_brief.md:12-14, 24 requires environment variables properly loaded; TCP port range validation required

### Surface: Logger utility (src/logger.ts)

- **Scenarios**:
  - Given logger.info() is called with "test message", When output is captured, Then output contains "[INFO] test message"
  - Given logger.error() is called with "error message", When output is captured, Then output contains "[ERROR] error message"
- **Fixtures / hooks**: Mock console.log to capture output, restore after test
- **Gaps**: Not testing log formatting edge cases (very long messages, special characters) - acceptable for foundation
- **Evidence**: change_brief.md:18; product_brief.md:362-370

### Surface: Server startup sequence (src/index.ts)

- **Scenarios**:
  - Given valid configuration, When server starts, Then logs startup message with port and config summary
  - Given valid configuration, When server starts, Then server.listening equals true
  - Given valid configuration, When server starts, Then health endpoints are accessible
- **Fixtures / hooks**: Capture log output, test server lifecycle
- **Gaps**: Not testing all possible startup failure modes (out of scope for foundation)
- **Evidence**: change_brief.md:23, 27 requires "Server starts successfully" and "logs startup information"

### Surface: Graceful shutdown (src/index.ts)

- **Scenarios**:
  - Given server is running, When SIGTERM signal received, Then logs shutdown initiation
  - Given server is running, When SIGINT signal received, Then calls server.close() to stop accepting connections
  - Given server is running with in-flight request, When shutdown initiated, Then waits for request completion (or timeout)
  - Given server shutdown complete, When process exits, Then logs shutdown complete message
- **Fixtures / hooks**: Mock process signals, mock server.close(), capture logs
- **Gaps**: Not testing timeout behavior with long-running requests (acceptable for foundation)
- **Evidence**: Production best practice for graceful shutdown; plan Section 10 describes shutdown flow (lines 394-406)

---

## 14) Implementation Slices

### Slice 1: Dependencies and Configuration

- **Goal**: Establish package.json, tsconfig.json, and build toolchain
- **Touches**:
  - `package.json` (create with dependencies and scripts)
  - `tsconfig.json` (create with ESM configuration)
  - `.gitignore` (create with standard Node.js exclusions)
- **Dependencies**: None; this is the foundation

### Slice 2: Configuration and Logging

- **Goal**: Load environment variables and provide logging utilities
- **Touches**:
  - `src/config.ts` (create with environment variable loading)
  - `src/logger.ts` (create with [INFO] and [ERROR] functions)
- **Dependencies**: Slice 1 must be complete (TypeScript must compile)

### Slice 3: Health Endpoints

- **Goal**: Implement /healthz and /readyz routes
- **Touches**:
  - `src/routes/health.ts` (create with both endpoints)
- **Dependencies**: Slice 2 (needs config to check CALLBACK_URL for readyz)

### Slice 4: Express Server

- **Goal**: Create Express app and HTTP server
- **Touches**:
  - `src/server.ts` (create Express app, register routes)
  - `src/index.ts` (entry point with startup logic)
- **Dependencies**: Slices 2 and 3 (needs config, logger, and health routes)

### Slice 5: Testing Infrastructure

- **Goal**: Set up Jest and write sample tests
- **Touches**:
  - `jest.config.js` (create with ESM support)
  - `__tests__/integration/health.test.ts` (create with health endpoint tests)
- **Dependencies**: Slice 4 (needs working server to test against)

---

## 15) Risks & Open Questions

### Risk: Express 5 Beta Instability

- **Impact**: Medium - could cause runtime failures or require workarounds
- **Mitigation**: Pin exact version (5.0.1), use minimal feature set, prepare to downgrade to Express 4 if critical bugs found

### Risk: Jest ESM Configuration Complexity

- **Impact**: Low - tests may not run initially
- **Mitigation**: Use established patterns (ts-jest with ESM preset), test early in implementation

### Risk: TypeScript NodeNext Module Resolution Issues

- **Impact**: Medium - import statements may fail or require .js extensions
- **Mitigation**: Follow official TypeScript ESM guidelines, use explicit .js extensions in imports, test compilation early

### Risk: Missing Environment Variables in Production

- **Impact**: High - server will start but not be ready (503 on /readyz)
- **Mitigation**: Clear documentation of required env vars, readyz endpoint signals problem, fail-fast validation in future iterations

### Open Question: Should PORT environment variable be required or optional?

- **Why it matters**: Affects validation logic and error handling in config.ts
- **Owner / follow-up**: Using default port 3000 with optional PORT override is standard practice; proceeding with this approach

---

## 16) Confidence

Confidence: High - This is a straightforward foundation setup using well-established technologies (Node.js, TypeScript, Express, Jest) with clear requirements and no complex dependencies. The ESM configuration adds slight complexity but is well-documented in TypeScript and Node.js ecosystems.
