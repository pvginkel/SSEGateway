# Change Brief: Structured Error Responses

## Objective

Refactor all error responses in the codebase to use a structured format with `message` and `code` fields.

## Current State

Error responses currently use a simple flat structure:
```json
{ "error": "Token not found" }
```

## Desired State

Error responses should use a nested structure with semantic error codes:
```json
{
  "error": {
    "message": "Token not found",
    "code": "TOKEN_NOT_FOUND"
  }
}
```

## Scope

Find and refactor all error responses across:
- `src/routes/internal.ts` - Multiple validation errors, token not found, write failures
- `src/routes/sse.ts` - Service not configured, backend errors

Health check endpoints (`src/routes/health.ts`) return success responses, not errors, so they are excluded.

## Requirements

1. All error responses must follow the new structure
2. Error codes should be:
   - UPPER_SNAKE_CASE format
   - Descriptive and semantic
   - Consistent with the error message
3. HTTP status codes remain unchanged
4. Error messages should remain clear and descriptive
