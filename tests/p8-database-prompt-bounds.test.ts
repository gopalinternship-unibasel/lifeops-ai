// Finding 80: the chat prompt embeds the user's profile, task list and calendar on every turn, and
// the AI limits count calls, not their size. These tests give the prompt far more than any form
// allows (rows saved before the database length limits can be that long) and check that what
// reaches the model stays small.
import { beforeEach, describe, expect, it, vi } from "vitest";

const captured: { system?: string } = {};

// The service-role client: only the failed turn is stored with it in these tests.
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: () => ({ insert: async () => ({ error: null }) }) },
}));
vi.mock("@/server/workspace.server", () => ({ isGoogleConnected: async () => false }));
vi.mock("@/server/connectors/calendar.mock", async (importOriginal) => ({
  // The demo inbox (gmail.mock) reads demoSeedEvents from this module, so keep the real exports.
  ...(await importOriginal<typeof import("@/server/connectors/calendar.mock")>()),
  ensureSeedEvents: async () => undefined,
  listEventsForRange: vi.fn(),
}));
vi.mock("@/server/limits.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/limits.server")>()),
  checkAiAllowance: async () => ({ allowed: true }),
}));
vi.mock("@/server/ai/llm.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/ai/llm.server")>()),
  callAI: vi.fn(async (options: { messages: Array<{ role: string; content: string }> }) => {
    captured.system = options.messages[0]?.content;
    throw new Error("stop after the prompt");
  }),
}));

import { listEventsForRange } from "@/server/connectors/calendar.mock";
import {
  CHAT_PROMPT_LIMITS,
  runChatTurn,
  userContextForPrompt,
} from "@/server/chat-turn.server";

const USER = "11111111-1111-4111-8111-111111111111";
const SESSION = "aaaaaaaa-0000-4000-8000-000000000001";

const hugeProfile = { name: "n".repeat(10_000), role: "r".repeat(10_000), goals: "g".repeat(200_000) };
const manyTasks = Array.from({ length: 500 }, (_, i) => ({
  id: `task-${i}`,
  title: "t".repeat(5_000),
  priority_rank: i + 1,
  reason: "r".repeat(5_000),
}));

/** The longest run of one character in a text. */
function longestRun(text: string, char: string): number {
  return Math.max(0, ...(text.match(new RegExp(`${char}+`, "g")) ?? []).map((run) => run.length));
}

/** A user-token client that answers each table with a fixed result, as the chat turn reads it. */
function userClient(results: Record<string, unknown>) {
  return {
    from(table: string) {
      const result = { data: results[table] ?? null, error: null };
      const builder: Record<string, unknown> = {
        maybeSingle: async () => result,
        single: async () => result,
        insert: async () => ({ error: null }),
        then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
          Promise.resolve(result).then(resolve, reject),
      };
      for (const method of ["select", "eq", "order", "limit"]) builder[method] = () => builder;
      return builder;
    },
  };
}

describe("userContextForPrompt (finding 80)", () => {
  it("cuts the profile and the task list however long they are", () => {
    const context = userContextForPrompt(hugeProfile, manyTasks);
    expect(context.profile.length).toBeLessThan(2_000);
    expect(longestRun(context.profile, "g")).toBe(CHAT_PROMPT_LIMITS.goals);
    expect(longestRun(context.profile, "n")).toBe(CHAT_PROMPT_LIMITS.name);
    const lines = context.tasks.split("\n");
    expect(lines).toHaveLength(CHAT_PROMPT_LIMITS.tasks);
    expect(longestRun(context.tasks, "t")).toBe(CHAT_PROMPT_LIMITS.taskTitle);
    expect(longestRun(context.tasks, "r")).toBe(CHAT_PROMPT_LIMITS.taskReason);
    expect(context.tasks.length).toBeLessThan(7_000);
  });

  it("keeps ordinary values as they were and fills in missing ones", () => {
    const context = userContextForPrompt(
      { name: "Ada", role: "Engineer", goals: "Ship the release\nand rest" },
      [
        { title: "Reply to Acme", priority_rank: 1, reason: "Interview on Monday" },
        { title: "Gym", priority_rank: null, reason: null },
      ],
    );
    expect(context.profile).toBe("- Name: Ada\n- Role: Engineer\n- Goals: Ship the release and rest");
    expect(context.tasks).toBe("  • #1 Reply to Acme — Interview on Monday\n  • #? Gym — ");
    expect(userContextForPrompt(null, null)).toEqual({
      profile: "- Name: User\n- Role: Professional\n- Goals: (not specified)",
      tasks: "  (none)",
    });
  });
});

describe("the chat system prompt (finding 80)", () => {
  beforeEach(() => {
    captured.system = undefined;
    const start = Date.now() + 30 * 60_000;
    // 200 events in the next four days, each with a very long title.
    const events = Array.from({ length: 200 }, (_, i) => ({
      id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
      title: `${"e".repeat(5_000)}${i}`,
      starts_at: new Date(start + i * 30 * 60_000).toISOString(),
      ends_at: new Date(start + i * 30 * 60_000 + 20 * 60_000).toISOString(),
      notes: "x".repeat(2_000),
    }));
    vi.mocked(listEventsForRange).mockResolvedValue(events as never);
  });

  it("stays small with a huge profile, 500 long tasks and 200 events", async () => {
    const supabase = userClient({
      chat_sessions: { id: SESSION },
      chat_messages: [],
      profiles: hugeProfile,
      tasks: manyTasks,
    });
    await expect(
      runChatTurn(
        { supabase: supabase as never, userId: USER },
        { sessionId: SESSION, message: "What is on my calendar this week?", timeZone: "Europe/Zurich" },
      ),
    ).rejects.toThrow("stop after the prompt");

    const system = captured.system ?? "";
    expect(system).toContain("USER PROFILE:");
    // Before the fix this prompt held every character: over five million.
    expect(system.length).toBeLessThan(30_000);
    expect(longestRun(system, "g")).toBe(CHAT_PROMPT_LIMITS.goals);
    expect(system.match(/^ {2}• #/gm)).toHaveLength(CHAT_PROMPT_LIMITS.tasks);
    expect(system.match(/^ {4}E\d+ /gm)).toHaveLength(CHAT_PROMPT_LIMITS.soonEvents);
    expect(system).toContain(`(${200 - CHAT_PROMPT_LIMITS.soonEvents} later events in these days are not listed)`);
  });
});
