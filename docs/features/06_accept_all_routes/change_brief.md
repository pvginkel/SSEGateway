# Change Brief: Accept All Routes for SSE Connections

## Current Behavior

The SSE connection endpoint currently only accepts routes under `/sse/`:

```typescript
// src/routes/sse.ts:46
router.get(/^\/sse\/.*/, async (req: Request, res: Response) => {
```

This means:
- ✅ Accepts: `GET /sse/channel/updates`
- ✅ Accepts: `GET /sse/notifications`
- ❌ Rejects: `GET /events/stream`
- ❌ Rejects: `GET /stream`
- ❌ Rejects: `GET /api/v1/updates`

## Desired Behavior

Accept SSE connections on **any route**, not just those under `/sse/`:

```typescript
router.get(/^\/.*/, async (req: Request, res: Response) => {
```

This means:
- ✅ Accepts: `GET /sse/channel/updates`
- ✅ Accepts: `GET /events/stream`
- ✅ Accepts: `GET /stream`
- ✅ Accepts: `GET /api/v1/updates`
- ✅ Accepts: Any GET request path

## Rationale

SSEGateway is a sidecar service that terminates SSE connections. The Python backend should control which routes are valid (via connect callback authorization), not the gateway itself. The gateway's role is to:
1. Accept the connection attempt
2. Forward route/headers to Python for authorization
3. Python callback returns 2xx (allow) or non-2xx (reject)

Restricting routes to `/sse/*` at the gateway level:
- Couples gateway to specific URL patterns
- Prevents flexible backend route design
- Forces all SSE endpoints to share `/sse/` prefix

## Functional Requirement

Change the SSE endpoint route pattern from `/^\/sse\/.*/` to `/^\/.*` /` to accept connections on any path.

## Success Criteria

- SSE endpoint accepts GET requests on any route
- Connect callback still receives full raw URL
- Python backend still controls authorization via callback response
- All existing tests continue to pass
- Tests using `/sse/*` paths still work
- New test added verifying non-`/sse/` path works (e.g., `GET /events/stream`)
- The product brief in `docs/product_brief.md` is also updated, including any other mentions of the `/sse/` route

## Technical Details

**File to modify**: `src/routes/sse.ts`

**Change**:
```typescript
// Line 35: Update comment
- * GET /sse/* - SSE connection endpoint (accepts any path under /sse/)
+ * GET /* - SSE connection endpoint (accepts any path)

// Line 46: Update regex pattern
- router.get(/^\/sse\/.*/, async (req: Request, res: Response) => {
+ router.get(/^\/.*/, async (req: Request, res: Response) => {
```

**Verification**:
- Existing tests using `/sse/test`, `/sse/channel`, etc. continue to work
- Add test for `GET /stream` or `GET /events` to verify non-`/sse/` routes accepted
- Full URL still forwarded to Python callback unchanged

## Scope

**In Scope:**
- Change route pattern regex
- Update comment documentation
- Add test for non-`/sse/` route acceptance

**Out of Scope:**
- Changing how URLs are forwarded to Python (already raw)
- Adding route filtering/validation (Python's responsibility)
- Modifying callback contract
- Changing any other endpoints (`/internal/*`, `/healthz`, etc.)

## Context

- This aligns with `CLAUDE.md` principle: "Accept ANY path under /sse/ without parsing"
- Update: Should be "Accept ANY path without parsing"
- Gateway remains authorization-agnostic (Python decides via callback)
- Full URL with query string already forwarded verbatim
