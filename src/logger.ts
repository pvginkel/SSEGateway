/**
 * Simple logging utility for SSEGateway
 *
 * Provides plain text logging with severity prefixes as specified in product brief.
 * Format: [SEVERITY] message
 */

/**
 * Log an informational message
 *
 * @param message - The message to log
 */
function info(message: string): void {
  console.log(`[INFO] ${message}`);
}

/**
 * Log a warning message
 *
 * @param message - The warning message to log
 */
function warn(message: string): void {
  console.warn(`[WARN] ${message}`);
}

/**
 * Log an error message
 *
 * @param message - The error message to log
 */
function error(message: string): void {
  console.error(`[ERROR] ${message}`);
}

export const logger = {
  info,
  warn,
  error,
};
