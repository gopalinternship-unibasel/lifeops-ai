// Server-only handling of Google's OAuth redirect (GET /api/public/google/callback) and of the
// step that finishes the sign-in. Kept out of the route file so the whole flow can be tested
// against mocked Google endpoints.
//
// Why two steps: the callback is a plain GET that anyone's browser can be sent to, carrying no
// MONDAY session. If it stored the tokens itself, an attacker could start a sign-in for their own
// MONDAY account, send the Google consent link to a victim, and get the victim's Gmail and Calendar
// attached to the attacker's account (OAuth CSRF). So the callback only hands the code and state
// on to the app page, and the signed-in page finishes the sign-in through an authenticated server
// function (completeGoogleConnection), which accepts the state only for the same MONDAY account
// and only from the browser that started it (the browser key, see oauth.server.ts).
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { dbError, publicError } from "@/server/public-error.server";
import {
  exchangeCodeForTokens,
  fetchGoogleUserEmail,
  stateMatchesBrowser,
  storeTokens,
  verifySignedOAuthState,
} from "./oauth.server";

/** The page that finishes a Google sign-in (src/routes/onboarding.connectors.tsx). */
export const GOOGLE_OAUTH_COMPLETE_PATH = "/onboarding/connectors";

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character] ?? character);
}

export function htmlError(message: string) {
  const safeMessage = escapeHtml(message);
  return new Response(
    `<!doctype html><html><body style="font-family:system-ui;padding:2rem"><h2>Connection failed</h2><p>${safeMessage}</p><p><a href="/onboarding/connectors">Back</a></p></body></html>`,
    { status: 400, headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

export async function handleGoogleOAuthCallback(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const stateRaw = url.searchParams.get("state");
  const error = url.searchParams.get("error");
  if (error) return htmlError(`Google returned: ${error}`);
  if (!code || !stateRaw) return htmlError("Missing code/state.");
  const state = await verifySignedOAuthState(stateRaw);
  if (!state) return htmlError("Invalid state.");

  // Nothing is stored here: the signed-in page finishes the sign-in (see the top of this file).
  const origin = `${url.protocol}//${url.host}`;
  const target = new URL(`${origin}${GOOGLE_OAUTH_COMPLETE_PATH}`);
  target.searchParams.set("google_code", code);
  target.searchParams.set("google_state", stateRaw);
  return new Response(null, {
    status: 302,
    headers: {
      location: target.toString(),
      "cache-control": "no-store",
      // The next page's address carries the code until the page removes it.
      "referrer-policy": "no-referrer",
    },
  });
}

const SIGN_IN_EXPIRED =
  "This Google sign-in has expired or is not valid. Please click Connect Google again.";
const OTHER_ACCOUNT =
  "This Google sign-in was started from a different MONDAY account, so it was not connected. Please click Connect Google again while signed in to the account you want to connect.";
const OTHER_BROWSER =
  "This Google sign-in was started in a different browser or tab, so it was not connected. Please click Connect Google again here.";

/**
 * Finish a Google sign-in for the signed-in user: check the state (signature, expiry, same MONDAY
 * account, same browser), exchange the code and store the tokens. Throws errors whose message is
 * meant for the user.
 */
export async function completeGoogleConnection(opts: {
  /** The signed-in user finishing the sign-in (from the authenticated request, never the state). */
  userId: string;
  code: string;
  state: string;
  /** The key the starting browser kept; "" when it has none. */
  browserKey: string;
  /** This server's public origin, for the redirect URI the code was issued for. */
  origin: string;
}): Promise<{ email: string | null }> {
  const state = await verifySignedOAuthState(opts.state);
  if (!state) throw publicError(SIGN_IN_EXPIRED);
  if (state.uid !== opts.userId) {
    throw publicError(OTHER_ACCOUNT, "state of another user", "google oauth: refused a sign-in");
  }
  if (!(await stateMatchesBrowser(state, opts.browserKey))) {
    throw publicError(OTHER_BROWSER, "browser key does not match", "google oauth: refused a sign-in");
  }

  // Throws a sentence for the user when Google refuses the code (expired or already used).
  const tokens = await exchangeCodeForTokens(opts.code, opts.origin);
  const email = await fetchGoogleUserEmail(tokens.access_token);
  await storeTokens({
    userId: opts.userId,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresIn: tokens.expires_in,
    scope: tokens.scope,
    tokenType: tokens.token_type,
    email,
  });

  // Mark connector_status for both providers (single Google grant covers both)
  const { error: statusError } = await supabaseAdmin
    .from("connector_status")
    .upsert(
      [
        { user_id: opts.userId, provider: "gmail" },
        { user_id: opts.userId, provider: "google_calendar" },
      ],
      { onConflict: "user_id,provider" },
    );
  if (statusError) throw dbError("save your Google connection", statusError);
  return { email };
}
