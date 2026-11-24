/**
 * The workspace chat turn (src/server/chat-turn.server.ts) run offline, end to end: an
 * in-memory stand-in for the database (the user's client and the service role share it), the
 * AI client, the limits and the Google connection are fakes. Findings of the review of
 * 24 Nov 2026: 2, 6, 10, 11, 16, 33, 47, 49, 50, 53, 80, 86, 88, 89, 99, 102, 111.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const db = vi.hoisted(() => {
  const tables = new Map<string, Row[]>();
  /** Forced failures: the next matching operation answers with this error. */
  const failures: { table: string; op: string; error: unknown }[] = [];
  /** Every write: which client made it. */
  const writes: { client: "user" | "admin"; table: string; op: string; row?: Row }[] = [];
  let clock = Date.parse("2026-11-24T08:00:00Z");

  function rows(table: string): Row[] {
    if (!tables.has(table)) tables.set(table, []);
    return tables.get(table)!;
  }

  function client(name: "user" | "admin") {
    return {
      from(table: string) {
        let op = "select";
        let payload: Row[] = [];
        let patch: Row = {};
        let returning = false;
        let single: "one" | "maybe" | null = null;
        let limit: number | null = null;
        const filters: ((row: Row) => boolean)[] = [];
        const orders: { col: string; asc: boolean }[] = [];
        const run = async () => {
          const failure = failures.findIndex((f) => f.table === table && f.op === op);
          if (failure >= 0) {
            const [{ error }] = failures.splice(failure, 1);
            return { data: null, error };
          }
          const all = rows(table);
          let data: Row[] = [];
          if (op === "insert" || op === "upsert") {
            for (const value of payload) {
              const row: Row = { id: crypto.randomUUID(), created_at: new Date((clock += 1000)).toISOString(), ...value };
              all.push(row);
              writes.push({ client: name, table, op, row });
              data.push(row);
            }
          } else {
            data = all.filter((row) => filters.every((keep) => keep(row)));
            if (op === "update") {
              for (const row of data) Object.assign(row, patch);
              writes.push({ client: name, table, op, row: patch });
            }
            if (op === "delete") {
              tables.set(table, all.filter((row) => !data.includes(row)));
              writes.push({ client: name, table, op });
            }
            for (const { col, asc } of [...orders].reverse()) {
              data = [...data].sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : String(a[col]) > String(b[col]) ? 1 : 0) * (asc ? 1 : -1));
            }
            if (limit !== null) data = data.slice(0, limit);
          }
          if (single) return { data: data[0] ?? null, error: null };
          return { data: op === "select" || returning ? data : null, error: null };
        };
        const builder = {
          select: () => {
            if (op !== "select") returning = true;
            return builder;
          },
          insert: (value: Row | Row[]) => {
            op = "insert";
            payload = Array.isArray(value) ? value : [value];
            return builder;
          },
          upsert: (value: Row | Row[]) => {
            op = "upsert";
            payload = Array.isArray(value) ? value : [value];
            return builder;
          },
          update: (value: Row) => {
            op = "update";
            patch = value;
            return builder;
          },
          delete: () => {
            op = "delete";
            return builder;
          },
          eq: (col: string, value: unknown) => {
            filters.push((row) => row[col] === value);
            return builder;
          },
          in: (col: string, values: unknown[]) => {
            filters.push((row) => values.includes(row[col]));
            return builder;
          },
          is: (col: string, value: unknown) => {
            filters.push((row) => (row[col] ?? null) === value);
            return builder;
          },
          not: (col: string, operator: string, value: string) => {
            if (operator !== "in") throw new Error(`not.${operator} is not faked`);
            const values = value.replace(/^\(|\)$/g, "").split(",");
            filters.push((row) => !values.includes(String(row[col])));
            return builder;
          },
          lt: (col: string, value: string) => {
            filters.push((row) => String(row[col]) < value);
            return builder;
          },
          gt: (col: string, value: string) => {
            filters.push((row) => String(row[col]) > value);
            return builder;
          },
          order: (col: string, opts: { ascending?: boolean } = {}) => {
            orders.push({ col, asc: opts.ascending !== false });
            return builder;
          },
          limit: (n: number) => {
            limit = n;
            return builder;
          },
          maybeSingle: () => {
            single = "maybe";
            return run();
          },
          single: () => {
            single = "one";
            return run();
          },
          then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => run().then(resolve, reject),
        };
        return builder;
      },
    };
  }

  return {
    tables,
    failures,
    writes,
    rows,
    user: client("user"),
    admin: client("admin"),
    reset() {
      tables.clear();
      failures.length = 0;
      writes.length = 0;
    },
  };
});

