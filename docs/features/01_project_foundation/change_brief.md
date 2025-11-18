# Change Brief: Project Foundation

## Description

Set up the SSEGateway project foundation with TypeScript, Node.js 20, and Express 5 using ESM modules.

## Functional Requirements

- Configure package.json with Node 20 ESM support (`"type": "module"`)
- Configure TypeScript 5.x with `"module": "NodeNext"` for ESM compatibility
- Set up Express 5 server that listens on a configurable port
- Implement environment variable configuration system for:
  - `CALLBACK_URL` (required)
  - `HEARTBEAT_INTERVAL_SECONDS` (optional, default: 15)
- Implement two health check endpoints:
  - `GET /healthz` - Always returns 200 unless server is in fatal state
  - `GET /readyz` - Returns 200 when CALLBACK_URL is configured and server is initialized, otherwise 503
- Implement basic logging infrastructure using plain text format: `[INFO]` and `[ERROR]` prefixes
- Set up testing framework with at least one sample test to verify the configuration works

## Success Criteria

- Server starts successfully and listens on configured port
- Health endpoints respond correctly
- Environment variables are properly loaded
- TypeScript compiles without errors
- At least one test passes
- Server logs startup information including port and environment configuration
