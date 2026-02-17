# SSE Gateway — npm Package Usage

This document describes how to consume the SSE Gateway as an npm package for local development and Playwright test execution.

**Production deployment is unchanged** — the Docker sidecar pattern continues to be used in production.

## Installing

Add to your project's `devDependencies` using the `stable` branch:

```bash
# npm
npm install --save-dev git+https://<git-server>/SSEGateway.git#stable

# pnpm
pnpm add -D git+https://<git-server>/SSEGateway.git#stable
```

Or add manually to `package.json`:

```json
{
  "devDependencies": {
    "ssegateway": "git+https://<git-server>/SSEGateway.git#stable"
  }
}
```

Replace `<git-server>` with your Gitblit instance URL.

### What happens at install time

When installed from a git URL, npm/pnpm clones the repository and runs the `prepare` script, which compiles TypeScript to `dist/`. This is why `typescript`, `@types/express`, and `@types/node` are in `dependencies` rather than `devDependencies` — they must be available during the install-time build step. The `dist/` directory is not committed to the repository.

## Resolving the entry point

The package exports its entry point via the `exports` field in `package.json`. Use `createRequire` to resolve it from an ESM context:

```typescript
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const gatewayEntry = require.resolve('ssegateway');
```

This works regardless of monorepo layout or hoisting strategy.

## Starting the gateway in tests

Spawn the gateway as a child process using `node` directly. Configuration is passed via environment variables (`PORT` and `CALLBACK_URL`), which the gateway already reads natively.

```typescript
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const gatewayEntry = require.resolve('ssegateway');
const callbackUrl = `${options.backendUrl}/api/sse/callback`;

return startService({
  workerIndex: options.workerIndex,
  port,
  serviceLabel: 'sse-gateway',
  scriptPath: process.execPath,  // node binary
  args: [gatewayEntry],
  readinessPath: '/readyz',
  startupTimeoutMs: 5000,
  streamLogs: options.streamLogs === true,
  env: {
    ...process.env,
    PORT: String(port),
    CALLBACK_URL: callbackUrl,
  },
});
```

### Key points

- **No shell script** — spawns `node dist/index.js` directly.
- **Config via environment variables** — the gateway reads `PORT` and `CALLBACK_URL` from the environment natively. No CLI argument parsing needed.
- **`createRequire` + `require.resolve`** — finds the package in `node_modules/` regardless of monorepo layout or hoisting.
- **No `bin` entry** — the package does not install a CLI command. Consumers spawn `node` with the resolved entry point path.

## Design decisions

| Decision | Rationale |
|----------|-----------|
| No committed `dist/` | Cleaner git history. The `prepare` script compiles at install time instead. |
| Build deps in `dependencies` | `typescript`, `@types/express`, and `@types/node` must be available when `prepare` runs during git-based installs. |
| `stable` branch, not version tags | The gateway changes rarely. Consumers track the `stable` branch. To update, re-run `npm install` / `pnpm install`. |
| No `bin` entry | Consumers spawn `node` directly with the resolved path. No need for a CLI wrapper or shebang. |
| `exports` field | Provides a clean public API (`require.resolve('ssegateway')`) instead of requiring deep path resolution into `dist/`. |
| Shell script not included | `scripts/run-gateway.sh` remains in the repo for standalone development but is not shipped in the package. Consuming apps provide their own startup wrapper if needed. |

## Updating the gateway

Since consumers track the `stable` branch, updating is straightforward:

```bash
# Re-install to pick up latest from stable branch
npm install
# or
pnpm install
```

If you need to pin to a specific commit:

```json
{
  "devDependencies": {
    "ssegateway": "git+https://<git-server>/SSEGateway.git#<commit-sha>"
  }
}
```

## Verifying the installation

```bash
# Check the entry point resolves correctly
node -e "import { createRequire } from 'node:module'; const r = createRequire(import.meta.url); console.log(r.resolve('ssegateway'));" --input-type=module

# Check the gateway starts (will fail without CALLBACK_URL, but proves the binary works)
node node_modules/ssegateway/dist/index.js
```