const mocks = vi.hoisted(() => ({
  callAI: vi.fn(),
  checkAiAllowance: vi.fn(async (..._args: unknown[]) => ({ allowed: true }) as { allowed: true } | { allowed: false; scope: "user" | "global"; message: string }),
  enforceAiAllowance: vi.fn(async (..._args: unknown[]) => {}),
  isGoogleConnected: vi.fn(async () => false),
  hosted: { value: false },
  listUnreadMessages: vi.fn(async () => [] as unknown[]),
  listRecentMessages: vi.fn(async () => [] as unknown[]),
  listCalendarEvents: vi.fn(async () => [] as unknown[]),
}));

vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: db.admin }));
vi.mock("@/server/ai/llm.server", async () => {
  const actual = await vi.importActual<typeof import("@/server/ai/llm.server")>("@/server/ai/llm.server");
  return { ...actual, callAI: mocks.callAI };
});
vi.mock("@/server/limits.server", async () => {
  const actual = await vi.importActual<typeof import("@/server/limits.server")>("@/server/limits.server");
  return { ...actual, checkAiAllowance: mocks.checkAiAllowance, enforceAiAllowance: mocks.enforceAiAllowance };
});
vi.mock("@/server/workspace.server", () => ({ isGoogleConnected: mocks.isGoogleConnected }));
vi.mock("@/server/deployment.server", () => ({ isHostedDeployment: () => mocks.hosted.value }));
vi.mock("@/server/google/gmail.server", () => ({
  listUnreadMessages: mocks.listUnreadMessages,
  listRecentMessages: mocks.listRecentMessages,
}));
vi.mock("@/server/google/calendar.server", () => ({ listCalendarEvents: mocks.listCalendarEvents }));
vi.mock("@/server/connectors/calendar.mock", async () => {
  const actual = await vi.importActual<typeof import("@/server/connectors/calendar.mock")>("@/server/connectors/calendar.mock");
  return { ...actual, ensureSeedEvents: vi.fn(async () => {}) };
});

import { AiNotConfiguredError } from "@/server/ai/llm.server";
import { CapReachedError } from "@/server/limits.server";
import {
  AI_BRIEFING_HEADER,
  CHAT_FAILED,
  CHAT_PROMPT_LIMITS,
  DEMO_BRIEFING_HEADER,
  ensureChatSessionFor,
  normalizeModelChanges,
  runChatTurn,
} from "@/server/chat-turn.server";
import { reconcileCalendarChanges } from "@/server/calendar/change-request.server";
import { NOTHING_SENT } from "@/server/ai/reply-guard.server";
import { demoSeedEvents } from "@/server/connectors/calendar.mock";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

const ZRH = "Europe/Zurich";
const TODAY = "2026-11-24"; // a Tuesday
const USER = "user-1";
const SESSION = "11111111-1111-4111-8111-111111111111";
const context = { supabase: db.user as unknown as SupabaseClient<Database>, userId: USER };

/** The demo calendar of 24 Nov 2026: team sync today 19-20, lecture Wed 10-12, dentist Thu 14-15:30, interview Mon 30 Nov 10-12. */
const EVENTS = demoSeedEvents(TODAY, ZRH).map((event, i) => ({
  id: `00000000-0000-4000-8000-00000000000${i + 1}`,
  user_id: USER,
  title: event.title,
  starts_at: event.starts_at,
  ends_at: event.ends_at,
  notes: event.notes,
  source: "mock",
}));
const dentist = EVENTS.find((event) => event.title === "Dentist appointment")!;
const sync = EVENTS.find((event) => event.title.startsWith("Team sync"))!;

/** A completion with the "respond" tool's arguments. */
function answer(args: Record<string, unknown>, finishReason = "stop") {
  return { choices: [{ finish_reason: finishReason, message: { content: null, tool_calls: [{ function: { name: "respond", arguments: JSON.stringify(args) } }] } }] };
}

