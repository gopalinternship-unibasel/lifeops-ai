/**
 * The dashboard's planner client (src/server/lifeops-backend.server.ts), audit of 24 Nov 2026:
 *  - 65: a 5xx, a gateway page or a non-JSON answer did not start the in-app fallback, and the
 *    raw Vercel/FastAPI text reached the page ("Planner service: FUNCTION_INVOCATION_FAILED ...");
 *  - 71 / 6 / 52: visitors saw operator text ("rejected MONDAY's token ... Check
 *    LIFEOPS_BACKEND_TOKEN", the planner's address), and a hosted site without the URL used
 *    127.0.0.1:8010;
 *  - 77: a slow plan was given up while the planner still stored it (no deadline was sent);
 *  - 66: the planner was not told the user's busy times;
 *  - 68: the planner dashboard was read and forwarded without a bound;
 *  - 70: planner notes with parser text or setting names were shown as they came;
 *  - 100: the "Plan it" stale window (360 s) was longer than Vercel's 300 s limit;
 *  - 12: every planner failure read as "offline".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import {
  backend,
  backendBaseUrl,
  backendRequest,
  BackendUnavailableError,
  boundPlannerDashboard,
  busyForPlanner,
  HOSTED_REQUEST_LIMIT_MS,
  INTERRUPTED_TEXT,
  PLAN_ALREADY_RUNNING,
  planDeadlineIso,
  planRequestWindowMs,
  planTimeoutMs,
  plannerOfflineFrom,
  PLANNER_DASHBOARD_LIMIT,
  safePlannerNote,
  startPlanRequest,
  visitorSafeText,
} from "@/server/lifeops-backend.server";
import { maxChatTurnMs } from "@/server/chat-turn.server";

type Call = { url: string; init: RequestInit };
let calls: Call[] = [];

function answer(status: number, body: string, contentType = "application/json") {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init: RequestInit = {}) => {
      calls.push({ url: String(input), init });
      return new Response(body, { status, headers: { "content-type": contentType } });
    }),
  );
}

async function failure(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error: unknown) {
    return error as Error;
  }
  throw new Error("expected the request to fail");
}

const INTERNAL = /LIFEOPS_|127\.0\.0\.1|planner\.test|FUNCTION_INVOCATION|fra1|Traceback|<html|MONDAY's token|\[|\{/;

beforeEach(() => {
  vi.stubEnv("LIFEOPS_BACKEND_URL", "https://planner.test");
  vi.stubEnv("LIFEOPS_BACKEND_TOKEN", "");
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("planner failures on the hosted demo (visitor wording, in-app fallback)", () => {
  beforeEach(() => vi.stubEnv("LIFEOPS_HOSTED", "1"));

  it("a 500 from the platform is 'unavailable', without the raw body (65)", async () => {
    answer(500, "A server error has occurred\n\nFUNCTION_INVOCATION_FAILED\n\nfra1::abc-123", "text/plain");
    const error = await failure(backend.plan("u1", { user_input: "Plan my week", current_datetime: "2026-11-24T10:00:00", timezone: "Europe/Zurich" }));
    expect(error).toBeInstanceOf(BackendUnavailableError);
    expect((error as BackendUnavailableError).reason).toBe("failed");
    expect(error.message).toBe("The planner service is not available right now.");
    expect(error.message).not.toMatch(INTERNAL);
  });

  it("a 504 and a 502 gateway page are 'unavailable' too (65)", async () => {
    answer(504, "");
    expect(await failure(backendRequest("/api/plan", { userId: "u1", method: "POST", body: {} }))).toBeInstanceOf(BackendUnavailableError);
    answer(502, "<html><body>Bad gateway</body></html>", "text/html");
    const error = await failure(backendRequest("/api/plan", { userId: "u1", method: "POST", body: {} }));
    expect(error).toBeInstanceOf(BackendUnavailableError);
    expect(error.message).not.toMatch(INTERNAL);
  });

  it("an unknown route (FastAPI 'Not Found') is 'unavailable'; the service's own 404 is its sentence", async () => {
    answer(404, JSON.stringify({ detail: "Not Found" }));
    expect(await failure(backendRequest("/api/dashboard", { userId: "u1" }))).toBeInstanceOf(BackendUnavailableError);
    answer(404, JSON.stringify({ detail: "Action not found" }));
    const error = await failure(backend.action("u1", 9));
    expect(error).not.toBeInstanceOf(BackendUnavailableError);
    expect(error.message).toBe("The planner service could not do this: Action not found.");
  });

  it("keeps the service's refusal sentence for the approve and reject buttons (65)", async () => {
    answer(400, JSON.stringify({ detail: "Action is already executed" }));
    const error = await failure(backend.approve("u1", 3));
    expect(error).not.toBeInstanceOf(BackendUnavailableError);
    expect(error.message).toBe("The planner service could not do this: Action is already executed.");
  });

  it("a 422 with a list of issues shows no raw JSON (65)", async () => {
    answer(422, JSON.stringify({ detail: [{ loc: ["body", "user_input"], msg: "too short", type: "value_error" }] }));
    const error = await failure(backendRequest("/api/plan", { userId: "u1", method: "POST", body: {} }));
    expect(error.message).toBe("The planner service could not accept this request.");
    expect(error.message).not.toMatch(INTERNAL);
  });

  it("a 401 without a token says the service is not set up, and logs the real reason (71)", async () => {
    answer(401, JSON.stringify({ detail: "Missing or invalid LifeOps backend token" }));
    const error = await failure(backend.dashboard("u1"));
    expect(error).toBeInstanceOf(BackendUnavailableError);
    expect((error as BackendUnavailableError).reason).toBe("rejected");
    expect(error.message).toBe("The planner service is not set up correctly for this site.");
    expect(error.message).not.toMatch(/token|LIFEOPS_|rejected/i);
    expect(String(vi.mocked(console.error).mock.calls[0]?.[0])).toContain("HTTP 401");
  });

  it("a network failure names neither the address nor the fetch error (71)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("fetch failed"))));
    const error = await failure(backend.dashboard("u1"));
    expect(error).toBeInstanceOf(BackendUnavailableError);
    expect((error as BackendUnavailableError).reason).toBe("unreachable");
    expect(error.message).toBe("The planner service could not be reached.");
    expect(error.message).not.toMatch(/fetch failed|https?:/);
  });

  it("a timeout says the service was slow, not unreachable (77)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new DOMException("The operation was aborted due to timeout", "TimeoutError"))));
    vi.stubEnv("LIFEOPS_BACKEND_DASHBOARD_TIMEOUT_MS", "10000");
    const error = await failure(backend.dashboard("u1"));
    expect((error as BackendUnavailableError).reason).toBe("timeout");
    expect(error.message).toBe("The planner service did not answer within 10 s.");
  });

  it("a 200 that is not JSON is not taken as a result", async () => {
    answer(200, "<!doctype html><title>Vercel</title>", "text/html");
    expect(await failure(backend.dashboard("u1"))).toBeInstanceOf(BackendUnavailableError);
    answer(200, JSON.stringify({ ok: true }));
    expect(await failure(backend.plan("u1", { user_input: "Plan my week", current_datetime: "x", timezone: "UTC" }))).toBeInstanceOf(
      BackendUnavailableError,
    );
  });

  it("a hosted site without LIFEOPS_BACKEND_URL treats the planner as off (71, 6)", async () => {
    vi.stubEnv("LIFEOPS_BACKEND_URL", "");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const error = await failure(backend.dashboard("u1"));
    expect((error as BackendUnavailableError).reason).toBe("off");
    expect(error.message).toBe("The planner service is not set up on this site.");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("planner failures on a local run keep the developer hints", () => {
  it("names the setting for a missing token and the address for a refused connection", async () => {
    answer(401, JSON.stringify({ detail: "Missing or invalid LifeOps backend token" }));
    expect((await failure(backend.dashboard("u1"))).message).toBe(
      "The planner service needs a token: set LIFEOPS_BACKEND_TOKEN to the planner's token.",
    );
    vi.stubEnv("LIFEOPS_BACKEND_TOKEN", "secret");
    answer(401, "{}");
    expect((await failure(backend.dashboard("u1"))).message).toContain("rejected MONDAY's token");
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("fetch failed"))));
    expect((await failure(backend.dashboard("u1"))).message).toContain("https://planner.test is not reachable (fetch failed)");
  });
});

describe("backendBaseUrl", () => {
  it("defaults to 127.0.0.1:8010 only for a local run (71)", () => {
    expect(backendBaseUrl({}, false)).toBe("http://127.0.0.1:8010");
    expect(backendBaseUrl({}, true)).toBeNull();
    expect(backendBaseUrl({ LIFEOPS_HOSTED: "1" })).toBeNull();
    expect(backendBaseUrl({ LIFEOPS_BACKEND_URL: "https://planner.example/" }, true)).toBe("https://planner.example");
    expect(backendBaseUrl({ LIFEOPS_BACKEND_URL: "off" }, false)).toBeNull();
  });
});

describe("the plan request", () => {
  it("sends a deadline inside the client's own timeout, and the busy times (77, 66)", async () => {
    vi.stubEnv("LIFEOPS_BACKEND_TIMEOUT_MS", "60000");
    answer(200, JSON.stringify({ plan_run_id: 1, summary: "Plan", tasks_created: 1, actions_created: 0, executed_safe_actions: 0, planner: "demo", planner_note: null }));
    const before = Date.now();
    const busy = [{ title: "Lecture", start: "2026-11-25T10:00:00", end: "2026-11-25T12:00:00" }];
    await backend.plan("u1", { user_input: "Plan my week", current_datetime: "2026-11-24T10:00:00", timezone: "Europe/Zurich", busy });
    const body = JSON.parse(String(calls[0].init.body)) as { deadline: string; busy: unknown; autonomous_mode: boolean };
    const deadline = Date.parse(body.deadline);
    expect(deadline).toBeGreaterThan(before + 50_000);
    expect(deadline).toBeLessThan(Date.now() + planTimeoutMs());
    expect(body.busy).toEqual(busy);
    expect(body.autonomous_mode).toBe(false);
  });

  it("planDeadlineIso keeps a margin even for short timeouts", () => {
    expect(planDeadlineIso(0, 60_000)).toBe(new Date(57_000).toISOString());
    expect(planDeadlineIso(0, 4_000)).toBe(new Date(2_000).toISOString());
  });

  it("busy times are local wall-clock times in the user's zone, sorted and without free events (66)", () => {
    const events = [
      { title: "Dentist", starts_at: "2026-11-26T13:00:00Z", ends_at: "2026-11-26T14:30:00Z" },
      { title: "Lecture — Distributed Systems", starts_at: "2026-11-25T09:00:00.000Z", ends_at: "2026-11-25T11:00:00.000Z" },
      { title: "Holiday", starts_at: "2026-11-27T00:00:00Z", ends_at: "2026-11-28T00:00:00Z", busy: false },
      { title: "Broken", starts_at: "2026-11-27T10:00:00Z", ends_at: "2026-11-27T09:00:00Z" },
    ];
    expect(busyForPlanner(events, "Europe/Zurich")).toEqual([
      { title: "Lecture — Distributed Systems", start: "2026-11-25T10:00:00", end: "2026-11-25T12:00:00" },
      { title: "Dentist", start: "2026-11-26T14:00:00", end: "2026-11-26T15:30:00" },
    ]);
    const many = Array.from({ length: 250 }, (_, i) => ({
      title: "x".repeat(300),
      starts_at: new Date(Date.UTC(2026, 10, 25, 0, i)).toISOString(),
      ends_at: new Date(Date.UTC(2026, 10, 25, 0, i + 1)).toISOString(),
    }));
    const sent = busyForPlanner(many, "UTC");
    expect(sent).toHaveLength(200);
    expect(sent[0].title).toHaveLength(200);
  });
});

describe("the planner dashboard read (68)", () => {
  const action = (id: number) => ({ id, action_type: "task", title: `A${id}`, status: "pending" });

  it("asks for a bounded history", async () => {
    answer(200, JSON.stringify({ metrics: {}, tasks: [], actions: [], next_best_actions: [], last_plan: null }));
    await backend.dashboard("u1");
    expect(calls[0].url).toBe(`https://planner.test/api/dashboard?limit=${PLANNER_DASHBOARD_LIMIT}`);
  });

  it("bounds the answer itself when the planner ignores the limit, newest first", () => {
    const data = boundPlannerDashboard({
      metrics: { total_actions: 300, pending_actions: 300 },
      tasks: Array.from({ length: 120 }, (_, i) => ({ id: i + 1, title: `T${i}` })),
      actions: Array.from({ length: 300 }, (_, i) => action(i + 1)),
      next_best_actions: [],
      last_plan: null,
    });
    expect(data.actions).toHaveLength(PLANNER_DASHBOARD_LIMIT);
    expect(data.actions[0].id).toBe(300);
    expect(data.tasks).toHaveLength(PLANNER_DASHBOARD_LIMIT);
    expect(data.metrics.total_actions).toBe(300);
  });

  it("an answer without the lists counts as the service failing", () => {
    expect(() => boundPlannerDashboard({ status: 500, unhandled: true })).toThrow(BackendUnavailableError);
  });
});

describe("planner notes and stored texts (70, 6)", () => {
  it("replaces parser output and setting names with a plain sentence", () => {
    expect(safePlannerNote("No LLM configured (LLM_BASE_URL unset or PLANNER_MODE=keyword): keyword planner used.")).toBe(
      "No AI model is set up for the planner, so the keyword planner made this plan.",
    );
    for (const raw of [
      "The LLM planner failed (Expecting ',' delimiter: line 1 column 50 (char 49)); the keyword planner was used instead.",
      "The LLM planner failed (list index out of range); the keyword planner was used instead.",
    ]) {
      const note = safePlannerNote(raw);
      expect(note).toBe("The AI planner's answer could not be used this time, so the keyword planner made this plan.");
    }
  });

  it("keeps the planner's own readable notes", () => {
    const note = "Dropped calendar block 'Gym' without a valid time range. Read the model's times as local times (ignored a time zone offset).";
    expect(safePlannerNote(note)).toBe(note);
    expect(safePlannerNote("The LLM planner failed (the model did not answer within 45 s); the keyword planner was used instead.")).toContain(
      "within 45 s",
    );
    expect(safePlannerNote("Dropped action 'x' with invalid fields. Traceback (most recent call last):")).toBe(
      "Dropped action 'x' with invalid fields.",
    );
    expect(safePlannerNote("  ")).toBeNull();
  });

  it("hides stored developer text on the hosted demo only", () => {
    const old = "The planner service at https://lifeops-planner.vercel.app is not reachable (fetch failed).";
    expect(visitorSafeText(old, "The planner service was not available.", true)).toBe("The planner service was not available.");
    expect(visitorSafeText("Could not reach Ollama at http://localhost:11434/v1. docker ps", "Planning failed.", true)).toBe("Planning failed.");
    expect(visitorSafeText(old, "x", false)).toBe(old);
    const readable = "You have reached this demo's limit of 6 planner requests per hour. Please try again later.";
    expect(visitorSafeText(readable, "x", true)).toBe(readable);
  });
});

describe("the planner badge reason (12)", () => {
  it("tells off, unreachable and refused apart", () => {
    expect(plannerOfflineFrom(new BackendUnavailableError("x", "rejected")).reason).toBe("rejected");
    expect(plannerOfflineFrom(new BackendUnavailableError("y", "unreachable"))).toEqual({ reason: "unreachable", error: "y" });
    expect(plannerOfflineFrom(new Error("The planner service could not do this: nope."))).toEqual({
      reason: "failed",
      error: "The planner service could not do this: nope.",
    });
    expect(plannerOfflineFrom({ code: "XX", message: "raw" }).error).toBe("The planner service is not available right now.");
  });
});

describe("one 'Plan it' at a time (100, 11)", () => {
  type Row = Record<string, unknown>;
  const NOW = Date.parse("2026-11-24T10:00:00Z");
  const WINDOW = 300_000;

  /** planner_requests rows in memory, with the calls startPlanRequest makes; optionally the unique index. */
  function fakeRequests(rows: Row[], opts: { uniqueRunning?: boolean } = {}) {
    let nextId = 1;
    function from() {
      const filters: Array<(row: Row) => boolean> = [];
      let patch: Row | null = null;
      let insertRow: Row | null = null;
      const run = async (single: boolean) => {
        if (insertRow) {
          if (opts.uniqueRunning && rows.some((row) => row.user_id === insertRow?.user_id && row.status === "running")) {
            return { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } };
          }
          const row = { id: `r${nextId++}`, created_at: new Date(NOW).toISOString(), finished_at: null, result: null, error: null, ...insertRow };
          rows.push(row);
          return { data: row, error: null };
        }
        const matching = rows.filter((row) => filters.every((keep) => keep(row)));
        if (patch) {
          matching.forEach((row) => Object.assign(row, patch));
          return { data: null, error: null };
        }
        return { data: single ? (matching[0] ?? null) : matching, error: null };
      };
      const builder = {
        select: () => builder,
        update: (value: Row) => {
          patch = value;
          return builder;
        },
        insert: (value: Row) => {
          insertRow = value;
          return builder;
        },
        eq: (key: string, value: unknown) => {
          filters.push((row) => row[key] === value);
          return builder;
        },
        lt: (key: string, value: string) => {
          filters.push((row) => Date.parse(String(row[key])) < Date.parse(value));
          return builder;
        },
        gte: (key: string, value: string) => {
          filters.push((row) => Date.parse(String(row[key])) >= Date.parse(value));
          return builder;
        },
        limit: () => builder,
        single: () => run(true),
        maybeSingle: () => run(true),
        then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => run(false).then(resolve, reject),
      };
      return builder;
    }
    return { from } as unknown as SupabaseClient<Database>;
  }

  it("refuses a second request while one is running, before the allowance and the insert", async () => {
    const rows: Row[] = [{ id: "old", user_id: "u1", status: "running", created_at: new Date(NOW - 30_000).toISOString() }];
    const allowance = vi.fn(async () => {});
    await expect(startPlanRequest(fakeRequests(rows), "u1", "Plan my week", { windowMs: WINDOW, beforeInsert: allowance, nowMs: NOW })).rejects.toThrow(
      PLAN_ALREADY_RUNNING,
    );
    expect(allowance).not.toHaveBeenCalled();
    expect(rows).toHaveLength(1);
  });

  it("maps the unique index's 23505 (two tabs at once) to the same sentence", async () => {
    // The other tab's row appears between this request's check and its insert.
    const rows: Row[] = [];
    const allowance = vi.fn(async () => {
      rows.push({ id: "other", user_id: "u1", status: "running", created_at: new Date(NOW).toISOString() });
    });
    const error = await failure(
      startPlanRequest(fakeRequests(rows, { uniqueRunning: true }), "u1", "Plan my week", {
        windowMs: WINDOW,
        beforeInsert: allowance,
        nowMs: NOW,
      }),
    );
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe(PLAN_ALREADY_RUNNING);
    expect(error.message).not.toMatch(/23505|duplicate/);
  });

  it("closes a request the host cut off, so the unique index does not block the next one", async () => {
    const rows: Row[] = [{ id: "stale", user_id: "u1", status: "running", created_at: new Date(NOW - WINDOW - 1_000).toISOString() }];
    const row = await startPlanRequest(fakeRequests(rows, { uniqueRunning: true }), "u1", "Plan my week", { windowMs: WINDOW, nowMs: NOW });
    expect(row.status).toBe("running");
    expect(rows[0]).toMatchObject({ status: "failed", error: INTERRUPTED_TEXT });
    expect(rows.filter((r) => r.status === "running")).toHaveLength(1);
  });

  it("a refused allowance leaves no row; other users' requests do not count", async () => {
    const rows: Row[] = [{ id: "theirs", user_id: "u2", status: "running", created_at: new Date(NOW).toISOString() }];
    const refuse = vi.fn(async () => {
      throw new Error("You have reached this demo's limit of 6 planner requests per hour. Please try again later.");
    });
    await expect(startPlanRequest(fakeRequests(rows), "u1", "Plan my week", { windowMs: WINDOW, beforeInsert: refuse, nowMs: NOW })).rejects.toThrow(
      /limit of 6 planner requests/,
    );
    expect(rows).toHaveLength(1);
    const allowed = await startPlanRequest(fakeRequests(rows), "u1", "Plan my week", { windowMs: WINDOW, nowMs: NOW });
    expect(allowed).toMatchObject({ input: "Plan my week", status: "running" });
  });
});

