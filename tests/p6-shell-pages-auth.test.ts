import { describe, expect, it, vi } from "vitest";
import { createSignOutFlow, nextSession, signOutWarning } from "@/lib/auth-context";

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
    expect(nextSession(session, copy, "SIGNED_IN")).toBe(session);
    expect(nextSession(session, structuredClone(session), "INITIAL_SESSION")).toBe(session);
  });

  it("takes the new session when the token, the user or the user's data changed", () => {
    const refreshed = { ...session, access_token: "access-2", expires_at: 1_800_003_600 };
    expect(nextSession(session, refreshed, "SIGNED_IN")).toBe(refreshed);
    const other = { ...session, user: { ...session.user, id: "user-2" } };
    expect(nextSession(session, other, "SIGNED_IN")).toBe(other);
    const updated = { ...session, user: { ...session.user, updated_at: "2026-11-24T09:00:00Z" } };
    expect(nextSession(session, updated, "SIGNED_IN")).toBe(updated);
  });

  it("always takes the session of an event that reports a change, even an equal-looking one", () => {
    // A user change that did not bump updated_at must still reach the pages.
    for (const event of [
      "USER_UPDATED",
      "TOKEN_REFRESHED",
      "PASSWORD_RECOVERY",
      "MFA_CHALLENGE_VERIFIED",
    ] as const) {
      const copy = structuredClone(session);
      expect(nextSession(session, copy, event)).toBe(copy);
    }
  });

  it("follows sign-in and sign-out", () => {
    expect(nextSession(null, session, "SIGNED_IN")).toBe(session);
    expect(nextSession(session, null, "SIGNED_OUT")).toBeNull();
    expect(nextSession(null, null, "INITIAL_SESSION")).toBeNull();
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

describe("sign-out flow of the signed-in pages", () => {
  /** A sign-out call that finishes only when the test says so. */
  function pendingSignOut() {
    let finish!: () => void;
    let fail!: (error: Error) => void;
    const promise = new Promise<void>((resolve, reject) => {
      finish = resolve;
      fail = reject;
    });
    return { signOut: vi.fn(() => promise), finish, fail };
  }

  it("sends a visitor without a session to /login, and only once the session has loaded", () => {
    const flow = createSignOutFlow();
    expect(flow.guardRedirect(true, false)).toBeNull();
    expect(flow.guardRedirect(false, true)).toBeNull();
    expect(flow.guardRedirect(false, false)).toBe("/login");
  });

  it("ends a deliberate sign-out on the landing page, with no detour to /login", async () => {
    const flow = createSignOutFlow();
    const call = pendingSignOut();
    const goToLanding = vi.fn();
    const done = flow.signOut(call.signOut, goToLanding);
    expect(call.signOut).toHaveBeenCalledTimes(1);
    // Auth reports the session gone while the call is still running: the guard stays quiet.
    expect(flow.guardRedirect(false, false)).toBeNull();
    expect(goToLanding).not.toHaveBeenCalled();
    call.finish();
    await done;
    expect(goToLanding).toHaveBeenCalledTimes(1);
    expect(flow.guardRedirect(false, false)).toBeNull();
  });

  it("still leaves for the landing page when the sign-out call throws, without a rejection", async () => {
    // The Sign out button starts the flow with `void`, so a rejection here would be unhandled.
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const flow = createSignOutFlow();
    const call = pendingSignOut();
    const goToLanding = vi.fn();
    const done = flow.signOut(call.signOut, goToLanding);
    const failure = new Error("network down");
    call.fail(failure);
    await expect(done).resolves.toBeUndefined();
    expect(goToLanding).toHaveBeenCalledTimes(1);
    expect(logged).toHaveBeenCalledWith("Sign-out failed:", failure);
    // The guard stays quiet: the landing page decides where a still-signed-in visitor goes.
    expect(flow.guardRedirect(false, false)).toBeNull();
  });

  it("gives every layout its own flow, so an expired session in a new one still goes to /login", () => {
    const first = createSignOutFlow();
    void first.signOut(
      () => new Promise<void>(() => {}),
      () => {},
    );
    expect(first.guardRedirect(false, false)).toBeNull();
    expect(createSignOutFlow().guardRedirect(false, false)).toBe("/login");
  });
});