function seed(history: { role: string; content: string }[] = []) {
  db.reset();
  db.rows("chat_sessions").push({ id: SESSION, user_id: USER, created_at: "2026-11-24T07:00:00.000Z" });
  db.rows("profiles").push({ id: USER, name: "Demo User", role: "Student", goals: "Finish the paper" });
  db.rows("calendar_events").push(...EVENTS.map((event) => ({ ...event })));
  let t = Date.parse("2026-11-24T07:30:00Z");
  for (const entry of history) {
    db.rows("chat_messages").push({ id: crypto.randomUUID(), session_id: SESSION, user_id: USER, role: entry.role, content: entry.content, panel_payload: null, created_at: new Date((t += 1000)).toISOString() });
  }
}

/** The system prompt of the last AI call. */
function lastSystemPrompt(): string {
  const call = mocks.callAI.mock.calls.at(-1)?.[0] as { messages: { role: string; content: string }[] };
  return call.messages.find((message) => message.role === "system")!.content;
}

function storedAssistantMessages(): Row[] {
  return db.rows("chat_messages").filter((row) => row.role === "assistant");
}

beforeEach(() => {
  vi.useFakeTimers({ now: new Date("2026-11-24T09:00:00Z"), toFake: ["Date"] });
  mocks.callAI.mockReset();
  mocks.checkAiAllowance.mockReset().mockResolvedValue({ allowed: true });
  mocks.enforceAiAllowance.mockReset().mockResolvedValue(undefined);
  mocks.isGoogleConnected.mockReset().mockResolvedValue(false);
  mocks.listUnreadMessages.mockReset().mockResolvedValue([]);
  mocks.listRecentMessages.mockReset().mockResolvedValue([]);
  mocks.listCalendarEvents.mockReset().mockResolvedValue([]);
  mocks.hosted.value = false;
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
  seed();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the demo's first-visit briefing (47, 99)", () => {
  it("is put together by rules: no AI call, no use of the AI allowance", async () => {
    const result = await runChatTurn(context, { sessionId: SESSION, message: "Please check all my emails and messages.", timeZone: ZRH, briefing: true }, { recordAiUse: true });
    expect(mocks.callAI).not.toHaveBeenCalled();
    expect(mocks.enforceAiAllowance).not.toHaveBeenCalled();
    expect(result.reply.startsWith(DEMO_BRIEFING_HEADER)).toBe(true);
    expect(result.reply).toContain("**📬 Inbox (4 unread)**");
    expect(result.reply).toContain("7:00 PM – 8:00 PM Team sync — demo walkthrough");
    expect(result.reply).not.toMatch(/did not answer|did not match/);
    // The team sync and Alicia's email about it are one priority.
    expect(result.panel.priorities?.filter((p) => /team sync/i.test(p.title))).toHaveLength(1);
    expect(db.rows("tasks").every((task) => task.source === "rules")).toBe(true);
  });

  it("over the limit it is the same rule-based briefing (the model is not needed)", async () => {
    mocks.checkAiAllowance.mockResolvedValue({ allowed: false, scope: "global", message: "This demo's AI allowance for today is used up." });
    const result = await runChatTurn(context, { sessionId: SESSION, message: "Please check all my emails and messages.", timeZone: ZRH, briefing: true }, { recordAiUse: true });
    expect(mocks.callAI).not.toHaveBeenCalled();
    expect(result.reply.startsWith(DEMO_BRIEFING_HEADER)).toBe(true);
  });
});

