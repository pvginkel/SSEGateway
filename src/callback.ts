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
    return await sendCallback(callbackUrl, payload, token, 'disconnect');
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
      logger.info(`${action} callback succeeded: token=${token} status=${response.status}`);
      return { success: true, statusCode: response.status };
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
