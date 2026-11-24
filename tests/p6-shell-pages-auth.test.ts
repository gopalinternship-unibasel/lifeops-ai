import { describe, expect, it } from "vitest";
import { nextSession, signOutWarning } from "@/lib/auth-context";

const session = {
  access_token: "access-1",
  refresh_token: "refresh-1",
  expires_at: 1_800_000_000,
  token_type: "bearer",
  user: { id: "user-1", updated_at: "2026-11-24T08:00:00Z", email: "a@example.com" },
};

describe("auth session identity", () => {
  it("keeps the same session object when a tab return re-sends an identical copy", () => {
    // What auth-js emits as SIGNED_IN on every hidden -> visible change: a new parse of the
    // stored session. Keeping `prev` keeps `user` the same object, so the profile forms do not
    // reload and overwrite typed text.
    const copy = structuredClone(session);
    expect(nextSession(session, copy)).toBe(session);
  });

  it("takes the new session when the token, the user or the user's data changed", () => {
    const refreshed = { ...session, access_token: "access-2", expires_at: 1_800_003_600 };
    expect(nextSession(session, refreshed)).toBe(refreshed);
    const other = { ...session, user: { ...session.user, id: "user-2" } };
    expect(nextSession(session, other)).toBe(other);
    const updated = { ...session, user: { ...session.user, updated_at: "2026-11-24T09:00:00Z" } };
    expect(nextSession(session, updated)).toBe(updated);
  });

  it("follows sign-in and sign-out", () => {
    expect(nextSession(null, session)).toBe(session);
    expect(nextSession(session, null)).toBeNull();
    expect(nextSession(null, null)).toBeNull();
  });
});

describe("signing out of the demo", () => {
  it("warns an anonymous demo user that the session cannot be reopened", () => {
    expect(signOutWarning({ is_anonymous: true })).toMatch(/not be able to come back/);
    expect(signOutWarning({ is_anonymous: true })).toMatch(/new, empty session/);
  });

  it("signs a permanent account out without a warning", () => {
    expect(signOutWarning({ is_anonymous: false })).toBeNull();
    expect(signOutWarning({})).toBeNull();
    expect(signOutWarning(null)).toBeNull();
  });
});
