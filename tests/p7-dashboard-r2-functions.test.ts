/**
 * The dashboard's server functions (src/functions/dashboard.functions.ts), run offline: createServerFn
 * is replaced by a stand-in that runs the validator and the handler with a fixed context, and the
 * calendar, planner, chat and database modules are fakes. Round 2 of the audit of 24 Nov 2026:
 *  - 39: one calendar read covered Monday to today + 7 days (up to 13 days), and Google answers at
 *    most 50 events per read, so a busy fortnight cut both "Events next 7 days" and the plan count;
 *  - 12: the dashboard had its own copy of the "model on this machine" check, which had drifted from
 *    the server's isLocalBaseUrl (a model at host.docker.internal was not marked local);
 *  - 50: the failed "Plan it" request's error was stored uncut, and the database refuses an error
 *    longer than 2000 characters, so the request kept showing "Planning…".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const harness = vi.hoisted(() => {
  const state: { context: Record<string, unknown> } = { context: {} };

  /** Stand-in for TanStack Start's builder: calling the function runs validator then handler. */
  function createServerFn() {
    let validator: ((data: unknown) => unknown) | undefined;
    const builder = {
      middleware: () => builder,
      validator: (fn: (data: unknown) => unknown) => {
        validator = fn;
        return builder;
      },
      handler:
        (fn: (ctx: { data: unknown; context: unknown }) => unknown) =>
        async (opts: { data?: unknown } = {}) =>
          fn({ data: validator ? validator(opts.data) : opts.data, context: state.context }),
    };
    return builder;
  }

  /** Every read answers "nothing stored"; updates are recorded and echo the changed row. */
  function fakeClient() {
    const updates: Array<{ table: string; values: Row }> = [];
    function from(table: string) {
      let values: Row | null = null;
      const answer = () => ({
        data: values ? { id: "req-1", ...values } : null,
        error: null,
        count: 0,
      });
      const builder = {
        select: () => builder,
        eq: () => builder,
        order: () => builder,
        limit: () => builder,
        update: (next: Row) => {
          values = next;
          updates.push({ table, values: next });
          return builder;
        },
        maybeSingle: async () => answer(),
        single: async () => answer(),
        then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
          Promise.resolve(values ? answer() : { data: [], error: null, count: 0 }).then(
            resolve,
            reject,
          ),
      };
      return builder;
    }
    return { updates, client: { from } };
  }

  return { state, createServerFn, admin: fakeClient(), user: fakeClient() };
});

const mocks = vi.hoisted(() => ({
  isGoogleConnected: vi.fn(async () => false),
  listBusyEvents: vi.fn(async (..._args: unknown[]) => [] as unknown[]),
  plannerDashboard: vi.fn(),
  plannerPlan: vi.fn(),
  startPlanRequest: vi.fn(),
}));

vi.mock("@tanstack/react-start", () => ({ createServerFn: harness.createServerFn }));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: harness.admin.client }));
vi.mock("@/server/workspace.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/workspace.server")>()),
  isGoogleConnected: mocks.isGoogleConnected,
  listBusyEvents: mocks.listBusyEvents,
}));
vi.mock("@/server/connectors/calendar.mock", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/connectors/calendar.mock")>()),
  ensureSeedEvents: vi.fn(async () => {}),
}));
vi.mock("@/server/chat-turn.server", () => ({
  ensureChatSessionFor: vi.fn(async () => ({ sessionId: "s1" })),
  maxChatTurnMs: () => 240_000,
  runChatTurn: vi.fn(),
}));
vi.mock("@/server/chat-cards.server", () => ({
  cardIdsOfPanel: () => [],
  listCardStates: vi.fn(async () => new Map()),
}));
vi.mock("@/server/lifeops-backend.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/lifeops-backend.server")>();
  return {
    ...actual,
    backend: { ...actual.backend, dashboard: mocks.plannerDashboard, plan: mocks.plannerPlan },
    startPlanRequest: mocks.startPlanRequest,
  };
});

