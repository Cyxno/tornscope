import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * AES-256-GCM encryption for Torn API keys at rest.
 *
 * The master key comes from the API_KEY_ENCRYPTION_KEY environment variable
 * (64 hex chars = 32 bytes). Plaintext keys are never persisted or logged;
 * decryption happens only in the service that performs outgoing Torn requests.
 */
export class EncryptionService {
  private readonly key: Buffer;

  constructor(masterKeyHex: string) {
    if (!/^[0-9a-fA-F]{64}$/.test(masterKeyHex)) {
      throw new Error(
        "API_KEY_ENCRYPTION_KEY must be 64 hex characters (32 bytes). Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\""
      );
    }
    this.key = Buffer.from(masterKeyHex, "hex");
  }

  encrypt(plaintext: string): { encryptedKey: string; iv: string; authTag: string } {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return {
      encryptedKey: encrypted.toString("base64"),
      iv: iv.toString("base64"),
      authTag: cipher.getAuthTag().toString("base64"),
    };
  }

  decrypt(payload: { encryptedKey: string; iv: string; authTag: string }): string {
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(payload.iv, "base64"));
    decipher.setAuthTag(Buffer.from(payload.authTag, "base64"));
    const decrypted = Buffer.concat([decipher.update(Buffer.from(payload.encryptedKey, "base64")), decipher.final()]);
    return decrypted.toString("utf8");
  }

  /** Constant-time comparison helper for derived values. */
  safeEquals(a: string, b: string): boolean {
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    if (ab.length !== bb.length) return false;
    return timingSafeEqual(ab, bb);
  }
}

/** Build the encryption service from the environment, failing fast if unset. */
export function encryptionFromEnv(env: NodeJS.ProcessEnv = process.env): EncryptionService {
  const key = env.API_KEY_ENCRYPTION_KEY;
  if (!key) {
    throw new Error("API_KEY_ENCRYPTION_KEY is not set. Copy .env.example to .env and provide a generated key.");
  }
  return new EncryptionService(key);
}
