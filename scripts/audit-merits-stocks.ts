// One-off source audit: fetch real Torn payloads for merits/stocks using the
// project's own TornApiClient + the dev account's stored credential.
import { readFileSync, writeFileSync } from "node:fs";
import { TornApiClient, TornEndpoints } from "../packages/torn-api/src/index.js";
import { EncryptionService } from "../packages/database/src/index.js";

const envFile = readFileSync("/workspace/tornscope-dev/.env.dev", "utf8");
const encKey = envFile.match(/^API_KEY_ENCRYPTION_KEY=(.*)$/m)?.[1]?.trim();
if (!encKey) throw new Error("no encryption key");

// Credential is read straight from the dev DB via psql piping (avoids a DB
// client dependency here).
const { execSync } = await import("node:child_process");
const row = execSync(
  `docker exec tornscope-dev-postgres-1 psql -U tornscope_dev -d tornscope_dev -t -A -F '|' -c "SELECT \\"encryptedKey\\", \\"iv\\", \\"authTag\\" FROM \\"ApiCredential\\" WHERE \\"revokedAt\\" IS NULL ORDER BY \\"validatedAt\\" DESC LIMIT 1"`,
  { encoding: "utf8" }
).trim();
const [encryptedKey, iv, authTag] = row.split("|");
if (!encryptedKey) throw new Error("no active credential");

const encryption = new EncryptionService(encKey);
const apiKey = encryption.decrypt({ encryptedKey, iv, authTag });

const client = new TornApiClient(apiKey, {
  minRequestIntervalMs: 700,
  logger: { debug: () => {}, info: () => {}, warn: () => {}, error: (e) => console.error("TORN ERR", JSON.stringify(e).slice(0, 200)) },
});
const endpoints = new TornEndpoints(client);

const out = {};
async function probe(name, path) {
  try {
    const page = await client.getRaw(path, {});
    out[name] = page.data;
    console.log(`== ${name} (${path}) OK`);
  } catch (e) {
    out[name] = { error: String(e).slice(0, 300) };
    console.log(`== ${name} (${path}) FAILED: ${String(e).slice(0, 200)}`);
  }
}

await probe("merits", "/user/merits");
await probe("torn_merits", "/torn/merits");
await probe("user_stocks", "/user/stocks");
await probe("torn_stocks", "/torn/stocks");
await probe("key_info", "/key/info?comment=tsaudit");

console.log("=== FULL PAYLOADS ===");
writeFileSync("/tmp/ts-qa/audit-payload.json", JSON.stringify(out, null, 1));
