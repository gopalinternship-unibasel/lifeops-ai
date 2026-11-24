/**
 * The Google connector, exercised offline: every Google endpoint (OAuth token, userinfo,
 * Calendar, Gmail) is a mocked fetch, and the server-side Supabase client is an in-memory fake.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

/** Minimal in-memory stand-in for the parts of the Supabase query builder the code uses. */
const db = vi.hoisted(() => {
  const tables = new Map<string, Row[]>();
  const writes: { table: string; op: string; payload: unknown }[] = [];

  function from(table: string) {
    const filters: [string, unknown][] = [];
    let op: "select" | "update" | "delete" = "select";
    let updatePayload: Row = {};
    const rows = () => tables.get(table) ?? [];
    const matches = (row: Row) => filters.every(([col, val]) => row[col] === val);

    const run = async () => {
      if (op === "update") {
        writes.push({ table, op, payload: updatePayload });
        for (const row of rows()) if (matches(row)) Object.assign(row, updatePayload);
        return { data: null, error: null };
      }
      if (op === "delete") {
        writes.push({ table, op, payload: Object.fromEntries(filters) });
        tables.set(table, rows().filter((row) => !matches(row)));
        return { data: null, error: null };
      }
      return { data: rows().filter(matches), error: null };
    };

    const builder = {
      select: () => builder,
      eq: (col: string, val: unknown) => {
        filters.push([col, val]);
        return builder;
      },
      in: () => builder,
      update: (payload: Row) => {
        op = "update";
        updatePayload = payload;
        return builder;
      },
      delete: () => {
        op = "delete";
        return builder;
      },
      maybeSingle: async () => {
        const { data } = await run();
        return { data: Array.isArray(data) ? (data[0] ?? null) : null, error: null };
      },
      upsert: async (payload: Row | Row[], opts?: { onConflict?: string }) => {
        writes.push({ table, op: "upsert", payload });
        const keys = (opts?.onConflict ?? "user_id").split(",");
        for (const item of Array.isArray(payload) ? payload : [payload]) {
          const existing = rows().find((row) => keys.every((key) => row[key] === item[key]));
          if (existing) Object.assign(existing, item);
          else tables.set(table, [...rows(), { ...item }]);
        }
        return { error: null };
      },
      then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => run().then(resolve, reject),
    };
    return builder;
  }

  return { tables, writes, client: { from } };
});

vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: db.client }));

import {
  assertGoogleOAuthConfigured,
  buildAuthUrl,
  createSignedOAuthState,
  getValidAccessToken,
  googleOAuthConfigStatus,
  GoogleOAuthNotConfiguredError,
  GOOGLE_SCOPES,
  newBrowserKey,
  verifySignedOAuthState,
} from "@/server/google/oauth.server";
import { completeGoogleConnection, handleGoogleOAuthCallback } from "@/server/google/callback.server";
import {
  deleteCalendarEvent,
  EVENT_GONE,
  getCalendarEvent,
  insertCalendarEvent,
  listCalendarEvents,
  patchCalendarEvent,
} from "@/server/google/calendar.server";
import { createDraft, createDraftReply, listRecentMessages } from "@/server/google/gmail.server";

const USER = "11111111-2222-3333-4444-555555555555";
const ORIGIN = "http://localhost:5190";
/** The key the starting browser keeps (sessionStorage); the state holds only its hash. */
const KEY = "browser-key-of-the-tab-that-started-the-sign-in";

type FetchCall = { url: string; init: RequestInit };
let calls: FetchCall[] = [];

