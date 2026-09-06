import { logger } from "./env.js";

/** Application error with a stable code for the API error envelope. */
export class AppError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode: number = 400,
    readonly details?: unknown
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const errors = {
  noApiKey: () => new AppError("no_api_key", "No Torn API key is configured. Add one in Settings.", 409),
  invalidApiKey: (message: string) => new AppError("invalid_api_key", message, 400),
  accessDenied: (message: string) => new AppError("access_denied", message, 403),
  tornUnavailable: (message: string) => new AppError("torn_unavailable", `Torn API is currently unavailable: ${message}`, 503),
  notFound: (what: string) => new AppError("not_found", `${what} not found`, 404),
  validation: (details: unknown) => new AppError("validation_error", "Request validation failed", 400, details),
  cooldown: (message: string) => new AppError("cooldown", message, 429),
  forbidden: (message: string) => new AppError("forbidden", message, 403),
  conflict: (message: string) => new AppError("conflict", message, 409),
  internal: (message: string) => new AppError("internal_error", message, 500),
};

/** Map a TornApiError to a user-facing AppError. */
export function mapTornError(err: unknown): AppError {
  const tornKind = (err as { kind?: string }).kind;
  const message = (err as Error).message ?? "Unknown Torn API error";
  switch (tornKind) {
    case "key_invalid":
      return errors.invalidApiKey(message);
    case "key_paused":
      return errors.conflict(`The Torn API key is paused or temporarily unavailable: ${message}`);
    case "access_denied":
      return errors.accessDenied(message);
    case "rate_limited":
    case "transient":
    case "network":
      return errors.tornUnavailable(message);
    default:
      // Unknown failure: the raw message may contain Prisma/schema internals
      // (e.g. a DB error bubbling through the save-key flow) — log it here,
      // never leak it to the client.
      logger.error({ err: err instanceof Error ? err.stack : err }, "unmapped error surfaced through mapTornError");
      return errors.internal("Unexpected error while contacting Torn. Check the server logs for details.");
  }
}
