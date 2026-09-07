import { RateLimiter, TornApiClient, TornEndpoints, type TornClientLogger, type TornClientMetrics } from "@tornscope/torn-api";
import { EncryptionService, encryptionFromEnv, getPrismaClient, type PrismaClientType } from "@tornscope/database";
import { env, logger } from "./env.js";

/** Minimal shape needed to decrypt a stored credential. */
export interface StoredCredential {
  encryptedKey: string;
  iv: string;
  authTag: string;
}

/**
 * Worker runtime context: database, encryption, Torn API endpoints with a
 * process-wide rate limiter.
 */
export class WorkerContext {
  readonly db: PrismaClientType;
  readonly rateLimiter: RateLimiter;
  readonly initialHistoryDays: number;
  private readonly encryption: EncryptionService;

  constructor() {
    this.db = getPrismaClient();
    this.rateLimiter = new RateLimiter(env.tornMinRequestIntervalMs);
    this.initialHistoryDays = env.initialHistoryDays;
    this.encryption = encryptionFromEnv();
  }

  decryptCredential(credential: StoredCredential): string {
    return this.encryption.decrypt(credential);
  }

  /** Build Torn endpoints bound to a decrypted key. */
  torn(apiKey: string): TornEndpoints {
    return this.createTorn(apiKey).endpoints;
  }

  /**
   * Build Torn endpoints AND expose the client's request counters so a sync
   * run can record how many Torn calls it made — including denied ones and
   * timeouts — in its SyncRun stats. Counters carry no key material.
   */
  createTorn(apiKey: string): { endpoints: TornEndpoints; metrics: TornClientMetrics } {
    const client = new TornApiClient(apiKey, {
      baseUrl: env.tornBaseUrl,
      minRequestIntervalMs: env.tornMinRequestIntervalMs,
      rateLimiter: this.rateLimiter,
      logger: tornLoggerAdapter,
    });
    return { endpoints: new TornEndpoints(client), metrics: client.metrics };
  }
}

const tornLoggerAdapter: TornClientLogger = {
  debug: (obj) => logger.debug(obj, "torn api request"),
  info: (obj) => logger.info(obj, "torn api request"),
  warn: (obj) => logger.warn(obj, "torn api request retry"),
  error: (obj) => logger.error(obj, "torn api request failed"),
};

let cached: WorkerContext | undefined;

export function getWorkerContext(): WorkerContext {
  if (!cached) {
    if (!env.encryptionKey) {
      throw new Error("API_KEY_ENCRYPTION_KEY is required for the worker");
    }
    // Validate the master key early - fail fast at boot.
    encryptionFromEnv();
    cached = new WorkerContext();
  }
  return cached;
}
