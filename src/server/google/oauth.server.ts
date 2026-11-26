// Server-only Google OAuth helpers. Never import this file from browser code.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { dbError } from "@/server/public-error.server";
import { decryptToken, encryptToken } from "@/server/google/token-crypto.server";

export const GOOGLE_SCOPES = [
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  // Reading messages and creating drafts require separate Gmail scopes.
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/calendar.events",
];

const STATE_TTL_MS = 10 * 60 * 1000;
const GOOGLE_OAUTH_TIMEOUT_MS = 20_000;

function googleOAuthSignal() {
  return AbortSignal.timeout(GOOGLE_OAUTH_TIMEOUT_MS);
}

// The state carries no return path: every sign-in comes back to the connectors page, the only
// page that can finish it (see callback.server.ts), so a return path would only be unused input.
type OAuthStatePayload = {
  uid: string;
  exp: number;
  /**
   * SHA-256 (base64url) of the browser key: a random value only the browser that started the
   * sign-in holds (see newBrowserKey). The state alone is not enough to finish a sign-in.
   */
  nonce: string;
};

export const GOOGLE_OAUTH_ENV = [
  "GOOGLE_OAUTH_CLIENT_ID",
  "GOOGLE_OAUTH_CLIENT_SECRET",
  "GOOGLE_OAUTH_STATE_SECRET",
] as const;

const OAUTH_NOT_AVAILABLE =
  "Connecting a Google account is not available on this site yet. You can continue with the demo inbox and calendar.";

/**
 * For a user who is already connected, when the server can no longer renew Google access because
 * its Google settings were removed: "connecting is not available yet" would not fit them.
 */
const GOOGLE_NOT_AVAILABLE_NOW =
  "Google is not available on this site right now, so your Gmail and Calendar cannot be reached. Please try again later.";

/**
 * Thrown when the server has no Google OAuth client. The message is shown to visitors as-is, so
 * it names no settings; `missing` (the setting names) is for the server log and tests.
 */
export class GoogleOAuthNotConfiguredError extends Error {
  constructor(
    readonly missing: string[],
    message: string = OAUTH_NOT_AVAILABLE,
  ) {
    super(message);
    this.name = "GoogleOAuthNotConfiguredError";
  }
}

/** Which Google OAuth settings are present. Never returns the values. */
export function googleOAuthConfigStatus(env: Record<string, string | undefined> = process.env) {
  const missing: string[] = GOOGLE_OAUTH_ENV.filter((name) => !env[name]?.trim());
  const secret = env.GOOGLE_OAUTH_STATE_SECRET?.trim() ?? "";
  if (secret && secret.length < 32) missing.push("GOOGLE_OAUTH_STATE_SECRET (at least 32 characters)");
  return { configured: missing.length === 0, missing };
}

function notConfigured(missing: string[], message?: string): GoogleOAuthNotConfiguredError {
  // The setting names are for the person who runs the server (RUNNING.md explains them).
  console.warn(`[google] Google OAuth is not configured (missing ${missing.join(", ")}; see RUNNING.md).`);
  return new GoogleOAuthNotConfiguredError(missing, message);
}

/**
 * Whether the Google OAuth client is in Google's "Testing" publishing status
 * (GOOGLE_OAUTH_TESTING=true): only Google accounts listed as test users can connect, Google shows
 * a warning screen first, and the connection lapses after 7 days. The page says so.
 */
export function googleOAuthTesting(env: Record<string, string | undefined> = process.env): boolean {
  return env.GOOGLE_OAUTH_TESTING?.trim().toLowerCase() === "true";
}

/** Shown to a demo (anonymous) account that tries to connect Google. */
export const ANONYMOUS_GOOGLE_MESSAGE =
  "A demo session cannot connect a Google account, because it is deleted after 7 days and cannot be reopened. Sign out, create an account with your email on the sign-in page, and connect Google from there.";