/** Route mocked fetches by URL prefix; unknown URLs fail the test loudly. */
function mockGoogle(routes: Record<string, (call: FetchCall) => Response | Promise<Response>>) {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init: RequestInit = {}) => {
      const url = String(input);
      const call = { url, init };
      calls.push(call);
      const match = Object.keys(routes).find((prefix) => url.startsWith(prefix));
      if (!match) throw new Error(`Unexpected request to ${url}`);
      return routes[match](call);
    }),
  );
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function decodeRaw(raw: string) {
  return Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

beforeEach(() => {
  vi.stubEnv("GOOGLE_OAUTH_CLIENT_ID", "test-client.apps.googleusercontent.com");
  vi.stubEnv("GOOGLE_OAUTH_CLIENT_SECRET", "test-client-secret");
  vi.stubEnv("GOOGLE_OAUTH_STATE_SECRET", "x".repeat(48));
  vi.stubEnv("GOOGLE_OAUTH_REDIRECT_URI", "");
  db.tables.clear();
  db.writes.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("configuration", () => {
  it("reports which settings are missing without exposing values", () => {
    const status = googleOAuthConfigStatus({ GOOGLE_OAUTH_STATE_SECRET: "short" });
    expect(status.configured).toBe(false);
    expect(status.missing).toEqual([
      "GOOGLE_OAUTH_CLIENT_ID",
      "GOOGLE_OAUTH_CLIENT_SECRET",
      "GOOGLE_OAUTH_STATE_SECRET (at least 32 characters)",
    ]);
    // The message reaches visitors: no setting names, no repository files; those stay in the log.
    const error = new GoogleOAuthNotConfiguredError(["GOOGLE_OAUTH_CLIENT_ID"]);
    expect(error.message).toMatch(/not available on this site yet/);
    expect(error.message).not.toMatch(/GOOGLE_OAUTH_|RUNNING\.md|server/);
    expect(error.missing).toEqual(["GOOGLE_OAUTH_CLIENT_ID"]);
  });

  it("names the missing settings in the server log only", () => {
    vi.stubEnv("GOOGLE_OAUTH_CLIENT_ID", "");
    vi.stubEnv("GOOGLE_OAUTH_CLIENT_SECRET", "");
    vi.stubEnv("GOOGLE_OAUTH_STATE_SECRET", "");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let thrown: unknown;
    try {
      assertGoogleOAuthConfigured();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(GoogleOAuthNotConfiguredError);
    expect((thrown as GoogleOAuthNotConfiguredError).message).not.toMatch(/GOOGLE_OAUTH_|RUNNING\.md/);
    expect((thrown as GoogleOAuthNotConfiguredError).missing).toEqual([
      "GOOGLE_OAUTH_CLIENT_ID",
      "GOOGLE_OAUTH_CLIENT_SECRET",
      "GOOGLE_OAUTH_STATE_SECRET",
    ]);
    expect(String(warn.mock.calls[0]?.[0])).toContain("GOOGLE_OAUTH_CLIENT_ID");
  });

  it("builds the consent URL with offline access, the exact redirect URI and the scopes", async () => {
    const state = await createSignedOAuthState({ userId: USER, returnTo: "/onboarding/connectors", browserKey: KEY });
    const url = new URL(buildAuthUrl({ origin: ORIGIN, state }));
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("client_id")).toBe("test-client.apps.googleusercontent.com");
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:5190/api/public/google/callback");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("state")).toBe(state);
    expect(url.searchParams.get("scope")?.split(" ")).toEqual(GOOGLE_SCOPES);
    expect(GOOGLE_SCOPES).toContain("https://www.googleapis.com/auth/gmail.compose");
    expect(GOOGLE_SCOPES).not.toContain("https://www.googleapis.com/auth/gmail.send");
  });

  it("uses GOOGLE_OAUTH_REDIRECT_URI when the public URL differs", () => {
    vi.stubEnv("GOOGLE_OAUTH_REDIRECT_URI", "https://monday.example.com/api/public/google/callback");
    const url = new URL(buildAuthUrl({ origin: ORIGIN, state: "s" }));
    expect(url.searchParams.get("redirect_uri")).toBe("https://monday.example.com/api/public/google/callback");
  });
});

describe("signed OAuth state", () => {
  it("round-trips and keeps only same-site return paths", async () => {
    const good = await verifySignedOAuthState(await createSignedOAuthState({ userId: USER, returnTo: "/app/profile", browserKey: KEY }));
    expect(good?.uid).toBe(USER);
    expect(good?.rt).toBe("/app/profile");
    const evil = await verifySignedOAuthState(await createSignedOAuthState({ userId: USER, returnTo: "//evil.example", browserKey: KEY }));
    expect(evil?.rt).toBe("/onboarding/connectors");
  });

  it("carries only a hash of the browser key, never the key itself", async () => {
    const key = newBrowserKey();
    expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newBrowserKey()).not.toBe(key);
    const state = await createSignedOAuthState({ userId: USER, browserKey: key });
    const payload = Buffer.from(state.split(".")[0], "base64url").toString("utf8");
    expect(payload).not.toContain(key);
    expect((await verifySignedOAuthState(state))?.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("rejects tampered, foreign and expired states", async () => {
    const state = await createSignedOAuthState({ userId: USER, browserKey: KEY });
    const [payload, signature] = state.split(".");
    const forged = Buffer.from(JSON.stringify({ uid: "someone-else", rt: "/", exp: Date.now() + 60_000, nonce: "n" }))
      .toString("base64url");
    expect(await verifySignedOAuthState(`${forged}.${signature}`)).toBeNull();
    expect(await verifySignedOAuthState(`${payload}.${signature.slice(0, -2)}xx`)).toBeNull();
    expect(await verifySignedOAuthState(`${state}.extra`)).toBeNull();

    vi.stubEnv("GOOGLE_OAUTH_STATE_SECRET", "y".repeat(48));
    expect(await verifySignedOAuthState(state)).toBeNull();
    vi.stubEnv("GOOGLE_OAUTH_STATE_SECRET", "x".repeat(48));

    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 11 * 60 * 1000);
    expect(await verifySignedOAuthState(state)).toBeNull();
  });
});

describe("OAuth callback", () => {
  it("hands the code and state to the connectors page and stores nothing itself", async () => {
    mockGoogle({});
    const state = await createSignedOAuthState({ userId: USER, returnTo: "/onboarding/connectors", browserKey: KEY });

    const res = await handleGoogleOAuthCallback(
      new Request(`${ORIGIN}/api/public/google/callback?code=auth-code-1&state=${encodeURIComponent(state)}`),
    );

    expect(res.status).toBe(302);
    const location = new URL(String(res.headers.get("location")));
    expect(location.origin + location.pathname).toBe(`${ORIGIN}/onboarding/connectors`);
    expect(location.searchParams.get("google_code")).toBe("auth-code-1");
    expect(location.searchParams.get("google_state")).toBe(state);
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    // A bare GET carries no MONDAY session, so it must not exchange the code or store tokens.
    expect(calls).toHaveLength(0);
    expect(db.tables.get("google_oauth_tokens")).toBeUndefined();
    expect(db.tables.get("connector_status")).toBeUndefined();
  });

  it("refuses a forged state and surfaces Google errors as a page, not a crash", async () => {
    mockGoogle({});
    const forged = await handleGoogleOAuthCallback(new Request(`${ORIGIN}/api/public/google/callback?code=c&state=abc.def`));
    expect(forged.status).toBe(400);
    expect(await forged.text()).toContain("Invalid state.");
    const denied = await handleGoogleOAuthCallback(new Request(`${ORIGIN}/api/public/google/callback?error=access_denied`));
    expect(await denied.text()).toContain("Google returned: access_denied");
    expect(calls).toHaveLength(0);
    expect(db.tables.get("google_oauth_tokens")).toBeUndefined();
  });
});

describe("finishing a Google sign-in (completeGoogleConnection)", () => {
  const ATTACKER = "99999999-8888-7777-6666-555555555555";
  const tokenRoutes = () => ({
    "https://oauth2.googleapis.com/token": () =>
      json({ access_token: "at-1", refresh_token: "rt-1", expires_in: 3600, scope: GOOGLE_SCOPES.join(" "), token_type: "Bearer" }),
    "https://openidconnect.googleapis.com/v1/userinfo": () => json({ email: "tester@example.com" }),
  });

  it("exchanges the code, stores the tokens for the signed-in user and marks both connectors", async () => {
    mockGoogle(tokenRoutes());
    const state = await createSignedOAuthState({ userId: USER, returnTo: "/onboarding/connectors", browserKey: KEY });
    const before = Date.now();

    const result = await completeGoogleConnection({ userId: USER, code: "auth-code-1", state, browserKey: KEY, origin: ORIGIN });

    expect(result).toEqual({ email: "tester@example.com" });
    const tokenCall = calls.find((call) => call.url === "https://oauth2.googleapis.com/token");
    const form = new URLSearchParams(String(tokenCall?.init.body));
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("code")).toBe("auth-code-1");
    expect(form.get("redirect_uri")).toBe(`${ORIGIN}/api/public/google/callback`);
    expect(form.get("client_secret")).toBe("test-client-secret");

    const stored = db.tables.get("google_oauth_tokens")?.[0];
    expect(stored).toMatchObject({ user_id: USER, access_token: "at-1", refresh_token: "rt-1", google_email: "tester@example.com" });
    const expiresAt = new Date(String(stored?.expires_at)).getTime();
    expect(expiresAt).toBeGreaterThanOrEqual(before + 3600_000 - 1000);
    expect(db.tables.get("connector_status")?.map((row) => row.provider).sort()).toEqual(["gmail", "google_calendar"]);
  });

  it("refuses an attacker's state finished by someone else's account (OAuth CSRF)", async () => {
    // The attacker starts a sign-in for their own account and sends the consent link to a victim.
    // The victim's browser comes back with the attacker's state while signed in as the victim.
    mockGoogle(tokenRoutes());
    vi.spyOn(console, "error").mockImplementation(() => {});
    const attackerState = await createSignedOAuthState({ userId: ATTACKER, browserKey: "attacker-key" });

    await expect(
      completeGoogleConnection({ userId: USER, code: "victim-code", state: attackerState, browserKey: "", origin: ORIGIN }),
    ).rejects.toThrow(/started from a different MONDAY account/);
    // Even with the attacker's own key, another account cannot finish it.
    await expect(
      completeGoogleConnection({ userId: USER, code: "victim-code", state: attackerState, browserKey: "attacker-key", origin: ORIGIN }),
    ).rejects.toThrow(/different MONDAY account/);
    expect(calls).toHaveLength(0);
    expect(db.tables.get("google_oauth_tokens")).toBeUndefined();
    expect(db.tables.get("connector_status")).toBeUndefined();
  });

  it("refuses a state finished in a browser that did not start it", async () => {
    mockGoogle(tokenRoutes());
    vi.spyOn(console, "error").mockImplementation(() => {});
    const state = await createSignedOAuthState({ userId: USER, browserKey: KEY });
    for (const browserKey of ["", "some-other-key", `${KEY}x`]) {
      await expect(
        completeGoogleConnection({ userId: USER, code: "c", state, browserKey, origin: ORIGIN }),
      ).rejects.toThrow(/started in a different browser or tab/);
    }
    expect(calls).toHaveLength(0);
    expect(db.tables.get("google_oauth_tokens")).toBeUndefined();
  });

  it("refuses forged and expired states before calling Google", async () => {
    mockGoogle(tokenRoutes());
    const state = await createSignedOAuthState({ userId: USER, browserKey: KEY });
    await expect(
      completeGoogleConnection({ userId: USER, code: "c", state: "abc.def", browserKey: KEY, origin: ORIGIN }),
    ).rejects.toThrow(/expired or is not valid/);
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 11 * 60 * 1000);
    await expect(
      completeGoogleConnection({ userId: USER, code: "c", state, browserKey: KEY, origin: ORIGIN }),
    ).rejects.toThrow(/expired or is not valid/);
    expect(calls).toHaveLength(0);
  });

  it("reports a refused code (expired or used before) in plain words, without storing anything", async () => {
    mockGoogle({ "https://oauth2.googleapis.com/token": () => json({ error: "invalid_grant", error_description: "Bad Request" }, 400) });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const state = await createSignedOAuthState({ userId: USER, browserKey: KEY });
    const failure = completeGoogleConnection({ userId: USER, code: "used-code", state, browserKey: KEY, origin: ORIGIN });
    await expect(failure).rejects.toThrow(/Google did not accept this sign-in/);
    await expect(failure).rejects.not.toThrow(/invalid_grant|400/);
    expect(String(logged.mock.calls[0]?.[0])).toContain("invalid_grant");
    expect(db.tables.get("google_oauth_tokens")).toBeUndefined();
  });
});

describe("token refresh", () => {
  it("returns a still-valid access token without calling Google", async () => {
    db.tables.set("google_oauth_tokens", [
      { user_id: USER, access_token: "fresh", refresh_token: "rt", expires_at: new Date(Date.now() + 30 * 60_000).toISOString(), google_email: "t@example.com" },
    ]);
    mockGoogle({});
    expect(await getValidAccessToken(USER)).toEqual({ accessToken: "fresh", email: "t@example.com" });
    expect(calls).toHaveLength(0);
  });

  it("refreshes an expiring token with the refresh token and saves the new expiry", async () => {
    db.tables.set("google_oauth_tokens", [
      { user_id: USER, access_token: "old", refresh_token: "rt-9", expires_at: new Date(Date.now() + 10_000).toISOString(), google_email: null },
    ]);
    mockGoogle({ "https://oauth2.googleapis.com/token": () => json({ access_token: "new-at", expires_in: 3599, scope: "s", token_type: "Bearer" }) });

    const token = await getValidAccessToken(USER);

    expect(token.accessToken).toBe("new-at");
    const form = new URLSearchParams(String(calls[0].init.body));
    expect(form.get("grant_type")).toBe("refresh_token");
    expect(form.get("refresh_token")).toBe("rt-9");
    const row = db.tables.get("google_oauth_tokens")?.[0];
    expect(row?.access_token).toBe("new-at");
    expect(new Date(String(row?.expires_at)).getTime()).toBeGreaterThan(Date.now() + 3500_000);
  });

  it("treats a user without tokens as not connected", async () => {
    mockGoogle({});
    await expect(getValidAccessToken(USER)).rejects.toThrow("GOOGLE_NOT_CONNECTED");
  });
});

describe("Calendar and Gmail calls", () => {
  beforeEach(() => {
    db.tables.set("google_oauth_tokens", [
      { user_id: USER, access_token: "at-live", refresh_token: "rt", expires_at: new Date(Date.now() + 3600_000).toISOString(), google_email: null },
    ]);
  });

  it("creates a calendar event with the user's bearer token", async () => {
    mockGoogle({
      "https://www.googleapis.com/calendar/v3/calendars/primary/events": ({ init }) => {
        const body = JSON.parse(String(init.body));
        return json({ id: "evt-1", summary: body.summary, start: body.start, end: body.end });
      },
    });
    const ev = await insertCalendarEvent(USER, {
      title: "Deep work",
      starts_at: "2026-11-10T08:00:00.000Z",
      ends_at: "2026-11-10T09:30:00.000Z",
    });
    expect(ev).toMatchObject({ id: "evt-1", title: "Deep work", starts_at: "2026-11-10T08:00:00.000Z" });
    expect(calls[0].init.method).toBe("POST");
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer at-live");
  });

  it("reads availability and marks all-day and free events as non-blocking", async () => {
    mockGoogle({
      "https://www.googleapis.com/calendar/v3/calendars/primary/events": () =>
        json({
          items: [
            { id: "1", summary: "Standup", start: { dateTime: "2026-11-10T09:00:00+01:00" }, end: { dateTime: "2026-11-10T09:15:00+01:00" } },
            { id: "2", summary: "Birthday", start: { date: "2026-11-10" }, end: { date: "2026-11-11" } },
            { id: "3", summary: "Optional talk", transparency: "transparent", start: { dateTime: "2026-11-10T12:00:00+01:00" }, end: { dateTime: "2026-11-10T13:00:00+01:00" } },
          ],
        }),
    });
    const events = await listCalendarEvents(USER, "2026-11-10T00:00:00Z", "2026-11-11T00:00:00Z");
    expect(events.map((e) => [e.title, e.busy])).toEqual([
      ["Standup", true],
      ["Birthday", false],
      ["Optional talk", false],
    ]);
    const url = new URL(calls[0].url);
    expect(url.searchParams.get("singleEvents")).toBe("true");
    expect(url.searchParams.get("timeMin")).toBe("2026-11-10T00:00:00Z");
  });

  it("saves replies as Gmail drafts in the original thread and never calls a send endpoint", async () => {
    mockGoogle({
      "https://gmail.googleapis.com/gmail/v1/users/me/messages/msg%2F1": () =>
        json({
          threadId: "thread-7",
          payload: {
            headers: [
              { name: "From", value: "Prof. Marlow <marlow@university.edu>" },
              { name: "Subject", value: "Final draft\r\nBcc: attacker@example.com" },
              { name: "Message-ID", value: "<m1@university.edu>" },
            ],
          },
        }),
      "https://gmail.googleapis.com/gmail/v1/users/me/drafts": () => json({ id: "draft-42" }),
    });

    const draft = await createDraftReply(USER, { messageId: "msg/1", replyBody: "Thanks, I will send it Friday." });

    expect(draft).toEqual({ draftId: "draft-42", subject: "Final draft\r\nBcc: attacker@example.com", to: "Prof. Marlow <marlow@university.edu>" });
    expect(calls.map((call) => call.url).some((url) => url.includes("/send"))).toBe(false);
    const draftCall = calls.find((call) => call.url.endsWith("/drafts"));
    const body = JSON.parse(String(draftCall?.init.body));
    expect(body.message.threadId).toBe("thread-7");
    const mime = decodeRaw(body.message.raw);
    expect(mime).toContain("In-Reply-To: <m1@university.edu>");
    // The header-injection attempt is flattened into the subject line.
    expect(mime).toContain("Subject: Re: Final draft Bcc: attacker@example.com\r\n");
    expect(mime).not.toMatch(/^Bcc:/m);
    expect(mime.endsWith("Thanks, I will send it Friday.")).toBe(true);
  });

  it("creates planner emails as new drafts only", async () => {
    mockGoogle({ "https://gmail.googleapis.com/gmail/v1/users/me/drafts": () => json({ id: "draft-7" }) });
    const draft = await createDraft(USER, { to: "organizer@example.com", subject: "Reschedule", body: "Could we move it?" });
    expect(draft.draftId).toBe("draft-7");
    expect(calls).toHaveLength(1);
    const mime = decodeRaw(JSON.parse(String(calls[0].init.body)).message.raw);
    expect(mime).toContain("To: organizer@example.com");
    expect(mime).toContain("Subject: Reschedule\r\n");
  });

  it("a planner email without a known recipient becomes a draft without a To header", async () => {
    // The planner keeps only addresses the user wrote; "(recipient to fill in)" is not an address.
    mockGoogle({ "https://gmail.googleapis.com/gmail/v1/users/me/drafts": () => json({ id: "draft-8" }) });
    await createDraft(USER, { to: "(recipient to fill in)", subject: "Lunch", body: "Hi Sam" });
    const mime = decodeRaw(JSON.parse(String(calls[0].init.body)).message.raw);
    expect(mime).not.toContain("To:");
    expect(mime.startsWith("Subject: Lunch\r\n")).toBe(true);
  });
});

describe("Google API failures reach users as sentences, never as Google's raw answer", () => {
  const RAW = '{"error":{"code":403,"message":"Request had insufficient authentication scopes.","status":"PERMISSION_DENIED"}}';

  beforeEach(() => {
    db.tables.set("google_oauth_tokens", [
      { user_id: USER, access_token: "at-live", refresh_token: "rt", expires_at: new Date(Date.now() + 3600_000).toISOString(), google_email: null },
    ]);
  });

  it("Calendar: an error answer is logged and the user reads a sentence", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    mockGoogle({ "https://www.googleapis.com/calendar/v3/calendars/primary/events": () => new Response(RAW, { status: 500 }) });
    const failure = listCalendarEvents(USER, "2026-11-10T00:00:00Z", "2026-11-11T00:00:00Z");
    await expect(failure).rejects.toThrow("Google Calendar could not load your events right now (HTTP 500). Please try again in a moment.");
    await expect(failure).rejects.not.toThrow(/insufficient|PERMISSION_DENIED|[{}]/);
    expect(logged.mock.calls.map((call) => String(call[0])).join(" ")).toContain("insufficient authentication scopes");

    mockGoogle({ "https://www.googleapis.com/calendar/v3/calendars/primary/events": () => new Response(RAW, { status: 403 }) });
    await expect(
      insertCalendarEvent(USER, { title: "x", starts_at: "2026-11-10T08:00:00Z", ends_at: "2026-11-10T09:00:00Z" }),
    ).rejects.toThrow("Google Calendar did not allow MONDAY to add the event. Please connect Google again from your profile.");
  });

  it("Calendar: a network failure is a sentence, not 'fetch failed'", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mockGoogle({
      "https://www.googleapis.com/calendar/v3/calendars/primary/events": () => {
        throw new TypeError("fetch failed");
      },
    });
    await expect(deleteCalendarEvent(USER, "evt-1")).rejects.toThrow(
      "Google Calendar could not be reached to cancel the event. Please try again in a moment.",
    );
  });

  it("Calendar: reads one event, and a deleted or cancelled one is null", async () => {
    mockGoogle({
      "https://www.googleapis.com/calendar/v3/calendars/primary/events/evt-1": () =>
        json({ id: "evt-1", summary: "Standup", start: { dateTime: "2026-11-10T09:00:00+01:00" }, end: { dateTime: "2026-11-10T09:15:00+01:00" } }),
      "https://www.googleapis.com/calendar/v3/calendars/primary/events/gone": () => json({ error: { code: 404 } }, 404),
      "https://www.googleapis.com/calendar/v3/calendars/primary/events/cancelled": () =>
        json({ id: "cancelled", status: "cancelled" }),
    });
    expect(await getCalendarEvent(USER, "evt-1")).toMatchObject({
      id: "evt-1",
      starts_at: "2026-11-10T09:00:00+01:00",
      ends_at: "2026-11-10T09:15:00+01:00",
    });
    expect(await getCalendarEvent(USER, "gone")).toBeNull();
    expect(await getCalendarEvent(USER, "cancelled")).toBeNull();
  });

  it("Calendar: moving an event that is gone says so", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mockGoogle({ "https://www.googleapis.com/calendar/v3/calendars/primary/events/gone": () => json({ error: { code: 404 } }, 404) });
    await expect(patchCalendarEvent(USER, "gone", { title: "x" })).rejects.toThrow(EVENT_GONE);
  });

  it("Gmail: an error answer is logged and the user reads a sentence", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mockGoogle({ "https://gmail.googleapis.com/gmail/v1/users/me/drafts": () => new Response(RAW, { status: 500 }) });
    const failure = createDraft(USER, { to: "a@example.com", subject: "s", body: "b" });
    await expect(failure).rejects.toThrow("Gmail could not save the draft right now (HTTP 500). Please try again in a moment.");
    await expect(failure).rejects.not.toThrow(/insufficient|[{}]/);

    mockGoogle({ "https://gmail.googleapis.com/gmail/v1/users/me/messages": () => new Response(RAW, { status: 403 }) });
    await expect(listRecentMessages(USER)).rejects.toThrow(
      "Gmail did not allow MONDAY to load your inbox. Please connect Google again from your profile.",
    );
  });

  it("a refused token renewal asks the user to connect again", async () => {
    db.tables.set("google_oauth_tokens", [
      { user_id: USER, access_token: "old", refresh_token: "revoked", expires_at: new Date(Date.now() + 10_000).toISOString(), google_email: null },
    ]);
    vi.spyOn(console, "error").mockImplementation(() => {});
    mockGoogle({ "https://oauth2.googleapis.com/token": () => json({ error: "invalid_grant" }, 400) });
    const failure = getValidAccessToken(USER);
    await expect(failure).rejects.toThrow(/connect Google again from your profile/);
    await expect(failure).rejects.not.toThrow(/invalid_grant|Token refresh failed/);
  });
});