import { fetchDashboard, runChaosPlan } from "@/functions/dashboard.functions";
import { BackendUnavailableError } from "@/server/lifeops-backend.server";

const USER = "11111111-2222-3333-4444-555555555555";
const ZRH = "Europe/Zurich";
const DAY_MS = 24 * 60 * 60 * 1000;

beforeEach(() => {
  harness.state.context = { supabase: harness.user.client, userId: USER };
  harness.admin.updates.length = 0;
  mocks.isGoogleConnected.mockReset().mockResolvedValue(false);
  mocks.listBusyEvents.mockReset().mockResolvedValue([]);
  mocks.plannerDashboard
    .mockReset()
    .mockRejectedValue(new BackendUnavailableError("The planner service is switched off.", "off"));
  mocks.plannerPlan.mockReset();
  mocks.startPlanRequest.mockReset();
  vi.stubEnv("LIFEOPS_HOSTED", "");
  vi.stubEnv("LIFEOPS_BACKEND_URL", "https://planner.test");
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.useFakeTimers({ toFake: ["Date"] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** The [start, end) ranges the dashboard read from the calendar, in ms. */
function calendarReads(): Array<[number, number]> {
  return mocks.listBusyEvents.mock.calls.map((call) => [
    Date.parse(String(call[3])),
    Date.parse(String(call[4])),
  ]);
}

describe("the dashboard's calendar reads (39)", () => {
  // Wednesday 25 Nov 2026, 10:00 in Zurich: the plan week began on Monday the 23rd.
  const WEDNESDAY = Date.parse("2026-11-25T09:00:00Z");
  const todayStart = Date.parse("2026-11-24T23:00:00Z");
  const mondayStart = Date.parse("2026-11-22T23:00:00Z");

  it("with Google, reads 'next 7 days' and the plan week separately, never more than 7 days at once", async () => {
    vi.setSystemTime(WEDNESDAY);
    mocks.isGoogleConnected.mockResolvedValue(true);
    await fetchDashboard({ data: { timeZone: ZRH } });
    const reads = calendarReads();
    expect(reads).toHaveLength(2);
    for (const [start, end] of reads) expect(end - start).toBeLessThanOrEqual(7 * DAY_MS);
    expect(reads).toEqual(
      expect.arrayContaining([
        [todayStart, todayStart + 7 * DAY_MS],
        [mondayStart, mondayStart + 7 * DAY_MS],
      ]),
    );
    // Both reads ask Google (connected = true).
    expect(mocks.listBusyEvents.mock.calls.every((call) => call[2] === true)).toBe(true);
  });

  it("counts each range from its own read", async () => {
    vi.setSystemTime(WEDNESDAY);
    mocks.isGoogleConnected.mockResolvedValue(true);
    const event = (startIso: string) => ({
      id: startIso,
      title: "Busy",
      starts_at: startIso,
      ends_at: new Date(Date.parse(startIso) + 3_600_000).toISOString(),
    });
    mocks.listBusyEvents.mockImplementation(async (...args: unknown[]) =>
      Date.parse(String(args[3])) === todayStart
        ? [event("2026-11-26T09:00:00.000Z"), event("2026-11-30T09:00:00.000Z")]
        : [event("2026-11-23T09:00:00.000Z"), event("2026-11-26T09:00:00.000Z")],
    );
    const answer = await fetchDashboard({ data: { timeZone: ZRH } });
    expect(answer.workspace.eventsNext7Days).toBe(2);
    expect(answer.workspace.upcoming.map((e) => e.starts_at)).toEqual([
      "2026-11-26T09:00:00.000Z",
      "2026-11-30T09:00:00.000Z",
    ]);
  });

  it("on a Monday the two ranges are one, and the demo calendar is always read once", async () => {
    vi.setSystemTime(Date.parse("2026-11-23T09:00:00Z"));
    mocks.isGoogleConnected.mockResolvedValue(true);
    await fetchDashboard({ data: { timeZone: ZRH } });
    expect(calendarReads()).toEqual([[mondayStart, mondayStart + 7 * DAY_MS]]);

    mocks.listBusyEvents.mockClear();
    vi.setSystemTime(WEDNESDAY);
    mocks.isGoogleConnected.mockResolvedValue(false);
    await fetchDashboard({ data: { timeZone: ZRH } });
    expect(calendarReads()).toEqual([[mondayStart, todayStart + 7 * DAY_MS]]);
  });
});

describe("'Next 7 days' starts at now (L7)", () => {
  it("does not list or count an event that is over, and keeps one that is running", async () => {
    // Wednesday 25 Nov 2026, 10:00 in Zurich.
    vi.setSystemTime(Date.parse("2026-11-25T09:00:00Z"));
    mocks.isGoogleConnected.mockResolvedValue(false);
    const event = (title: string, startIso: string, endIso: string) => ({ id: title, title, starts_at: startIso, ends_at: endIso });
    mocks.listBusyEvents.mockImplementation(async () => [
      event("Over", "2026-11-25T07:00:00.000Z", "2026-11-25T08:00:00.000Z"),
      event("Running", "2026-11-25T08:30:00.000Z", "2026-11-25T09:30:00.000Z"),
      event("Later", "2026-11-25T15:00:00.000Z", "2026-11-25T16:00:00.000Z"),
    ]);
    const answer = await fetchDashboard({ data: { timeZone: ZRH } });
    expect(answer.workspace.upcoming.map((e) => e.title)).toEqual(["Running", "Later"]);
    expect(answer.workspace.eventsNext7Days).toBe(2);
  });
});

describe("the AI badge's 'local model' mark (12)", () => {
  it("uses the server's isLocalBaseUrl, so a model in Docker on this machine counts as local", async () => {
    vi.setSystemTime(Date.parse("2026-11-25T09:00:00Z"));
    vi.stubEnv("LLM_BASE_URL", "http://host.docker.internal:11434/v1");
    vi.stubEnv("LLM_MODEL", "llama3.1:8b");
    const local = await fetchDashboard({ data: { timeZone: ZRH } });
    expect(local.workspace.aiProvider).toEqual({
      configured: true,
      label: "Ollama · llama3.1:8b",
      local: true,
    });

    vi.stubEnv("LLM_BASE_URL", "https://api.cloudflare.com/client/v4/accounts/x/ai/v1");
    vi.stubEnv("LLM_MODEL", "@cf/zai-org/glm-4.7-flash");
    const hosted = await fetchDashboard({ data: { timeZone: ZRH } });
    expect(hosted.workspace.aiProvider.local).toBe(false);
  });
});

describe("a failed 'Plan it' request's stored error (50)", () => {
  it("is cut to the column's 2000 characters, so the update that closes the request is accepted", async () => {
    vi.setSystemTime(Date.parse("2026-11-25T09:00:00Z"));
    mocks.startPlanRequest.mockResolvedValue({
      id: "req-1",
      input: "Plan my week",
      status: "running",
      result: null,
      error: null,
      created_at: new Date().toISOString(),
      finished_at: null,
    });
    // A local run passes a developer's message through: here one with a long raw answer.
    const long = `Calendar insert failed: 403 ${"x".repeat(3000)}`;
    mocks.plannerPlan.mockRejectedValue(new Error(long));
    await expect(runChaosPlan({ data: { input: "Plan my week", timeZone: ZRH } })).rejects.toThrow(
      /^Calendar insert failed/,
    );
    const finish = harness.admin.updates.find((update) => update.table === "planner_requests");
    expect(finish?.values).toMatchObject({ status: "failed" });
    expect(String(finish?.values.error)).toHaveLength(2000);
    expect(String(finish?.values.error)).toBe(long.slice(0, 2000));
  });
});
