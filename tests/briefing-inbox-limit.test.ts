// A real Gmail inbox had 50 unread emails (live test, 26 Nov 2026): the briefing lists the newest
// ten and counts the rest, and the model is told to do the same and gets at most 15 emails.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildRuleBasedBriefing, INBOX_LIST_LIMIT } from "@/server/ai/briefing-fallback.server";

const unreadEmails = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ from: `Sender ${i + 1}`, subject: `Subject ${i + 1}`, snippet: `Text ${i + 1}`, unread: true }));

describe("the rule-based briefing with a large inbox", () => {
  it("lists ten unread emails and counts the rest", () => {
    const { reply } = buildRuleBasedBriefing({ emails: unreadEmails(50), unreadCount: 50, todayEvents: [], reason: "" });
    const bullets = reply.split("\n").filter((line) => line.startsWith("- **Sender"));
    expect(INBOX_LIST_LIMIT).toBe(10);
    expect(bullets).toHaveLength(10);
    expect(reply).toContain("**📬 Inbox (50 unread)**");
    expect(reply).toContain("- …and 40 more unread.");
  });

  it("adds no count line when every unread email is listed", () => {
    const { reply } = buildRuleBasedBriefing({ emails: unreadEmails(4), unreadCount: 4, todayEvents: [], reason: "" });
    expect(reply).not.toContain("more unread");
    expect(reply.split("\n").filter((line) => line.startsWith("- **Sender"))).toHaveLength(4);
  });
});

describe("the chat prompt with a large inbox", () => {
  const source = readFileSync(new URL("../src/server/chat-turn.server.ts", import.meta.url), "utf8");

  it("gives the model at most 15 real emails and asks for at most ten bullets", () => {
    expect(source).toContain("const PROMPT_EMAIL_LIMIT = 15;");
    expect(source).toContain(".slice(0, PROMPT_EMAIL_LIMIT)");
    expect(source).toContain("at most ${INBOX_LIST_LIMIT} bullets");
    expect(source).not.toContain("Do NOT skip any unread email");
  });
});
