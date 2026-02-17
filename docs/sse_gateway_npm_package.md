# SSE Gateway — npm Package for Development Use

This document specifies the changes needed to make the SSE Gateway installable as an npm package via git URL, for use in local development and Playwright E2E testing.

**Production deployment is unchanged** — the Docker sidecar pattern continues to be used in production. This package is strictly for the development workflow.

## Background

The SSE Gateway is a Node.js/Express sidecar service (~1,300 lines, 11 source files) that manages Server-Sent Events connections between the Python backend and browser clients. It currently lives at `/work/SSEGateway/` as a standalone checkout.

The frontend template's Playwright test infrastructure (`tests/support/process/servers.ts`) starts the gateway as a child process per test worker. Currently it locates the gateway via the `SSE_GATEWAY_ROOT` environment variable or a `../ssegateway` relative path, then invokes `scripts/run-gateway.sh`.

The goal is to make the gateway available as an npm devDependency so that:
1. Frontend apps don't need a separate gateway checkout
2. The gateway version is pinned per-app via package.json
3. The test infrastructure finds the gateway in `node_modules/`

## Changes to the SSEGateway Repository

### 1. Add a `bin` entry to `package.json`

Create a CLI entry point so the gateway can be invoked directly:

```json
{
  "bin": {
    "ssegateway": "dist/index.js"
  }
}
```

Add a shebang line to `src/index.ts` (first line):

```typescript
#!/usr/bin/env node
```

This ensures it appears in `dist/index.js` after compilation and allows direct execution.

### 2. Add a `prepare` script

Add a build step that runs automatically when the package is installed from a git URL:

```json
{
  "scripts": {
    "prepare": "tsc"
  }
}
```

This ensures consumers get compiled output in `dist/` without needing to commit build artifacts. The `prepare` script runs after `npm install` / `pnpm install` for git-based dependencies.

**Note:** This requires TypeScript to be in `dependencies` (not just `devDependencies`) for git installs, or alternatively commit the `dist/` directory. Committing `dist/` is simpler and avoids the TypeScript-at-install-time dependency:

**Alternative (simpler):** Commit `dist/` to the repository and skip the `prepare` script. Add a pre-commit hook or CI step to ensure `dist/` stays in sync with `src/`. This avoids consumers needing `typescript` at install time.

**Recommendation:** Commit `dist/` for simplicity. The gateway changes rarely and it's only 11 files.

### 3. Add `"files"` to `package.json`

Limit what gets installed to only what's needed:

```json
{
  "files": [
    "dist/",
    "scripts/run-gateway.sh"
  ]
}
```

### 4. Tag a release

```bash
cd /work/SSEGateway
git tag v1.0.0
git push origin v1.0.0
```

### 5. Full `package.json` after changes

```json
{
  "name": "ssegateway",
  "version": "1.0.0",
  "description": "SSEGateway - Server-Sent Events sidecar service for Python backend",
  "type": "module",
  "main": "dist/index.js",
  "bin": {
    "ssegateway": "dist/index.js"
  },
  "files": [
    "dist/",
    "scripts/run-gateway.sh"
  ],
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js",
    "dev": "tsc && node dist/index.js",
    "test": "node --experimental-vm-modules node_modules/jest/bin/jest.js",
    "test:watch": "node --experimental-vm-modules node_modules/jest/bin/jest.js --watch",
    "test:coverage": "node --experimental-vm-modules node_modules/jest/bin/jest.js --coverage"
  },
  "engines": {
    "node": ">=20.0.0"
  },
  "dependencies": {
    "express": "^5.0.1"
  },
  "devDependencies": {
    "@types/express": "^5.0.0",
    "@types/jest": "^29.5.14",
    "@types/node": "^20.17.6",
    "@types/supertest": "^6.0.2",
    "jest": "^29.7.0",
    "supertest": "^7.0.0",
    "ts-jest": "^29.2.5",
    "typescript": "^5.7.2"
  }
}
```

