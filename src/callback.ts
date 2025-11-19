/**
 * Python backend callback logic for SSEGateway
 *
 * Handles HTTP callbacks to notify Python backend of connection lifecycle events.
 * Implements best-effort delivery (no retries, log failures only).
 */

import { logger } from './logger.js';

/**
 * Callback action type
 */
export type CallbackAction = 'connect' | 'disconnect';

/**
 * Disconnect reason
 */
export type DisconnectReason = 'client_closed' | 'server_closed' | 'error';

/**
 * Request metadata forwarded to Python backend
 */
export interface CallbackRequest {
  /** Full raw URL including query string */
  url: string;
  /** Raw headers from request (no undefined values) */
  headers: Record<string, string | string[]>;
}

/**
 * Connect callback payload
 */
interface ConnectCallbackPayload {
  action: 'connect';
  token: string;
  request: CallbackRequest;
}

/**
 * Disconnect callback payload
 */
interface DisconnectCallbackPayload {
  action: 'disconnect';
  reason: DisconnectReason;
  token: string;
  request: CallbackRequest;
}

/**
 * Callback response body structure
 * Optional event and/or close directive returned by Python backend in callback response
 */
export interface CallbackResponseBody {
  /** Optional event to send immediately */
  event?: {
    /** Optional event type name */
    name?: string;
    /** Event data (required if event present) */
    data: string;
  };
  /** Optional close flag - if true, close connection after sending event */
  close?: boolean;
}

/**
 * Callback response result
 */
export interface CallbackResult {
  /** Whether callback succeeded (2xx response) */
  success: boolean;
  /** HTTP status code (if response received) */
  statusCode?: number;
  /** Error type classification (if request failed) */
  errorType?: 'timeout' | 'network' | 'http_error';
  /** Error message (if request failed or non-2xx) */
  error?: string;
  /** Parsed response body (only present if success = true and body is valid) */
  responseBody?: CallbackResponseBody;
}

/**
 * Send connect callback to Python backend
 *
 * @param callbackUrl - Python backend callback endpoint URL
 * @param token - Connection token (UUID)
 * @param request - Request metadata (url, headers)
 * @returns Callback result with success status and error details
 */
export async function sendConnectCallback(
  callbackUrl: string,
  token: string,
  request: CallbackRequest
): Promise<CallbackResult> {
  const payload: ConnectCallbackPayload = {
    action: 'connect',
    token,
    request,
  };

  return sendCallback(callbackUrl, payload, token, 'connect');
}

/**
 * Send disconnect callback to Python backend
 *
 * Best-effort: failures are logged only, do not throw.
 *
 * @param callbackUrl - Python backend callback endpoint URL
 * @param token - Connection token (UUID)
 * @param reason - Disconnect reason
 * @param request - Request metadata (url, headers)
 * @returns Callback result with success status (always resolves, never throws)
 */
export async function sendDisconnectCallback(
  callbackUrl: string,
  token: string,
  reason: DisconnectReason,
  request: CallbackRequest
): Promise<CallbackResult> {
  const payload: DisconnectCallbackPayload = {
    action: 'disconnect',
    reason,
    token,
    request,
  };

  try {
    const result = await sendCallback(callbackUrl, payload, token, 'disconnect');

    // Disconnect callbacks are sent after connection cleanup
    // Response bodies with event/close cannot be applied - log warning if present
    if (result.success && result.responseBody) {
      const { event, close } = result.responseBody;
      if (event || close) {
        logger.warn(
          `disconnect callback returned response body with event/close but connection already closed: token=${token} hasEvent=${!!event} hasClose=${!!close}`
        );
      }
    }

    return result;
  } catch (error) {
    // Disconnect callback is best-effort - never throw, only log
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`Disconnect callback failed: token=${token} error=${errorMessage}`);
    return { success: false, error: errorMessage };
  }
}

/**
 * Internal helper to send callback via fetch with timeout
 *
 * @param callbackUrl - Callback endpoint URL
 * @param payload - Callback payload (connect or disconnect)
 * @param token - Connection token (for logging)
 * @param action - Action type (for logging)
 * @returns Callback result
 */
