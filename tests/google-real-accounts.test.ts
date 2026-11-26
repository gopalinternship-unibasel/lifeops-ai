/**
 * Real Google accounts on the hosted site: tokens stored encrypted, demo sessions cannot connect,
 * the Testing-phase note, and the copy that tells visitors which inbox they are using.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth-context", () => ({ useAuth: () => ({ user: null, loading: true }) }));
vi.mock("@/functions/google.functions", () => ({
  chooseDemoData: vi.fn(),
  completeGoogleOAuth: vi.fn(),
  disconnectGoogle: vi.fn(),
  getGoogleConnectionStatus: vi.fn(),
  getGoogleOAuthUrl: vi.fn(),
}));
vi.mock("@/routes/onboarding.profile", () => ({ Stepper: () => null }));
vi.mock("@/components/GeometricBackdrop", () => ({ GeometricBackdrop: () => null }));
vi.mock("@/components/MondayMark", () => ({ MondayMark: () => null }));
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: {} }));

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ConnectorsView } from "@/routes/onboarding.connectors";
import {
  decryptToken,
  encryptToken,
  GoogleTokenUnreadableError,
  isEncryptedToken,
} from "@/server/google/token-crypto.server";
import { googleOAuthTesting, isAnonymousClaims } from "@/server/google/oauth.server";

const KEY_A = { GOOGLE_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64") };
const KEY_B = { GOOGLE_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64") };

describe("stored Google tokens", () => {
  it("are encrypted with the key and read back", async () => {
    const stored = await encryptToken("ya29.example-access-token", KEY_A);
    expect(isEncryptedToken(stored)).toBe(true);
    expect(stored).not.toContain("ya29");
    expect(await decryptToken(stored, KEY_A)).toBe("ya29.example-access-token");
  });

  it("use a fresh IV each time", async () => {
    const one = await encryptToken("same", KEY_A);
    const two = await encryptToken("same", KEY_A);
    expect(one).not.toBe(two);
  });

  it("stay plain without a key (local run) and older plain values are read as they are", async () => {
    expect(await encryptToken("plain-token", {})).toBe("plain-token");
    expect(await decryptToken("1//plain-refresh-token", KEY_A)).toBe("1//plain-refresh-token");
  });

  it("count as not connected when they cannot be decrypted", async () => {
    const stored = await encryptToken("secret", KEY_A);
    await expect(decryptToken(stored, KEY_B)).rejects.toBeInstanceOf(GoogleTokenUnreadableError);
    await expect(decryptToken(stored, {})).rejects.toThrow("GOOGLE_NOT_CONNECTED");
    await expect(decryptToken("enc:v1:broken", KEY_A)).rejects.toBeInstanceOf(GoogleTokenUnreadableError);
  });

  it("refuse a key of the wrong length", async () => {
    await expect(encryptToken("x", { GOOGLE_TOKEN_ENCRYPTION_KEY: "c2hvcnQ=" })).rejects.toThrow(/32 bytes/);
  });
});

describe("who may connect Google", () => {
  it("reads the anonymous flag from the token claims", () => {
    expect(isAnonymousClaims({ sub: "u1", is_anonymous: true })).toBe(true);
    expect(isAnonymousClaims({ sub: "u1", is_anonymous: false })).toBe(false);
    expect(isAnonymousClaims({ sub: "u1" })).toBe(false);
    expect(isAnonymousClaims(null)).toBe(false);
  });

  it("knows Google's testing phase from GOOGLE_OAUTH_TESTING", () => {
    expect(googleOAuthTesting({ GOOGLE_OAUTH_TESTING: "true" })).toBe(true);
    expect(googleOAuthTesting({ GOOGLE_OAUTH_TESTING: "TRUE " })).toBe(true);
    expect(googleOAuthTesting({})).toBe(false);
  });

  it("refuses demo sessions on the server for both steps of the sign-in", () => {
    const fns = readFileSync(new URL("../src/functions/google.functions.ts", import.meta.url), "utf8");
    const refusals = fns.match(/if \(isAnonymousClaims\(context\.claims\)\) throw new Error\(ANONYMOUS_GOOGLE_MESSAGE\);/g) ?? [];
    expect(refusals).toHaveLength(2);
  });
});

/** The attributes of the "Connect Google" button in the markup. */
function connectButtonAttrs(html: string): string {
  const match = html.match(/<button([^>]*)>(?:(?!<\/button>)[\s\S])*Connect Google<\/button>/);
  if (!match) throw new Error("no Connect Google button");
  return match[1];
}