## Changes to the Frontend Template

### 1. Add devDependency in `package.json.jinja`

Add to `devDependencies`, conditional on `use_sse`:

```json
{% if use_sse %}
"ssegateway": "git+https://<git-server>/SSEGateway.git#v1.0.0",
{% endif %}
```

Replace `<git-server>` with the actual git server URL (e.g., Gitblit instance).

### 2. Update `servers.ts`

In `template/tests/support/process/servers.ts`, replace the file-path-based gateway resolution with a `node_modules` lookup.

**Before:**
```typescript
const scriptPath = resolve(getSSEGatewayRepoRoot(), './scripts/run-gateway.sh');
const callbackUrl = `${options.backendUrl}/api/sse/callback`;
const args = ['--port', String(port), '--callback-url', callbackUrl];

return startService({
  workerIndex: options.workerIndex,
  port,
  serviceLabel: 'sse-gateway',
  scriptPath,
  args,
  readinessPath: GATEWAY_READY_PATH,
  startupTimeoutMs: GATEWAY_STARTUP_TIMEOUT_MS,
  streamLogs: options.streamLogs === true,
  env: { ...process.env },
});
```

**After:**
```typescript
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const gatewayEntry = require.resolve('ssegateway/dist/index.js');
const callbackUrl = `${options.backendUrl}/api/sse/callback`;

return startService({
  workerIndex: options.workerIndex,
  port,
  serviceLabel: 'sse-gateway',
  scriptPath: process.execPath,  // node binary
  args: [gatewayEntry],
  readinessPath: GATEWAY_READY_PATH,
  startupTimeoutMs: GATEWAY_STARTUP_TIMEOUT_MS,
  streamLogs: options.streamLogs === true,
  env: {
    ...process.env,
    PORT: String(port),
    CALLBACK_URL: callbackUrl,
  },
});
```

Key changes:
- **No more shell script** — spawns `node dist/index.js` directly
- **Config via environment variables** instead of CLI args (the gateway already reads `PORT` and `CALLBACK_URL` from env)
- **`createRequire` + `require.resolve`** finds the package in `node_modules/` regardless of monorepo layout or hoisting

### 3. Remove `getSSEGatewayRepoRoot()` and `sseGatewayRepoRootCache`

These are no longer needed since the gateway is found via `require.resolve`. Remove the dead code from `servers.ts`.

### 4. Remove `SSE_GATEWAY_ROOT` env var handling

This environment variable was the escape hatch for locating the gateway checkout. With npm dependency resolution, it's no longer needed. Remove references from:
- `servers.ts`
- `.env.example` (if present)
- `CLAUDE.md` (if mentioned)

## Verification

After making these changes:

1. **In the SSEGateway repo:**
   ```bash
   cd /work/SSEGateway
   npm run build          # Ensure dist/ is up to date
   npm pack --dry-run     # Verify only dist/ and scripts/ are included
   ```

2. **In the frontend template:**
   ```bash
   cd /work/ModernAppTemplate/frontend
   bash regen.sh          # Regenerate test-app with gateway as devDependency
   cd test-app
   ls node_modules/ssegateway/dist/index.js  # Verify it's installed
   node -e "const {createRequire}=require('module');const r=createRequire(require('url').pathToFileURL(__filename).href);console.log(r.resolve('ssegateway/dist/index.js'))"
   ```

3. **Run the Playwright tests** (once the mother project test suite exists) to verify the gateway starts correctly from `node_modules/`.

## Impact on Downstream Apps

Downstream apps that currently have the SSEGateway checked out alongside them will need to:

1. Add `"ssegateway": "git+https://<git-server>/SSEGateway.git#v1.0.0"` to their `devDependencies`
2. Run `pnpm install`
3. The next `copier update` will bring in the updated `servers.ts` that uses the npm package

The separate SSEGateway checkout can then be removed from their development environment.