/** Whether the signed-in Supabase user is an anonymous (demo) user, from the token's claims. */
export function isAnonymousClaims(claims: unknown): boolean {
  return typeof claims === "object" && claims !== null && (claims as { is_anonymous?: unknown }).is_anonymous === true;
}

export function assertGoogleOAuthConfigured() {
  const status = googleOAuthConfigStatus();
  if (!status.configured) throw notConfigured(status.missing);
}

/** `message` is what the user reads when the setting is missing (default: connecting is not available). */
function requiredEnv(name: string, message?: string): string {
  const value = process.env[name];
  if (!value) throw notConfigured([name], message);
  return value;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): ArrayBuffer {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4 || 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes.buffer;
}

async function getStateKey() {
  const secret = requiredEnv("GOOGLE_OAUTH_STATE_SECRET");
  if (secret.length < 32) {
    throw notConfigured(["GOOGLE_OAUTH_STATE_SECRET (at least 32 characters)"]);
  }
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

/**
 * A random key for one Google sign-in. The browser that starts the sign-in keeps it (in
 * sessionStorage) and only its hash goes into the state, so a state sent to someone else's browser
 * (OAuth CSRF: "connect your Google account to my MONDAY account") cannot be finished there.
 */
export function newBrowserKey(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

/** SHA-256 of a browser key, base64url: the state's nonce. */
export async function browserKeyHash(browserKey: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(browserKey));
  return toBase64Url(new Uint8Array(digest));
}

/** Equal strings, compared in time that does not depend on where they differ. */
function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return diff === 0;
}

/** Whether `browserKey` is the key of the browser that started the sign-in of this state. */
export async function stateMatchesBrowser(
  state: Pick<OAuthStatePayload, "nonce">,
  browserKey: string,
): Promise<boolean> {
  if (!browserKey) return false;
  return sameText(await browserKeyHash(browserKey), state.nonce);
}

/**
 * Start a sign-in: sign its state and record it as pending (see consumePendingSignIn), so it can be
 * finished once. Starting one removes the account's older pending sign-ins, so normally only the
 * newest can be finished. (Two starts at the same moment can both stay pending; each still needs
 * its own browser key and can be finished only once.)
 */
export async function createSignedOAuthState(params: {
  userId: string;
  /** The key the starting browser keeps (newBrowserKey); required to finish the sign-in. */
  browserKey: string;
}): Promise<string> {
  const payload: OAuthStatePayload = {
    uid: params.userId,
    exp: Date.now() + STATE_TTL_MS,
    nonce: await browserKeyHash(params.browserKey),
  };
  const encodedPayload = toBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const key = await getStateKey();
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(encodedPayload),
  );
  await recordPendingSignIn(payload);
  return `${encodedPayload}.${toBase64Url(new Uint8Array(signature))}`;
}

/**
 * Pending sign-ins, one row per started sign-in that is not finished yet; only the server can
 * read or write them (supabase/migrations/20261125100000_google_oauth_states.sql).
 */
const PENDING_SIGN_INS = "google_oauth_states";

/** Record a started sign-in; expired rows of every account and this account's older ones go. */
async function recordPendingSignIn(payload: OAuthStatePayload) {
  const { error: expiredError } = await supabaseAdmin
    .from(PENDING_SIGN_INS)
    .delete()
    .lt("expires_at", new Date().toISOString());
  if (expiredError) throw dbError("start the Google sign-in", expiredError);
  const { error: olderError } = await supabaseAdmin
    .from(PENDING_SIGN_INS)
    .delete()
    .eq("user_id", payload.uid);
  if (olderError) throw dbError("start the Google sign-in", olderError);
  const { error } = await supabaseAdmin.from(PENDING_SIGN_INS).insert({
    nonce: payload.nonce,
    user_id: payload.uid,
    expires_at: new Date(payload.exp).toISOString(),
  });
  if (error) throw dbError("start the Google sign-in", error);
}

/**
 * Use up the pending sign-in of a state for this account: true the first time, false when it was
 * finished before, replaced by a newer sign-in, has expired, or was never started here. It is one
 * DELETE ... RETURNING, so two requests with the same state cannot both get true.
 */
