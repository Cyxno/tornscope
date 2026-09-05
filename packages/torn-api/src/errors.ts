/**
 * Normalized Torn API errors.
 *
 * Classification is based on Torn's documented error codes
 * (https://www.torn.com/api.html, codes 0-30):
 *   1  Key is empty                 -> fatal key error
 *   2  Incorrect key                -> fatal key error
 *   5  Too many requests            -> retryable
 *   8  IP block                     -> retryable after a long wait
 *   9  API disabled                 -> fatal
 *  10  Owner in federal jail        -> temporary fatal
 *  12  Key read error               -> fatal key error
 *  13  Key temporarily disabled     -> temporary fatal
 *  14  Daily read limit reached     -> temporary fatal (resets daily)
 *  16  Access level too low         -> fatal access error
 *  17  Backend error occurred       -> retryable
 *  18  Key paused by owner          -> temporary fatal
 *  21  Incorrect category           -> non-retryable caller bug
 */
export type TornErrorKind =
  | "key_invalid"
  | "key_paused"
  | "access_denied"
  | "rate_limited"
  | "transient"
  | "permanent"
  | "network";

export class TornApiError extends Error {
  readonly kind: TornErrorKind;
  readonly tornCode: number | null;
  readonly status: number | null;
  /** True when retrying with backoff might succeed later. */
  readonly retryable: boolean;

  constructor(message: string, opts: { kind: TornErrorKind; tornCode?: number | null; status?: number | null; retryable?: boolean }) {
    super(message);
    this.name = "TornApiError";
    this.kind = opts.kind;
    this.tornCode = opts.tornCode ?? null;
    this.status = opts.status ?? null;
    this.retryable = opts.retryable ?? (opts.kind === "transient" || opts.kind === "rate_limited");
  }
}

export class TornNetworkError extends TornApiError {
  constructor(message: string, cause?: unknown) {
    super(message, { kind: "network", retryable: true });
    this.name = "TornNetworkError";
    this.cause = cause;
  }
}

export function tornKindForCode(code: number): { kind: TornErrorKind; retryable: boolean } {
  switch (code) {
    case 1:
    case 2:
    case 12:
      return { kind: "key_invalid", retryable: false };
    case 13:
    case 14:
    case 18:
      return { kind: "key_paused", retryable: false };
    case 16:
      return { kind: "access_denied", retryable: false };
    case 5:
      return { kind: "rate_limited", retryable: true };
    case 8:
    case 17:
      return { kind: "transient", retryable: true };
    case 9:
      return { kind: "permanent", retryable: false };
    case 10:
      return { kind: "key_paused", retryable: false };
    default:
      return { kind: "permanent", retryable: false };
  }
}
