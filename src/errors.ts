/**
 * Error response definitions and utilities
 *
 * Provides structured error response format with semantic error codes
 * for consistent error handling across all API endpoints.
 */

import type { Response } from 'express';

/**
 * Structured error response format
 *
 * All error responses follow this nested structure with both
 * a human-readable message and a semantic error code.
 */
export interface ErrorResponse {
  error: {
    message: string;
    code: string;
  };
}

/**
 * Error codes for /internal/send endpoint validation errors
 */
export const INVALID_TOKEN_MISSING = 'INVALID_TOKEN_MISSING';
export const INVALID_EVENT_TYPE = 'INVALID_EVENT_TYPE';
export const INVALID_EVENT_DATA_MISSING = 'INVALID_EVENT_DATA_MISSING';
export const INVALID_EVENT_NAME_TYPE = 'INVALID_EVENT_NAME_TYPE';
export const INVALID_CLOSE_TYPE = 'INVALID_CLOSE_TYPE';

/**
 * Error codes for /internal/send resource errors
 */
export const TOKEN_NOT_FOUND = 'TOKEN_NOT_FOUND';
export const WRITE_FAILED = 'WRITE_FAILED';

/**
 * Error codes for SSE connection errors
 */
export const SERVICE_NOT_CONFIGURED = 'SERVICE_NOT_CONFIGURED';
export const BACKEND_AUTH_FAILED = 'BACKEND_AUTH_FAILED';
export const BACKEND_FORBIDDEN = 'BACKEND_FORBIDDEN';
export const BACKEND_ERROR = 'BACKEND_ERROR';
export const BACKEND_UNAVAILABLE = 'BACKEND_UNAVAILABLE';
export const GATEWAY_TIMEOUT = 'GATEWAY_TIMEOUT';

/**
 * Helper function to send structured error response
 *
 * Ensures all error responses conform to the ErrorResponse interface
 * with consistent structure across all endpoints.
 *
 * @param res - Express Response object
 * @param status - HTTP status code
 * @param message - Human-readable error message
 * @param code - Semantic error code (use constants from this module)
 *
 * @example
 * respondWithError(res, 404, 'Token not found', TOKEN_NOT_FOUND);
 * // Sends: { "error": { "message": "Token not found", "code": "TOKEN_NOT_FOUND" } }
 */
export function respondWithError(
  res: Response,
  status: number,
  message: string,
  code: string
): void {
  res.status(status).json({
    error: {
      message,
      code,
    },
  });
}