describe("the first-visit briefing with a connected Google account (6, 99, 102)", () => {
  const gmail = [
    { id: "g1", threadId: "t1", from: "Ana <ana@example.com>", to: "me", subject: "Budget review", snippet: "Can you check the numbers?", date: "", bodyText: "", unread: true },
  ];
  beforeEach(() => {
    mocks.isGoogleConnected.mockResolvedValue(true);
    mocks.listUnreadMessages.mockResolvedValue(gmail);
    mocks.listCalendarEvents.mockResolvedValue(EVENTS.map((event) => ({ ...event, busy: true })));
  });
  const brief = () => runChatTurn(context, { sessionId: SESSION, message: "Please check all my emails and messages.", timeZone: ZRH, briefing: true }, { recordAiUse: true });

  it("lists the inbox and today by rules and asks the model only for priorities and a closing line", async () => {
    mocks.callAI.mockResolvedValue(
      answer({
        reply: "**📬 Inbox (1 unread)**\n• **Ana** — *Budget review*\n\nA focused day: start with the budget review.",
        priorities: [{ rank: 1, title: "Reply to Ana about the budget", reason: "Unread email" }],
      }),
    );
    const result = await brief();
    expect(mocks.enforceAiAllowance).toHaveBeenCalledTimes(1);
    expect(lastSystemPrompt()).toContain("AUTOMATIC FIRST BRIEFING");
    expect(result.reply.startsWith(AI_BRIEFING_HEADER)).toBe(true);
    expect(result.reply).toContain("- **Ana <ana@example.com>** — *Budget review*");
    expect(result.reply).toContain("A focused day: start with the budget review.");
    expect(result.reply).not.toContain("•");
    expect(result.panel.priorities?.[0].title).toBe("Reply to Ana about the budget");
  });

  it("over the limit says so, not that the AI model did not answer (102)", async () => {
    mocks.checkAiAllowance.mockResolvedValue({ allowed: false, scope: "global", message: "This demo's AI allowance for today is used up." });
    const result = await brief();
    expect(mocks.callAI).not.toHaveBeenCalled();
    expect(result.reply.split("\n")[0]).toBe("⚠️ This demo's AI allowance for today is used up. This briefing was put together by simple rules from your inbox and calendar.");
    expect(result.reply).not.toContain("did not answer");
  });

  it("when the limit is reached at the last moment the header names the limit", async () => {
    mocks.enforceAiAllowance.mockRejectedValue(new CapReachedError("You have reached this demo's limit of 20 chat messages per hour. Please try again later.", "user"));
    const result = await brief();
    expect(mocks.callAI).not.toHaveBeenCalled();
    expect(result.reply.split("\n")[0]).toContain("limit of 20 chat messages per hour");
  });

  it("a site without an AI provider gets the rule-based briefing with a plain note (6)", async () => {
    mocks.hosted.value = true;
    mocks.callAI.mockRejectedValue(new AiNotConfiguredError());
    const result = await brief();
    expect(result.reply.split("\n")[0]).toBe("ℹ️ The AI assistant is not set up on this site yet, so this briefing was put together by simple rules from your inbox and calendar.");
  });

  it("on a hosted site developer detail never reaches the header (6, 33)", async () => {
    mocks.hosted.value = true;
    mocks.callAI.mockRejectedValue(new Error("Could not reach Ollama at http://localhost:11434/v1. Is it running? (For local Ollama: docker ps shows the Ollama container on port 11434.)"));
    const result = await brief();
    expect(result.reply).not.toMatch(/localhost|docker|Ollama/);
    expect(result.reply.split("\n")[0]).toBe("⚠️ The AI model did not answer, so this briefing was put together by simple rules. Ask again later for the AI's own ranking.");
  });

  it("an answer cut off at the token limit is named as such, not as a mismatch (53)", async () => {
    mocks.callAI.mockResolvedValue({ choices: [{ finish_reason: "length", message: { content: null, tool_calls: [{ function: { arguments: '{"reply":"Your week: Monday you have' } }] } }] });
    const result = await brief();
    expect(result.reply.split("\n")[0]).toContain("answer was cut off");
    expect(result.reply).not.toContain("did not match");
  });
});

describe("the AI allowance is recorded once, right before the model is asked (11)", () => {
  it("processChat's turns record one 'chat' use; the dashboard's fallback turn records none", async () => {
    mocks.callAI.mockResolvedValue(answer({ reply: "Hello!" }));
    await runChatTurn(context, { sessionId: SESSION, message: "Hi there", timeZone: ZRH }, { recordAiUse: true });
    expect(mocks.enforceAiAllowance).toHaveBeenCalledTimes(1);
    expect(mocks.enforceAiAllowance.mock.calls[0][2]).toBe("chat");
    expect(mocks.enforceAiAllowance.mock.invocationCallOrder[0]).toBeLessThan(mocks.callAI.mock.invocationCallOrder[0]);
    mocks.enforceAiAllowance.mockClear();
    await runChatTurn(context, { sessionId: SESSION, message: "Plan my afternoon", timeZone: ZRH });
    expect(mocks.enforceAiAllowance).not.toHaveBeenCalled();
  });
});

