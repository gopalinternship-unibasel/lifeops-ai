/**
 * The connectors page (src/routes/onboarding.connectors.tsx), tested without a browser: its
 * markup for given connection states (rendered to HTML on the server), who may enter the
 * workspace, and how the page reads Google's hand-off.
 */
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

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  canEnterWorkspace,
  ConnectorsView,
  googleReturnParams,
} from "@/routes/onboarding.connectors";

/** The page's markup for a given connection state (no browser needed). */
function renderPage(state: {
  connected?: boolean;
  demoMode?: boolean;
  oauthConfigured: boolean;
  oauthError?: string | null;
  busy?: boolean;
  isAnonymous: boolean;
}): string {
  const noop = () => {};
  return renderToStaticMarkup(
    createElement(ConnectorsView, {
      connected: state.connected ?? false,
      email: null,
      demoMode: state.demoMode ?? false,
      oauthConfigured: state.oauthConfigured,
      oauthError: state.oauthError ?? null,
      busy: state.busy ?? false,
      isAnonymous: state.isAnonymous,
      onConnect: noop,
      onDisconnect: noop,
      onUseDemo: noop,
      onEnter: noop,
    }),
  );
}

/** The <button> whose text contains `label`. */
function button(html: string, label: string): string {
  const buttons = html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) ?? [];
  const found = buttons.find((markup) => markup.replace(/<[^>]+>/g, "").includes(label));
  if (!found) throw new Error(`No "${label}" button on the page`);
  return found;
}

const isDisabled = (markup: string) => /^<button\b[^>]*\sdisabled=""/.test(markup);

const HINT = "Connect Google or choose demo data to continue.";

describe("the rendered connectors page (finding 36)", () => {
  it("without a Google OAuth client: Connect Google is disabled and the notice explains why", () => {
    const html = renderPage({ oauthConfigured: false, isAnonymous: true });
    expect(isDisabled(button(html, "Connect Google"))).toBe(true);
    expect(html).toContain("Connecting a Google account is not available on this site yet.");
    expect(html).not.toMatch(/GOOGLE_OAUTH_|RUNNING\.md/);
  });

  it("an anonymous demo visitor can enter the workspace, with no 'connect first' hint", () => {
    const html = renderPage({ oauthConfigured: false, isAnonymous: true });
    expect(isDisabled(button(html, "Enter AI Workspace"))).toBe(false);
    expect(html).not.toContain(HINT);
  });

  it("with an OAuth client, Connect Google is enabled, and a signed-up user must connect or choose demo data first", () => {
    const html = renderPage({ oauthConfigured: true, isAnonymous: false });
    expect(isDisabled(button(html, "Connect Google"))).toBe(false);
    expect(html).not.toContain("not available on this site yet");
    expect(isDisabled(button(html, "Enter AI Workspace"))).toBe(true);
    expect(html).toContain(HINT);

    const withDemo = renderPage({ oauthConfigured: true, isAnonymous: false, demoMode: true });
    expect(isDisabled(button(withDemo, "Enter AI Workspace"))).toBe(false);
  });

  it("while a request runs, Connect Google is disabled; a failed sign-in shows its own sentence", () => {
    expect(
      isDisabled(
        button(
          renderPage({ oauthConfigured: true, isAnonymous: false, busy: true }),
          "Connect Google",
        ),
      ),
    ).toBe(true);
    const html = renderPage({
      oauthConfigured: true,
      isAnonymous: false,
      oauthError:
        "This Google sign-in has expired or is not valid. Please click Connect Google again.",
    });
    expect(html).toContain("This Google sign-in has expired or is not valid.");
  });
});

describe("Enter AI Workspace (finding 36)", () => {
  it("is open to an anonymous demo visitor, as the workspace itself is", () => {
    expect(canEnterWorkspace({ connected: false, demoMode: false, isAnonymous: true })).toBe(true);
  });

  it("is open after connecting Google or choosing demo data, and closed before", () => {
    expect(canEnterWorkspace({ connected: true, demoMode: false, isAnonymous: false })).toBe(true);
    expect(canEnterWorkspace({ connected: false, demoMode: true, isAnonymous: false })).toBe(true);
    expect(canEnterWorkspace({ connected: false, demoMode: false, isAnonymous: false })).toBe(
      false,
    );
  });
});

describe("Google's hand-off to the page (finding 98)", () => {
  it("reads the code and state the callback route passes on", () => {
    expect(googleReturnParams("?google_code=c-1&google_state=s.t")).toEqual({
      code: "c-1",
      state: "s.t",
    });
  });

  it("ignores anything else, including Supabase's own ?code= parameter", () => {
    expect(googleReturnParams("")).toBeNull();
    expect(googleReturnParams("?code=c&state=s")).toBeNull();
    expect(googleReturnParams("?google_code=c")).toBeNull();
    expect(googleReturnParams("?google=connected")).toBeNull();
  });
});