export async function consumePendingSignIn(
  state: Pick<OAuthStatePayload, "nonce">,
  userId: string,
): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from(PENDING_SIGN_INS)
    .delete()
    .eq("nonce", state.nonce)
    .eq("user_id", userId)
    .gt("expires_at", new Date().toISOString())
    .select("nonce");
  if (error) throw dbError("finish the Google sign-in", error);
  return Array.isArray(data) && data.length > 0;
}

export async function verifySignedOAuthState(state: string): Promise<OAuthStatePayload | null> {
  try {
    const [encodedPayload, encodedSignature, extra] = state.split(".");
    if (!encodedPayload || !encodedSignature || extra) return null;

    const key = await getStateKey();
    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      fromBase64Url(encodedSignature),
      new TextEncoder().encode(encodedPayload),
    );
    if (!valid) return null;

    const payload = JSON.parse(
      new TextDecoder().decode(fromBase64Url(encodedPayload)),
    ) as Partial<OAuthStatePayload>;

    if (
      typeof payload.uid !== "string" ||
      typeof payload.exp !== "number" ||
      typeof payload.nonce !== "string" ||
      payload.exp < Date.now()
    ) {
      return null;
    }

    return {
      uid: payload.uid,
      exp: payload.exp,
      nonce: payload.nonce,
    };
  } catch {
    return null;
  }
}

/**
 * The OAuth redirect URI. Defaults to this server's own callback route; set
 * GOOGLE_OAUTH_REDIRECT_URI when the app runs behind a proxy with a different public URL.
 * It must match one of the "Authorised redirect URIs" of the Google OAuth client exactly.
 */
export function getRedirectUri(origin: string) {
  const override = process.env.GOOGLE_OAUTH_REDIRECT_URI?.trim();
  return override || `${origin}/api/public/google/callback`;
}

export function buildAuthUrl(params: { origin: string; state: string }) {
  const clientId = requiredEnv("GOOGLE_OAUTH_CLIENT_ID");
  const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  u.searchParams.set("client_id", clientId);
  u.searchParams.set("redirect_uri", getRedirectUri(params.origin));
  u.searchParams.set("response_type", "code");
  u.searchParams.set("access_type", "offline");
  u.searchParams.set("prompt", "consent");
  u.searchParams.set("include_granted_scopes", "true");
  u.searchParams.set("scope", GOOGLE_SCOPES.join(" "));
  u.searchParams.set("state", params.state);
  return u.toString();
}

/**
 * POST to Google's token endpoint. Users get `failure` as the message; the status and Google's
 * answer go to the server log only.
 */
async function postToGoogleToken(
  body: URLSearchParams,
  what: string,
  failure: string,
  /** What to do when Google could not be reached or failed itself (a network error or a 5xx). */
  retry = "Please try again in a moment.",
): Promise<Response> {
  let res: Response;
  try {
    res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: googleOAuthSignal(),
    });
  } catch (error) {
    console.error(`[google] ${what}: request failed:`, error);
    throw new Error(`Google could not be reached. ${retry}`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.error(`[google] ${what} failed (${res.status}): ${text.slice(0, 300)}`);
    // A 5xx is Google's own trouble, not a refused sign-in: saying it was refused would mislead.
    if (res.status >= 500) throw new Error(`Google is not answering right now. ${retry}`);
    throw new Error(failure);
  }
  return res;
}

export async function exchangeCodeForTokens(code: string, origin: string) {
  const res = await postToGoogleToken(
    new URLSearchParams({
      code,
      client_id: requiredEnv("GOOGLE_OAUTH_CLIENT_ID"),
      client_secret: requiredEnv("GOOGLE_OAUTH_CLIENT_SECRET"),
      redirect_uri: getRedirectUri(origin),
      grant_type: "authorization_code",
    }),
    "Token exchange",
    "Google did not accept this sign-in (it may have expired or been used already). Please click Connect Google again.",
    // The pending sign-in is used up before this call (completeGoogleConnection) and the page has
    // dropped the code, so the same sign-in cannot be finished again: a new one is needed.
    "Please click Connect Google again in a moment.",
  );
  return res.json() as Promise<{
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    scope: string;
    token_type: string;
    id_token?: string;
  }>;
}

