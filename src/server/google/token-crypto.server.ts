// Server-only encryption of stored Google tokens. Never import this file from browser code.
//
// google_oauth_tokens is readable only by the server (REVOKE plus row-level security), and the
// tokens are also encrypted with AES-GCM under GOOGLE_TOKEN_ENCRYPTION_KEY (32 random bytes,
// base64), so a copy of the table alone does not give access to anyone's Gmail or Calendar.
// Stored form: "enc:v1:<iv base64url>.<ciphertext base64url>". A value without that prefix is a
// token stored before encryption was switched on and is read as it is.

const PREFIX = "enc:v1:";

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4 || 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** Thrown when a stored token cannot be read: the user has to connect Google again. */
export class GoogleTokenUnreadableError extends Error {
  constructor() {
    super("GOOGLE_NOT_CONNECTED");
    this.name = "GoogleTokenUnreadableError";
  }
}

async function encryptionKey(env: Record<string, string | undefined>): Promise<CryptoKey | null> {
  const raw = env.GOOGLE_TOKEN_ENCRYPTION_KEY?.trim();
  if (!raw) return null;
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = fromBase64(raw);
  } catch {
    throw new Error("GOOGLE_TOKEN_ENCRYPTION_KEY is not valid base64.");
  }
  if (bytes.length !== 32) throw new Error("GOOGLE_TOKEN_ENCRYPTION_KEY must be 32 bytes (base64).");
  return crypto.subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

/** Whether a stored value is in the encrypted form. */
export function isEncryptedToken(value: string): boolean {
  return value.startsWith(PREFIX);
}

/**
 * Encrypt a token for storage. Without GOOGLE_TOKEN_ENCRYPTION_KEY (a local run) the token is
 * stored as it is, as before this module existed.
 */
export async function encryptToken(
  token: string,
  env: Record<string, string | undefined> = process.env,
): Promise<string> {
  const key = await encryptionKey(env);
  if (!key) return token;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(token));
  return `${PREFIX}${toBase64Url(iv)}.${toBase64Url(new Uint8Array(cipher))}`;
}

/**
 * Read a stored token. A plain (older) value is returned as it is; an encrypted value that cannot
 * be decrypted (no key, another key, damaged) throws GoogleTokenUnreadableError, which callers
 * treat like a missing connection.
 */
export async function decryptToken(
  stored: string,
  env: Record<string, string | undefined> = process.env,
): Promise<string> {
  if (!isEncryptedToken(stored)) return stored;
  const key = await encryptionKey(env);
  if (!key) throw new GoogleTokenUnreadableError();
  const [ivText, cipherText, extra] = stored.slice(PREFIX.length).split(".");
  if (!ivText || !cipherText || extra !== undefined) throw new GoogleTokenUnreadableError();
  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64(ivText) },
      key,
      fromBase64(cipherText),
    );
    return new TextDecoder().decode(plain);
  } catch {
    throw new GoogleTokenUnreadableError();
  }
}
