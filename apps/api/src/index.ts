import { buildServer } from "./server.js";
import { env, logger } from "./env.js";
import { getApiContext } from "./context.js";

/** API entry point. */
async function main(): Promise<void> {
  if (!env.databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }
  // Validate the encryption master key at boot (fail fast).
  getApiContext();

  const app = await buildServer();
  await app.listen({ port: env.port, host: env.host });

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "shutting down api");
    await app.close();
    await getApiContext().syncQueue.close().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  logger.error({ err: (err as Error).stack ?? String(err) }, "api crashed");
  process.exit(1);
});