export async function refreshAccessToken(refreshToken: string) {
  // Only reached for a user who is already connected, so they get their own sentence.
  const res = await postToGoogleToken(
    new URLSearchParams({
      client_id: requiredEnv("GOOGLE_OAUTH_CLIENT_ID", GOOGLE_NOT_AVAILABLE_NOW),
      client_secret: requiredEnv("GOOGLE_OAUTH_CLIENT_SECRET", GOOGLE_NOT_AVAILABLE_NOW),
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
    "Token refresh",
    "Google did not renew MONDAY's access to your account. Please connect Google again from your profile.",
  );
  return res.json() as Promise<{
    access_token: string;
    expires_in: number;
    scope: string;
    token_type: string;
  }>;
}

export async function fetchGoogleUserEmail(accessToken: string): Promise<string | null> {
  // The address is only shown next to "Connected"; without it the connection still works.
  try {
    const res = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: googleOAuthSignal(),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { email?: unknown };
    return typeof json.email === "string" ? json.email : null;
  } catch (error) {
    console.warn("[google] Could not read the Google account's address:", error);
    return null;
  }
}

/** Fetch a valid access token for the user, refreshing if needed. */
export async function getValidAccessToken(
  userId: string,
): Promise<{ accessToken: string; email: string | null }> {
  const { data: row, error } = await supabaseAdmin
    .from("google_oauth_tokens")
    .select("access_token, refresh_token, expires_at, google_email")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw dbError("read your Google connection", error);
  if (!row) throw new Error("GOOGLE_NOT_CONNECTED");

  const expiresAt = new Date(row.expires_at).getTime();
  if (expiresAt - Date.now() > 60_000) {
    return { accessToken: await decryptToken(row.access_token), email: row.google_email };
  }
  if (!row.refresh_token) throw new Error("GOOGLE_NOT_CONNECTED");

  const refreshed = await refreshAccessToken(await decryptToken(row.refresh_token));
  const newExpiry = new Date(Date.now() + refreshed.expires_in * 1000).toISOString();
  const { error: updateError } = await supabaseAdmin
    .from("google_oauth_tokens")
    .update({
      access_token: await encryptToken(refreshed.access_token),
      expires_at: newExpiry,
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", userId);
  if (updateError) throw dbError("save your renewed Google access", updateError);

  return { accessToken: refreshed.access_token, email: row.google_email };
}

export async function storeTokens(params: {
  userId: string;
  accessToken: string;
  refreshToken?: string;
  expiresIn: number;
  scope: string;
  tokenType: string;
  email: string | null;
}) {
  const expiresAt = new Date(Date.now() + params.expiresIn * 1000).toISOString();
  // Both tokens are stored encrypted when GOOGLE_TOKEN_ENCRYPTION_KEY is set (token-crypto.server.ts).
  const update = {
    user_id: params.userId,
    google_email: params.email,
    access_token: await encryptToken(params.accessToken),
    scope: params.scope,
    token_type: params.tokenType,
    expires_at: expiresAt,
    updated_at: new Date().toISOString(),
    ...(params.refreshToken ? { refresh_token: await encryptToken(params.refreshToken) } : {}),
  };

  const { error } = await supabaseAdmin
    .from("google_oauth_tokens")
    .upsert(update, { onConflict: "user_id" });
  if (error) throw dbError("save your Google connection", error);
}


/** Revoke a Google access or refresh token during explicit disconnect. */
export async function revokeGoogleToken(token: string): Promise<void> {
  const res = await fetch("https://oauth2.googleapis.com/revoke", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }),
    signal: googleOAuthSignal(),
  });
  if (!res.ok) throw new Error(`Google token revocation failed (${res.status})`);
}
