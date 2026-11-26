import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { START_GRACE_MS, splitProposalsByDay, startsBeforeNow, todayTabCount } from "@/lib/panel-state";

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
const { ScheduleView } = await import("@/components/workspace/ContextPanel");

const NOW = new Date(2026, 10, 26, 12, 0, 0); // local noon
const at = (dayOffset: number, hour: number) => new Date(2026, 10, 26 + dayOffset, hour).toISOString();
const ev = (id: string, dayOffset: number) => ({ id, title: `Event ${id}`, starts_at: at(dayOffset, 15), ends_at: at(dayOffset, 16) });

describe("start grace period (H6)", () => {
  it("a start up to 10 minutes ago is allowed, one further back is not", () => {
    const now = NOW.getTime();
    expect(startsBeforeNow(new Date(now - 5 * 60_000).toISOString(), now)).toBe(false);
    expect(startsBeforeNow(new Date(now - START_GRACE_MS).toISOString(), now)).toBe(false);
    expect(startsBeforeNow(new Date(now - START_GRACE_MS - 60_000).toISOString(), now)).toBe(true);
  });
});

describe("the Today tab: count and list agree (H3)", () => {
  it("splits proposals into today and later; the badge counts today only", () => {
    const events = [ev("a", 0), ev("b", 2)];
    const split = splitProposalsByDay(events, [], NOW);
    expect(split.today.events.map((e) => e.id)).toEqual(["a"]);
    expect(split.later.events.map((e) => e.id)).toEqual(["b"]);
    expect(todayTabCount([], events, [], NOW)).toBe(1);
  });

  it("lists other-day proposals under a Later heading", () => {
    const noop = () => undefined;
    const html = renderToStaticMarkup(
      createElement(ScheduleView, {
        schedule: [],
        pendingEvents: [ev("b", 3)],
        pendingEventChanges: [],
        onPendingSaved: noop,
        onPendingDismiss: noop,
        onPendingChangeApplied: noop,
        onPendingChangeDismiss: noop,
      }),
    );
    expect(html).toContain("Later");
    expect(html).toContain("Event b");
  });
});