async function sendCallback(
  callbackUrl: string,
  payload: ConnectCallbackPayload | DisconnectCallbackPayload,
  token: string,
  action: string
): Promise<CallbackResult> {
  try {
    // Use AbortSignal.timeout for 5-second timeout (Node.js 20 feature)
    const response = await fetch(callbackUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000),
    });

    if (response.ok) {
      // 2xx status - success
      // Read and parse response body (lenient - invalid bodies treated as {})
      let responseBody: CallbackResponseBody | undefined;

      try {
        const rawBody = await response.json();
        responseBody = parseCallbackResponseBody(rawBody, token, action);
      } catch (error) {
        // JSON parse error or read error - treat as empty body
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error(
          `${action} callback response body parse error: token=${token} error=${errorMessage}`
        );
        // Continue with responseBody = undefined (treated as {})
      }

      logger.info(`${action} callback succeeded: token=${token} status=${response.status}`);
      return { success: true, statusCode: response.status, responseBody };
    } else {
      // Non-2xx status - failure
      const errorMsg = `${action} callback returned non-2xx: token=${token} status=${response.status}`;
      logger.error(errorMsg);
      return {
        success: false,
        statusCode: response.status,
        errorType: 'http_error',
        error: `HTTP ${response.status}`,
      };
    }
  } catch (error) {
    // Network error or timeout
    let errorMessage: string;
    let errorType: 'timeout' | 'network';

    // Check error type - handle both Error instances and DOMException (for timeout)
    if (error && typeof error === 'object' && 'name' in error) {
      const errorName = (error as { name: string }).name;
      if (errorName === 'TimeoutError' || errorName === 'AbortError') {
        errorType = 'timeout';
        errorMessage = `${action} callback timeout (>5s)`;
      } else {
        errorType = 'network';
        errorMessage = (error as Error).message || String(error);
      }
    } else {
      errorType = 'network';
      errorMessage = typeof error === 'object' && error !== null
        ? JSON.stringify(error)
        : String(error);
    }

    logger.error(`${action} callback failed: token=${token} error=${errorMessage}`);
    return { success: false, errorType, error: `${errorType}: ${errorMessage}` };
  }
}

/**
 * Parse and validate callback response body with lenient validation
 *
 * Invalid structures are treated as empty {} and logged as errors.
 * This maintains backwards compatibility with Python backends that don't send bodies.
 *
 * @param rawBody - Raw JSON-parsed response body
 * @param token - Connection token (for logging)
 * @param action - Action type (for logging)
 * @returns Validated CallbackResponseBody or undefined if invalid
 */
function parseCallbackResponseBody(
  rawBody: unknown,
  token: string,
  action: string
): CallbackResponseBody | undefined {
  // If body is not an object, treat as empty
  if (typeof rawBody !== 'object' || rawBody === null) {
    if (rawBody !== null && rawBody !== undefined) {
      logger.error(
        `${action} callback response body is not an object: token=${token} type=${typeof rawBody}`
      );
    }
    return undefined;
  }

  const body = rawBody as Record<string, unknown>;
  const result: CallbackResponseBody = {};
  let hasValidFields = false;

  // Validate event field if present
  if ('event' in body) {
    const event = body.event;

    // event must be an object
    if (typeof event !== 'object' || event === null) {
      logger.error(
        `${action} callback response body event field is not an object: token=${token} type=${typeof event}`
      );
    } else {
      const eventObj = event as Record<string, unknown>;

      // event.data is required if event is present
      if (!('data' in eventObj) || typeof eventObj.data !== 'string') {
        logger.error(
          `${action} callback response body event.data is missing or not a string: token=${token}`
        );
      } else {
        // event.data is valid - include in result
        result.event = { data: eventObj.data };
        hasValidFields = true;

        // event.name is optional but must be string if present
        if ('name' in eventObj) {
          if (typeof eventObj.name === 'string') {
            result.event.name = eventObj.name;
          } else if (eventObj.name !== undefined) {
            logger.error(
              `${action} callback response body event.name is not a string: token=${token} type=${typeof eventObj.name}`
            );
          }
        }
      }
    }
  }

  // Validate close field if present
  if ('close' in body) {
    const close = body.close;

    if (typeof close === 'boolean') {
      result.close = close;
      hasValidFields = true;
    } else {
      logger.error(
        `${action} callback response body close field is not a boolean: token=${token} type=${typeof close}`
      );
    }
  }

  // Return empty object if no valid fields found (valid but empty response)
  return hasValidFields ? result : {};
}
