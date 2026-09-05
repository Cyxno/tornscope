import { RateLimiter, TornApiClient, TornEndpoints, type TornClientLogger } from "@tornscope/torn-api";
import { EncryptionService, encryptionFromEnv, getPrismaClient, type PrismaClientType } from "@tornscope/database";
import { Queue } from "bullmq";
import { SCHEDULER_QUEUE, SYNC_QUEUE } from "@tornscope/shared";
import { env, logger } from "./env.js";

/** Shape needed to decrypt a stored credential. */
export interface StoredCredential {
  encryptedKey: string;
  iv: string;
  authTag: string;
}

/**
 * API runtime context: database, encryption, Torn endpoints, sync queue
 * (for "Sync now" requests).
 */
export class ApiContext {
  readonly db: PrismaClientType;
  readonly rateLimiter: RateLimiter;
  readonly syncQueue: Queue;
  readonly schedulerQueue: Queue;
  private readonly encryption: EncryptionService;

  constructor() {
    this.db = getPrismaClient();
    this.encryption = encryptionFromEnv();
    this.rateLimiter = new RateLimiter(env.tornMinRequestIntervalMs);
    // Same queues as the worker consumer; names and options live in
    // @tornscope/shared so producer and consumer cannot drift.
    const connection = { url: env.redisUrl };
    this.syncQueue = new Queue(SYNC_QUEUE, { connection });
    this.schedulerQueue = new Queue(SCHEDULER_QUEUE, { connection });
  }

  encryptApiKey(plaintext: string) {
    return this.encryption.encrypt(plaintext);
  }

  decryptCredential(credential: StoredCredential): string {
    return this.encryption.decrypt(credential);
  }

  /** Endpoints bound to a decrypted key (used server-side only). */
  torn(apiKey: string): TornEndpoints {
    const client = new TornApiClient(apiKey, {
      baseUrl: env.tornBaseUrl,
      minRequestIntervalMs: env.tornMinRequestIntervalMs,
      rateLimiter: this.rateLimiter,
      logger: tornLoggerAdapter,
    });
    return new TornEndpoints(client);
  }
}

const tornLoggerAdapter: TornClientLogger = {
  debug: (obj) => logger.debug(obj, "torn api request"),
  warn: (obj) => logger.warn(obj, "torn api request retry"),
  error: (obj) => logger.error(obj, "torn api request failed"),
};

let cached: ApiContext | undefined;

export function getApiContext(): ApiContext {
  if (!cached) cached = new ApiContext();
  return cached;
}
