/**
 * Standardized error serialization utility.
 *
 * Use this to ensure consistent error logging across the codebase.
 * The logger already handles Error instances, but this utility provides
 * a convenient way to serialize errors for data objects.
 *
 * @example
 * // Good - pass error directly to logger
 * log.error("Failed", { error: err });
 *
 * // Good - use serializeError for data objects
 * log.error("Failed", { error: serializeError(err) });
 *
 * // Bad - inconsistent patterns
 * log.error("Failed", { error: err instanceof Error ? err.message : String(err) });
 */

export interface SerializedError {
  message: string;
  name?: string;
  stack?: string;
  cause?: unknown;
}

/**
 * Serialize an error to a plain object for logging.
 *
 * This is redundant when passing to logger.error()/warn() etc.
 * (the logger handles Error instances automatically), but useful
 * when you need to serialize errors in data structures.
 */
export function serializeError(err: unknown): SerializedError {
  if (err instanceof Error) {
    const serialized: SerializedError = {
      message: err.message,
      name: err.name,
      stack: err.stack,
    };
    if (err.cause !== undefined) {
      serialized.cause = err.cause;
    }
    return serialized;
  }
  return {
    message: String(err),
  };
}

/**
 * Get error message from any unknown error type.
 * Simpler alternative when you only need the message.
 */
export function getErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}
