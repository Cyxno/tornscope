import Fastify, { type FastifyInstance } from "fastify";
import helmet from "@fastify/helmet";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { env } from "./env.js";
import { resolveBuildIdentity } from "@tornscope/shared";
import { registerRoutes } from "./routes.js";
import { AppError } from "./errors.js";

/** Whether a request can carry a body: an explicit non-zero content-length
 *  OR chunked transfer framing (which has no content-length at all). */
export function requestHasBody(headers: Record<string, unknown>): boolean {
  const transferEncoding = (headers["transfer-encoding"] ?? "").toString().toLowerCase();
  const contentLength = headers["content-length"];
  return transferEncoding.includes("chunked") || (contentLength !== undefined && contentLength !== "0");
}

/** Build the configured Fastify server (not started). */
export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? "info",
      redact: {
        paths: ["apiKey", "api_key", "key", "*.apiKey", "*.api_key", "*.key", "authorization", "req.headers.authorization"],
        censor: "[REDACTED]",
      },
      // Access-log hygiene: strip query strings (they can carry a push
      // endpoint URL on GET /api/notifications — never belongs in logs).
      serializers: {
        req: (req: { method?: string; url?: string; host?: string; remoteAddress?: string }) => ({
          method: req.method,
          url: (req.url ?? "").split("?")[0],
          host: req.host,
          remoteAddress: req.remoteAddress,
        }),
      },
    },
    // Honors TRUST_PROXY (true / false / proxy-addr subnet list — env.ts).
    // With trust enabled, Fastify resolves req.ip/req.protocol from the
    // X-Forwarded-* chain the web app's proxy forwards; raw forwarded
    // headers from an untrusted socket are ignored, so a direct client can
    // never spoof its way into a different rate-limit bucket.
    trustProxy: env.trustProxy,
    bodyLimit: 256 * 1024,
  });

  // A body-less mutation carrying "content-type: application/json" would hit
  // the JSON parser and fail with "Body cannot be empty..." before route
  // logic runs. Proxies and generic clients like to stamp that header, so
  // strip it whenever no body can be present (defense in depth — the web
  // proxy and browser client also avoid sending it).
  //
  // "No body" means: an explicit content-length of 0 (or no length header)
  // AND no chunked transfer framing. A chunked request has no
  // content-length at all, so pre-hardening logic misread it as body-less
  // and stripped the content-type — the JSON body then never parsed.
  app.addHook("onRequest", async (req) => {
    if (!requestHasBody(req.headers) && req.headers["content-type"]) {
      delete req.headers["content-type"];
    }
  });

  await app.register(helmet, {
    contentSecurityPolicy: false, // JSON API only
    referrerPolicy: { policy: "no-referrer" },
  });

  await app.register(cors, {
    origin: [env.appBaseUrl],
    credentials: false,
    methods: ["GET", "POST", "DELETE"],
  });

  await app.register(rateLimit, {
    max: 300,
    timeWindow: "1 minute",
    ban: 0,
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      reply.status(err.statusCode).send({
        error: { code: err.code, message: err.message, ...(err.details !== undefined ? { details: err.details } : {}) },
      });
      return;
    }
    const statusCode = (err as { statusCode?: number }).statusCode;
    if (statusCode && statusCode < 500) {
      reply.status(statusCode).send({
        error: { code: (err as { code?: string }).code ?? "bad_request", message: (err as Error).message },
      });
      return;
    }
    req.log.error({ err }, "unhandled error");
    // Correlation id only — never a stack, SQL, or path material.
    reply.status(500).send({ error: { code: "internal_error", message: "Unexpected server error", requestId: req.id } });
  });

  app.setNotFoundHandler((_req, reply) => {
    reply.status(404).send({ error: { code: "not_found", message: "Route not found" } });
  });

  app.addHook("onSend", async (req, reply) => {
    // Private, per-session API responses must never be shared-cacheable by
    // any intermediary (direct-access hardening; the web proxy enforces
    // no-store for everything anyway).
    if (req.raw.url?.startsWith("/api/")) {
      reply.header("cache-control", "private, no-store");
    }
    // Support correlation: safe random id, echoed in logs and 5xx bodies.
    reply.header("x-request-id", req.id);
    // Deployed build identity on every API response — the web proxy forwards
    // it to the browser, making build drift visible from the client.
    reply.header("x-tornscope-build", process.env.GIT_SHA ?? "dev");
  });

  app.get("/", async () => ({
    name: "TornScope API",
    status: "ok",
    ...resolveBuildIdentity({ version: env.build.version, gitSha: process.env.GIT_SHA ?? "dev", environment: env.build.environment }),
  }));

  registerRoutes(app as FastifyInstance);

  return app;
}
