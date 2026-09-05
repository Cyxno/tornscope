import type { Queue } from "bullmq";

/**
 * BullMQ's `queue.client` exposes a minimal adapter interface; the runtime
 * object is ioredis. This helper returns the subset TornScope actually uses,
 * with strict types instead of `any`.
 */
export interface RedisLike {
  ping(): Promise<string>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: "EX", ttlSeconds: number): Promise<unknown>;
}

export async function queueRedis(queue: Queue): Promise<RedisLike> {
  return (await queue.client) as unknown as RedisLike;
}
