/**
 * The connectors page's decisions (src/routes/onboarding.connectors.tsx), tested without a
 * browser: who may enter the workspace, and how the page reads Google's hand-off.
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

import { canEnterWorkspace, googleReturnParams } from "@/routes/onboarding.connectors";

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