function renderPage(state: { isAnonymous: boolean; oauthTesting: boolean; oauthConfigured?: boolean }): string {
  const noop = () => {};
  return renderToStaticMarkup(
    createElement(ConnectorsView, {
      connected: false,
      email: null,
      demoMode: false,
      oauthConfigured: state.oauthConfigured ?? true,
      oauthTesting: state.oauthTesting,
      oauthError: null,
      busy: false,
      isAnonymous: state.isAnonymous,
      onConnect: noop,
      onDisconnect: noop,
      onUseDemo: noop,
      onEnter: noop,
    }),
  );
}

describe("the connectors page with a Google client", () => {
  it("tells a demo session to create an account and keeps Connect off", () => {
    const html = renderPage({ isAnonymous: true, oauthTesting: true });
    expect(html).toContain('data-testid="google-needs-account"');
    expect(html).not.toContain('data-testid="google-testing-mode"');
    expect(connectButtonAttrs(html)).toContain('disabled=""');
  });

  it("explains the testing phase to an account and lets it connect", () => {
    const html = renderPage({ isAnonymous: false, oauthTesting: true });
    expect(html).toContain('data-testid="google-testing-mode"');
    expect(html).toContain("only Google accounts the owner has added");
    expect(html).not.toContain('data-testid="google-needs-account"');
    expect(connectButtonAttrs(html)).not.toContain('disabled=""');
  });

  it("shows no testing note once the app is out of testing", () => {
    expect(renderPage({ isAnonymous: false, oauthTesting: false })).not.toContain("google-testing-mode");
  });
});

describe("the copy on the hosted site", () => {
  const landing = readFileSync(new URL("../src/routes/index.tsx", import.meta.url), "utf8");
  const login = readFileSync(new URL("../src/routes/login.tsx", import.meta.url), "utf8");
  const privacy = readFileSync(new URL("../src/routes/privacy.tsx", import.meta.url), "utf8");

  it("says Google can be connected only where the site has a Google client", () => {
    expect(landing).toContain('const GOOGLE_CONNECT = import.meta.env.VITE_ENABLE_GOOGLE_CONNECT === "true";');
    expect(landing).toContain("Google users the owner has added as testers can connect their real Gmail and Google Calendar instead");
    expect(login).toContain('const googleConnect = import.meta.env.VITE_ENABLE_GOOGLE_CONNECT === "true";');
    expect(landing).toContain('to="/privacy"');
    expect(login).toContain('to="/privacy"');
  });

  it("has a Pages variant of the privacy page that does not claim Vercel hosting or Google sign-in", () => {
    expect(privacy).toContain('import { isStaticShellBuild } from "@/lib/static-shell";');
    expect(privacy).toContain("This GitHub Pages copy cannot connect a Google account");
    expect(privacy).toContain("GitHub Pages serves this copy's files");
  });

  it("states the privacy facts the code keeps", () => {
    expect(privacy).toContain("up to the first 4,000 characters");
    expect(privacy).toContain("from today up to 21 days ahead");
    expect(privacy).toContain("It has no way to send");
    expect(privacy).toContain("including the Limited Use requirements");
    const gmail = readFileSync(new URL("../src/server/google/gmail.server.ts", import.meta.url), "utf8");
    expect(gmail).toContain(".slice(0, 4000)");
    expect(gmail).not.toMatch(/messages\/send|drafts\/send/);
    const chat = readFileSync(new URL("../src/server/chat-turn.server.ts", import.meta.url), "utf8");
    expect(chat).toContain("const CALENDAR_DAYS = 21;");
  });
});