describe("'Plan it' stale window (100)", () => {
  const vercel = {
    LLM_BASE_URL: "https://api.cloudflare.com/client/v4/accounts/x/ai/v1",
    LLM_MODEL: "@cf/zai-org/glm-4.7-flash",
    LLM_FALLBACK_MODEL: "@cf/google/gemma-4-26b-a4b-it",
    LLM_TIMEOUT_MS: "60000",
    LIFEOPS_BACKEND_TIMEOUT_MS: "60000",
  };

  it("never runs past Vercel's 300 s on a hosted site", () => {
    const window = planRequestWindowMs(planTimeoutMs(vercel), maxChatTurnMs(vercel), vercel, true);
    expect(window).toBeLessThanOrEqual(HOSTED_REQUEST_LIMIT_MS);
    expect(window).toBe(300_000);
  });

  it("keeps the Pages cap and the uncapped local window", () => {
    const pages = { ...vercel, LLM_TIMEOUT_MS: "40000", LIFEOPS_BACKEND_TIMEOUT_MS: "55000", LIFEOPS_MAX_REQUEST_MS: "160000" };
    expect(planRequestWindowMs(planTimeoutMs(pages), maxChatTurnMs(pages), pages, true)).toBe(160_000);
    expect(planRequestWindowMs(60_000, 240_000, {}, false)).toBe(360_000);
  });
});