describe("errors shown to the user and stored in the chat (6, 33, 50)", () => {
  const providerError = new Error(
    "Could not reach Cloudflare Workers AI at https://api.cloudflare.com/client/v4/accounts/abc123def/ai/v1. Is it running? (For local Ollama: docker ps shows the Ollama container on port 11434.)",
  );

  it("on a hosted site the provider's address and docker hints are neither shown nor stored", async () => {
    mocks.hosted.value = true;
    mocks.callAI.mockRejectedValue(providerError);
    const failure = await runChatTurn(context, { sessionId: SESSION, message: "Hi there", timeZone: ZRH }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(CHAT_FAILED);
    const stored = storedAssistantMessages().at(-1)!;
    expect(stored.content).toBe(`⚠️ ${CHAT_FAILED}`);
    expect(String(stored.content)).not.toMatch(/abc123def|docker|cloudflare\.com/);
  });

  it("a sentence written for users passes; a local run keeps the developer detail", async () => {
    mocks.hosted.value = true;
    mocks.callAI.mockRejectedValue(new Error("Cloudflare Workers AI rate limit reached. Please wait a moment and try again."));
    await expect(runChatTurn(context, { sessionId: SESSION, message: "Hi", timeZone: ZRH })).rejects.toThrow("rate limit reached");
    mocks.hosted.value = false;
    mocks.callAI.mockRejectedValue(providerError);
    await expect(runChatTurn(context, { sessionId: SESSION, message: "Hi", timeZone: ZRH })).rejects.toThrow("docker ps");
  });

  it("a database error object becomes a plain sentence (no code, details or hint)", async () => {
    db.failures.push({ table: "chat_messages", op: "insert", error: { code: "08006", message: "connection failure", details: "TypeError: fetch failed\n    at node_modules/undici/index.js:1", hint: "" } });
    const failure = await runChatTurn(context, { sessionId: SESSION, message: "Hi", timeZone: ZRH }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("Could not save your message. Please try again in a moment.");
    expect(Object.keys(failure as object)).not.toContain("details");
  });

  it("an unreadable answer is a failed turn with a plain sentence, not 'I'm not sure how to handle that.'", async () => {
    mocks.callAI.mockResolvedValue({ choices: [{ finish_reason: "stop", message: { content: "", tool_calls: [] } }] });
    await expect(runChatTurn(context, { sessionId: SESSION, message: "Hi", timeZone: ZRH })).rejects.toThrow("could not be read");
  });

  it("an answer cut off at the token limit says so (53)", async () => {
    mocks.callAI.mockResolvedValue({ choices: [{ finish_reason: "length", message: { content: null, tool_calls: [{ function: { arguments: '{"reply":"Your week: Monday you have' } }] } }] });
    await expect(runChatTurn(context, { sessionId: SESSION, message: "Plan my whole week", timeZone: ZRH })).rejects.toThrow(/cut off/);
    expect(storedAssistantMessages().at(-1)!.content).toMatch(/cut off/);
  });
});

describe("who writes what (49)", () => {
  it("the user's token writes only the user's own message; the server writes the answer and the tasks", async () => {
    mocks.callAI.mockResolvedValue(answer({ reply: "Here you go.", priorities: [{ rank: 1, title: "Write the paper", reason: "Due soon" }] }));
    await runChatTurn(context, { sessionId: SESSION, message: "What are my priorities?", timeZone: ZRH });
    const userWrites = db.writes.filter((write) => write.client === "user");
    expect(userWrites).toEqual([expect.objectContaining({ table: "chat_messages", op: "insert", row: expect.objectContaining({ role: "user" }) })]);
    expect(userWrites[0].row).not.toHaveProperty("panel_payload");
    const adminTables = new Set(db.writes.filter((write) => write.client === "admin").map((write) => `${write.table}:${write.op}`));
    expect([...adminTables].sort()).toEqual(["chat_messages:insert", "tasks:insert"]);
  });
});

describe("structured answers (53, 56)", () => {
  it("object and null bullets do not show as '[object Object]' or 'null'; empty cards are dropped", async () => {
    mocks.callAI.mockResolvedValue(
      answer({
        reply: "Here is a workout.",
        insight: { kind: "workout", title: "Push day", bullets: [{ exercise: "Bench press", sets: 3 }, "Dips 3x10", null] },
        alternatives: { title: "Nothing", bullets: [] },
      }),
    );
    const result = await runChatTurn(context, { sessionId: SESSION, message: "Give me a push workout for today", timeZone: ZRH });
    expect(result.panel.insight?.bullets).toEqual(["exercise: Bench press, sets: 3", "Dips 3x10"]);
    expect(result.panel.alternatives).toBeUndefined();
  });
});

describe("priorities replace the task list safely (89)", () => {
  it("ranks such as 1.5 become whole numbers", async () => {
    mocks.callAI.mockResolvedValue(answer({ reply: "Ranked.", priorities: [{ rank: 1.5, title: "Y", reason: "b" }, { rank: 1, title: "X", reason: "a" }] }));
    await runChatTurn(context, { sessionId: SESSION, message: "Rank my tasks", timeZone: ZRH });
    expect(db.rows("tasks").map((task) => [task.title, task.priority_rank]).sort()).toEqual([["X", 1], ["Y", 2]]);
  });

  it("a failed insert or delete leaves the old list in place", async () => {
    db.rows("tasks").push({ id: "old-a", user_id: USER, title: "A", priority_rank: 1 }, { id: "old-b", user_id: USER, title: "B", priority_rank: 2 });
    mocks.callAI.mockResolvedValue(answer({ reply: "Ranked.", priorities: [{ rank: 1, title: "X", reason: "a" }] }));
    db.failures.push({ table: "tasks", op: "insert", error: { code: "22P02", message: "invalid input syntax for type integer" } });
    await expect(runChatTurn(context, { sessionId: SESSION, message: "Rank my tasks", timeZone: ZRH })).rejects.toThrow("Could not save your priorities");
    expect(db.rows("tasks").map((task) => task.title)).toEqual(["A", "B"]);

    db.failures.push({ table: "tasks", op: "delete", error: { code: "08006", message: "connection failure" } });
    await expect(runChatTurn(context, { sessionId: SESSION, message: "Rank my tasks", timeZone: ZRH })).rejects.toThrow("Could not save your priorities");
    expect(db.rows("tasks").map((task) => task.title)).toEqual(["A", "B"]);

    await runChatTurn(context, { sessionId: SESSION, message: "Rank my tasks", timeZone: ZRH });
    expect(db.rows("tasks").map((task) => task.title)).toEqual(["X"]);
  });
});

describe("an answer to MONDAY's own question back (2)", () => {
  it("'8 pm' after 'Did you mean 8:00 AM or 8:00 PM ...?' gives the move card", async () => {
    const request = "Move the team sync to 8";
    const question = reconcileCalendarChanges({
      message: request,
      today: TODAY,
      timeZone: ZRH,
      nowMs: Date.now(),
      events: EVENTS,
      modelChanges: [],
      modelProposals: [],
    }).note;
    expect(question).toMatch(/8:00 AM or 8:00 PM/);
    seed([
      { role: "user", content: request },
      { role: "assistant", content: `${question} Nothing in your calendar was changed.` },
    ]);
    mocks.callAI.mockResolvedValue(answer({ reply: "Okay." }));
    const result = await runChatTurn(context, { sessionId: SESSION, message: "8 pm", timeZone: ZRH });
    expect(result.panel.pendingEventChanges).toHaveLength(1);
    expect(result.panel.pendingEventChanges?.[0]).toMatchObject({ event_id: sync.id, next: { starts_at: "2026-11-24T19:00:00.000Z" } });
    expect(result.reply).toContain("Ready to move **Team sync — demo walkthrough**");
  });
});

describe("a question about one day is answered from that day's calendar (10, 111)", () => {
  it("Thursday's dentist appointment is not reported on Friday, and the model's Friday card is dropped", async () => {
    mocks.callAI.mockResolvedValue(
      answer({
        reply: "Your calendar for Friday, Nov 27, 2026:\n\n• Dentist appointment: 14:00–15:30\n\nNothing else scheduled that day.",
        insight: { kind: "summary", title: "Friday Overview", bullets: ["One event: Dentist appointment (90 min)"] },
        alternatives: { title: "Friday Alternatives", bullets: ["No other events"] },
      }),
    );
    const result = await runChatTurn(context, { sessionId: SESSION, message: "What's on my calendar on Friday?", timeZone: ZRH });
    expect(result.reply).toBe("Nothing is scheduled on Friday, Nov 27.");
    expect(result.panel.insight).toBeUndefined();
    expect(result.panel.alternatives).toBeUndefined();
  });

  it("a correct answer stands, with its times as the cards show them", async () => {
    mocks.callAI.mockResolvedValue(answer({ reply: "On Thursday you have:\n- Dentist appointment: 14:00–15:30" }));
    const result = await runChatTurn(context, { sessionId: SESSION, message: "What's on Thursday?", timeZone: ZRH });
    expect(result.reply).toBe("On Thursday you have:\n- Dentist appointment: 2:00 PM – 3:30 PM");
  });

  it("a wrong time on the event's line gets the day's list", async () => {
    mocks.callAI.mockResolvedValue(answer({ reply: "Thursday: Dentist appointment at 15:00." }));
    const result = await runChatTurn(context, { sessionId: SESSION, message: "What's on Thursday?", timeZone: ZRH });
    expect(result.reply).toBe("Your calendar for Thursday, Nov 26:\n- 2:00 PM – 3:30 PM Dentist appointment");
  });
});

describe("reply drafts only when asked for (88, 111)", () => {
  it("a calendar question with a placeholder email_reply gets no note about an unknown email", async () => {
    mocks.callAI.mockResolvedValue(answer({ reply: "On Thursday you have the dentist appointment at 2:00 PM.", email_reply: { message_id: "e99", body: "Hi" } }));
    const result = await runChatTurn(context, { sessionId: SESSION, message: "When is my dentist appointment?", timeZone: ZRH });
    expect(result.reply).not.toContain("not in your inbox");
    expect(result.panel.emailDraft).toBeUndefined();
  });

  it("a requested reply to an unknown email still says why there is no draft", async () => {
    mocks.callAI.mockResolvedValue(answer({ reply: "Here is a draft.", email_reply: { message_id: "e99", body: "Hi" } }));
    const result = await runChatTurn(context, { sessionId: SESSION, message: "Draft a reply to the recruiter", timeZone: ZRH });
    expect(result.reply).toContain("not in your inbox");
  });

  it("a requested reply is a draft card signed with the user's first name; the chat does not repeat it", async () => {
    const body = "Hi Sam — yes, let's do lunch this Saturday around 1pm. Looking forward to it!";
    mocks.callAI.mockResolvedValue(answer({ reply: body, email_reply: { message_id: "e3", body } }));
    const result = await runChatTurn(context, { sessionId: SESSION, message: "Reply to Sam's email: yes to lunch", timeZone: ZRH });
    expect(result.panel.emailDraft?.messageId).toBe("e3");
    expect(result.panel.emailDraft?.body).toBe(`${body}\n\nBest,\nDemo`);
    expect(result.reply).toBe("The reply to Sam (friend) is under **Insights** as a draft suggestion. Edit it and click **Save as draft**; nothing is sent.");
  });
});

describe("a request to send (86)", () => {
  it("is told that MONDAY never sends and where drafts go, not to name a day and a time", async () => {
    mocks.callAI.mockResolvedValue(answer({ reply: "I can't send emails for you." }));
    const result = await runChatTurn(context, { sessionId: SESSION, message: "Send my reply to Sam now", timeZone: ZRH });
    expect(result.reply).toContain(NOTHING_SENT);
    expect(result.reply).not.toContain("naming the day and the time");
  });
});

describe("the prompt (16, 18, 80)", () => {
  it("links Alicia's email to the team sync it announces, and lists with '- '", async () => {
    mocks.callAI.mockResolvedValue(answer({ reply: "Hello." }));
    await runChatTurn(context, { sessionId: SESSION, message: "Hi", timeZone: ZRH });
    const prompt = lastSystemPrompt();
    const line = (id: string) => prompt.split("\n").find((l) => l.includes(`id=${id} `))!;
    expect(line("e5")).toContain("(same meeting as calendar event E1 19:00-20:00, already in the calendar at that time)");
    for (const id of ["e1", "e2", "e3", "e4"]) expect(line(id)).not.toContain("same meeting");
    expect(line("e1").startsWith("  - id=e1")).toBe(true);
    expect(prompt).toContain("not a conflict or an overlap, and one priority, not two");
  });

  it("keeps the user's own texts short however long they are stored", async () => {
    db.tables.set("profiles", [{ id: USER, name: "n".repeat(10_000), role: "r".repeat(5_000), goals: "g".repeat(200_000) }]);
    db.tables.set("tasks", Array.from({ length: 500 }, (_, i) => ({ id: `t${i}`, user_id: USER, title: "t".repeat(5_000), reason: "r".repeat(5_000), priority_rank: i + 1 })));
    mocks.callAI.mockResolvedValue(answer({ reply: "Hello." }));
    await runChatTurn(context, { sessionId: SESSION, message: "Hi", timeZone: ZRH });
    const prompt = lastSystemPrompt();
    expect(prompt.length).toBeLessThan(20_000);
    expect(Math.max(...(prompt.match(/g+/g) ?? []).map((run) => run.length))).toBeLessThanOrEqual(CHAT_PROMPT_LIMITS.goals);
    expect(prompt.split("\n").filter((l) => /^ {2}[-•] #/.test(l))).toHaveLength(CHAT_PROMPT_LIMITS.tasks);
    // Only the tasks that go into the prompt are read.
    expect(Math.max(...(prompt.match(/t{2,}/g) ?? []).map((run) => run.length))).toBeLessThanOrEqual(CHAT_PROMPT_LIMITS.taskTitle);
  });
});

describe("the model's event changes (22, 26)", () => {
  const lookup = (ref: string) => (ref === "e1" ? (EVENTS[0] as never) : ref === "e3" ? (dentist as never) : undefined);

  it("one change per event: a second change to the same event is dropped", () => {
    const changes = normalizeModelChanges(
      [
        { kind: "update", event_id: "E3", starts_at: "2026-11-27T10:00:00", ends_at: "2026-11-27T11:30:00" },
        { kind: "update", event_id: "E3", starts_at: "2026-11-24T15:00:00", ends_at: "2026-11-24T16:30:00" },
      ],
      lookup,
      ZRH,
    );
    expect(changes).toHaveLength(1);
    expect(changes[0].starts_at).toBe("2026-11-27T09:00:00.000Z");
  });

  it("an update with a time that is not a valid date-time is dropped, not half applied", () => {
    expect(normalizeModelChanges([{ kind: "update", event_id: "E3", starts_at: "2026-11-24T25:00:00", ends_at: "2026-11-24T16:00:00" }], lookup, ZRH)).toEqual([]);
    expect(normalizeModelChanges([{ kind: "update", event_id: "E3", starts_at: "Fri 3 pm" }], lookup, ZRH)).toEqual([]);
    // A rename alone is still a change.
    expect(normalizeModelChanges([{ kind: "update", event_id: "E3", title: "Dentist (moved)" }], lookup, ZRH)).toHaveLength(1);
  });
});

describe("the first chat session (89)", () => {
  it("two first loads at once end up in the same session", async () => {
    db.reset();
    // The other load created its session between this load's check and its insert.
    db.rows("chat_sessions").push({ id: "s-other", user_id: USER, created_at: "2026-11-24T07:59:59.000Z" });
    const original = db.user.from;
    let first = true;
    const racing = {
      from(table: string) {
        const builder = original(table);
        if (table === "chat_sessions" && first) {
          first = false;
          // The first look finds nothing (the other insert was not visible yet).
          return { ...builder, select: () => ({ eq: () => ({ order: () => ({ limit: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }) }) };
        }
        return builder;
      },
    };
    const result = await ensureChatSessionFor(racing as unknown as SupabaseClient<Database>, USER);
    expect(result.sessionId).toBe("s-other");
    expect(db.rows("chat_sessions").map((row) => row.id)).toEqual(["s-other"]);
  });
});
