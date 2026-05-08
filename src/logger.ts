/**
 * Simple logging utility for SSEGateway
 *
 * Provides plain text logging with severity prefixes as specified in product brief.
 * Format: YYYY-MM-DD HH:mm:ss,SSS [SEVERITY] message
 */

function timestamp(): string {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const hh = String(now.getHours()).padStart(2, '0');
  const mi = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  const ms = String(now.getMilliseconds()).padStart(3, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss},${ms}`;
}

/**
 * Log an informational message
 *
 * @param message - The message to log
 */
function info(message: string): void {
  console.log(`${timestamp()} [INFO] ${message}`);
}

/**
 * Log a warning message
 *
 * @param message - The warning message to log
 */
function warn(message: string): void {
  console.warn(`${timestamp()} [WARN] ${message}`);
}

/**
 * Log an error message
 *
 * @param message - The error message to log
 */
function error(message: string): void {
  console.error(`${timestamp()} [ERROR] ${message}`);
}

export const logger = {
  info,
  warn,
  error,
};
