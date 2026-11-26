/**
 * Live-check fixes of 26 Nov 2026: the demo briefing's wording (L4), proposals that cannot be
 * saved and the Today count (L1, L6), the phone-width chat hint and Profile link (L8) and the
 * login toast (L9).
 */
import { readFileSync } from "node:fs";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { buildRuleBasedBriefing } from "@/server/ai/briefing-fallback.server";
import { fetchMockEmails } from "@/server/connectors/gmail.mock";
import { proposalRefusal, startsBeforeNow, todayTabCount } from "@/lib/panel-state";

vi.mock("@/functions/google.functions", () => ({
  saveCalendarEvent: vi.fn(),
  saveGmailDraft: vi.fn(),
  updateCalendarEvent: vi.fn(),
  removeCalendarEvent: vi.fn(),
  getGoogleConnectionStatus: vi.fn(),
}));
vi.mock("@/functions/chat.functions", () => ({
  dismissChatCard: vi.fn(),
  ensureChatSession: vi.fn(),
  fetchSessionHistory: vi.fn(),
  processChat: vi.fn(),
  fetchCalendar: vi.fn(),
}));

const { PendingEventCard } = await import("@/components/workspace/ContextPanel");
const { ChatComposer, SHORT_PLACEHOLDER, LONG_PLACEHOLDER } = await import("@/components/workspace/ChatComposer");

const ZRH = "Europe/Zurich";
const NOW = Date.parse("2026-11-26T17:30:00Z");
const noop = () => undefined;
const html = (component: ComponentType<never>, props: Record<string, unknown>) =>
  renderToStaticMarkup(createElement(component as ComponentType<Record<string, unknown>>, props));

describe("the demo briefing's priorities line (L4)", () => {
  const emails = fetchMockEmails(ZRH, NOW);
  const base = { emails, unreadCount: 4, todayEvents: [], timeZone: ZRH, reason: "", header: "Here is your briefing", nowMs: NOW };

  it("reads as a quick summary and invites the assistant's own ranking", () => {
    const { reply } = buildRuleBasedBriefing({ ...base, inviteAiRanking: true });
    expect(reply).toContain("This is a quick summary");
    expect(reply).toContain('Ask "Look into my calendar and tell me priorities" for the assistant\'s own ranking.');
    expect(reply).not.toContain("ranked by rule");
  });

  it("a briefing written because the model could not be used keeps the old line", () => {
    const { reply } = buildRuleBasedBriefing({ ...base, header: "limit reached" });
    expect(reply).toContain("Priorities are on the right, ranked by rule");
    expect(reply).not.toContain('Ask "Look into');
  });
});

describe("proposals that cannot be saved (L1, L6)", () => {
  it("a start before now is over; the server's own refusal also blocks Save", () => {
    expect(startsBeforeNow("2026-11-26T07:00:00Z", NOW)).toBe(true);
    expect(startsBeforeNow("2026-11-26T18:00:00Z", NOW)).toBe(false);
    expect(startsBeforeNow("not a date", NOW)).toBe(false);
    expect(proposalRefusal({ starts_at: "2026-11-26T07:00:00Z" }, NOW)).toBe("This time is already over.");
    expect(proposalRefusal({ starts_at: "2026-11-26T18:00:00Z", refusal: 'This time overlaps "Sync".' }, NOW)).toBe('This time overlaps "Sync".');
    expect(proposalRefusal({ starts_at: "2026-11-26T18:00:00Z" }, NOW)).toBeNull();
  });

  it("the card of a time that is over, or with a known overlap, has Save switched off", () => {
    const over = html(PendingEventCard, {
      ev: { id: "pending-1", title: "Reading", starts_at: "2020-01-01T08:00:00.000Z", ends_at: "2020-01-01T09:00:00.000Z" },
      onSaved: noop,
      onDismiss: noop,
    });
    expect(over).toMatch(/<button[^>]*disabled=""[^>]*>.*Save to Calendar/);
    expect(over).toContain("This time is already over.");

    const clash = html(PendingEventCard, {
      ev: { id: "pending-2", title: "Gym", starts_at: "2099-01-01T18:00:00.000Z", ends_at: "2099-01-01T19:00:00.000Z", refusal: 'This time overlaps "Team sync".' },
      onSaved: noop,
      onDismiss: noop,
    });
    expect(clash).toMatch(/<button[^>]*disabled=""[^>]*>.*Save to Calendar/);
    expect(clash).toContain('This time overlaps &quot;Team sync&quot;.');

    const fine = html(PendingEventCard, {
      ev: { id: "pending-3", title: "Gym", starts_at: "2099-01-01T18:00:00.000Z", ends_at: "2099-01-01T19:00:00.000Z" },
      onSaved: noop,
      onDismiss: noop,
    });
    expect(fine).not.toMatch(/<button[^>]*disabled=""[^>]*>.*Save to Calendar/);
  });

  it("the Today count has today's events and the proposals for today only", () => {
    const noon = new Date(2026, 10, 26, 12, 0, 0);
    const at = (day: number, hour: number) => new Date(2026, 10, day, hour, 0, 0).toISOString();
    const schedule = [{ title: "Sync", starts_at: at(26, 19), ends_at: at(26, 20) }];
    const pending = [
      { starts_at: at(26, 15), ends_at: at(26, 16) },
      { starts_at: at(28, 15), ends_at: at(28, 16) },
      { starts_at: at(30, 15), ends_at: at(30, 16) },
    ];
    const changes = [
      { id: "c1", kind: "delete" as const, event_id: "e1", original: { title: "Old", starts_at: at(27, 9), ends_at: at(27, 10) } },
    ];
    expect(todayTabCount(schedule, pending, changes, noon)).toBe(2);
    expect(todayTabCount([], [], [], noon)).toBe(0);
  });
});

describe("phone width (L8)", () => {
  it("the chat box has a short hint for narrow screens and keeps the long one for wide ones", () => {
    expect(SHORT_PLACEHOLDER.length).toBeLessThan(30);
    expect(LONG_PLACEHOLDER.length).toBeGreaterThan(SHORT_PLACEHOLDER.length);
    // Rendered on the server (no screen yet): the long hint, as before.
    const markup = html(ChatComposer, { onSend: noop, busy: false, showSuggestions: false });
    expect(markup).toContain(`placeholder="${LONG_PLACEHOLDER}"`);
  });

  it("the header has a Profile link for phones, shown below sm only", () => {
    const source = readFileSync("src/routes/app.tsx", "utf8");
    expect(source).toMatch(/to="\/app\/profile"\s+aria-label="Profile"[\s\S]*?className="[^"]*\bsm:hidden\b/);
  });
});

describe("the demo login toast (L9)", () => {
  it("does not call the public demo private", () => {
    const source = readFileSync("src/routes/login.tsx", "utf8");
    expect(source).toContain("Welcome to your own copy of the MONDAY demo");
    expect(source).not.toContain("private MONDAY demo");
  });
});
