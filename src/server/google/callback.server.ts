// Server-only handler for Google's OAuth redirect (GET /api/public/google/callback).
// Kept out of the route file so the whole callback can be tested against mocked Google endpoints.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { getErrorMessage } from "@/lib/errors";
import {
  exchangeCodeForTokens,
  fetchGoogleUserEmail,
  storeTokens,
  verifySignedOAuthState,
} from "./oauth.server";

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

  const origin = `${url.protocol}//${url.host}`;
  try {
    const tokens = await exchangeCodeForTokens(code, origin);
    const email = await fetchGoogleUserEmail(tokens.access_token);
    await storeTokens({
      userId: state.uid,
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
          { user_id: state.uid, provider: "gmail" },
          { user_id: state.uid, provider: "google_calendar" },
        ],
        { onConflict: "user_id,provider" },
      );
    if (statusError) throw statusError;
  } catch (e: unknown) {
    return htmlError(getErrorMessage(e, "Token exchange failed."));
  }

  const back = state.rt.startsWith("/") ? state.rt : "/onboarding/connectors";
  return Response.redirect(`${origin}${back}?google=connected`, 302);
}
