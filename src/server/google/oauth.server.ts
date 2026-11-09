// Server-only Google OAuth helpers. Never import this file from browser code.
import { supabaseAdmin } from "@/integrations/supabase/client.server";

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

type OAuthStatePayload = {
  uid: string;
  rt: string;
  exp: number;
  nonce: string;
};

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not configured`);
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

function sanitizeReturnTo(value?: string): string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) {
    return "/onboarding/connectors";
  }
  return value;
}

async function getStateKey() {
  const secret = requiredEnv("GOOGLE_OAUTH_STATE_SECRET");
  if (secret.length < 32) {
    throw new Error("GOOGLE_OAUTH_STATE_SECRET must be at least 32 characters");
  }
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function createSignedOAuthState(params: {
  userId: string;
  returnTo?: string;
}): Promise<string> {
  const payload: OAuthStatePayload = {
    uid: params.userId,
    rt: sanitizeReturnTo(params.returnTo),
    exp: Date.now() + STATE_TTL_MS,
    nonce: crypto.randomUUID(),
  };
  const encodedPayload = toBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const key = await getStateKey();
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(encodedPayload),
  );
  return `${encodedPayload}.${toBase64Url(new Uint8Array(signature))}`;
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
      typeof payload.rt !== "string" ||
      typeof payload.exp !== "number" ||
      typeof payload.nonce !== "string" ||
      payload.exp < Date.now()
    ) {
      return null;
    }

    return {
      uid: payload.uid,
      rt: sanitizeReturnTo(payload.rt),
      exp: payload.exp,
      nonce: payload.nonce,
    };
  } catch {
    return null;
  }
}

export function getRedirectUri(origin: string) {
  return `${origin}/api/public/google/callback`;
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

export async function exchangeCodeForTokens(code: string, origin: string) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: requiredEnv("GOOGLE_OAUTH_CLIENT_ID"),
      client_secret: requiredEnv("GOOGLE_OAUTH_CLIENT_SECRET"),
      redirect_uri: getRedirectUri(origin),
      grant_type: "authorization_code",
    }),
    signal: googleOAuthSignal(),
  });
  if (!res.ok) throw new Error(`Token exchange failed (${res.status})`);
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
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: requiredEnv("GOOGLE_OAUTH_CLIENT_ID"),
      client_secret: requiredEnv("GOOGLE_OAUTH_CLIENT_SECRET"),
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
    signal: googleOAuthSignal(),
  });
  if (!res.ok) throw new Error(`Token refresh failed (${res.status})`);
  return res.json() as Promise<{
    access_token: string;
    expires_in: number;
    scope: string;
    token_type: string;
  }>;
}

export async function fetchGoogleUserEmail(accessToken: string): Promise<string | null> {
  const res = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: googleOAuthSignal(),
  });
  if (!res.ok) return null;
  const json = await res.json();
  return json.email ?? null;
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
  if (error) throw error;
  if (!row) throw new Error("GOOGLE_NOT_CONNECTED");

  const expiresAt = new Date(row.expires_at).getTime();
  if (expiresAt - Date.now() > 60_000) {
    return { accessToken: row.access_token, email: row.google_email };
  }
  if (!row.refresh_token) throw new Error("GOOGLE_NOT_CONNECTED");

  const refreshed = await refreshAccessToken(row.refresh_token);
  const newExpiry = new Date(Date.now() + refreshed.expires_in * 1000).toISOString();
  const { error: updateError } = await supabaseAdmin
    .from("google_oauth_tokens")
    .update({
      access_token: refreshed.access_token,
      expires_at: newExpiry,
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", userId);
  if (updateError) throw updateError;

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
  const update = {
    user_id: params.userId,
    google_email: params.email,
    access_token: params.accessToken,
    scope: params.scope,
    token_type: params.tokenType,
    expires_at: expiresAt,
    updated_at: new Date().toISOString(),
    ...(params.refreshToken ? { refresh_token: params.refreshToken } : {}),
  };

  const { error } = await supabaseAdmin
    .from("google_oauth_tokens")
    .upsert(update, { onConflict: "user_id" });
  if (error) throw error;
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
