/**
 * Review of 25 Nov 2026 (finding 42): the demo inbox's texts depend on the day and the time
 * ("Lunch next Saturday?" on a Saturday afternoon), and the briefing tests that read it on the real
 * clock failed every Saturday afternoon. The inbox at a given moment must not depend on the clock,
 * and on the clock the briefing must cover the inbox it was built from, at any time of the week.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { briefingCoversInbox, buildRuleBasedBriefing } from "@/server/ai/briefing-fallback.server";
import { fetchMockEmails, getMockEmail } from "@/server/connectors/gmail.mock";

const ZRH = "Europe/Zurich";
// The moments the inbox tests fix: Mon 9 Nov 2026 15:08, Tue 10 Nov 09:00 and Tue 24 Nov 10:00 in Zurich.
const FIXED = [
  Date.parse("2026-11-09T14:08:00Z"),
  Date.parse("2026-11-10T08:00:00Z"),
  Date.parse("2026-11-24T09:00:00Z"),
];
// System clocks to run them under (Zurich is UTC+1 in November).
const CLOCKS = [
  "2026-11-28T12:30:00Z", // Saturday 13:30 in Zurich
  "2026-11-28T20:00:00Z", // Saturday 21:00 in Zurich
  "2026-11-28T11:59:00Z", // Saturday 12:59 in Zurich, the minute before lunch is over
  "2026-11-28T13:00:00Z", // Saturday 13:00 UTC (the zone the inbox uses without one)
  "2026-11-28T23:30:00Z", // Sunday 00:30 in Zurich, still Saturday in UTC
  "2026-11-29T10:00:00Z", // Sunday morning
  "2026-11-30T06:30:00Z", // Monday 07:30 in Zurich
  "2026-11-27T22:30:00Z", // Friday 23:30 in Zurich
];

afterEach(() => {
  vi.useRealTimers();
});

describe("the demo inbox at a given moment does not depend on the clock", () => {
  const baseline = FIXED.map((nowMs) => fetchMockEmails(ZRH, nowMs));

  it.each(CLOCKS)("with the clock at %s", (clock) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(clock));
    FIXED.forEach((nowMs, index) => {
      expect(fetchMockEmails(ZRH, nowMs)).toEqual(baseline[index]);
      for (const email of baseline[index]) {
        expect(getMockEmail(email.id, ZRH, nowMs)).toEqual(email);
      }
    });
  });
});

describe("on the clock, the demo inbox and its briefing agree at any time of the week", () => {
  it.each(CLOCKS)("with the clock at %s", (clock) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(clock));
    for (const zone of [undefined, ZRH]) {
      const emails = fetchMockEmails(zone);
      expect(getMockEmail("e3", zone)).toEqual(emails.find((email) => email.id === "e3"));
      const { reply } = buildRuleBasedBriefing({
        emails,
        unreadCount: 4,
        todayEvents: [],
        timeZone: ZRH,
        reason: "timeout",
      });
      expect(briefingCoversInbox({ reply, emails, unreadCount: 4, todayEvents: [] })).toBe(true);
    }
    // Lunch is next Saturday's from 1 PM on a Saturday in the user's zone, else this Saturday's.
    const local = new Date(Date.parse(clock) + 3_600_000);
    const afterLunchOnSaturday = local.getUTCDay() === 6 && local.getUTCHours() >= 13;
    expect(getMockEmail("e3", ZRH)?.subject).toBe(
      afterLunchOnSaturday ? "Lunch next Saturday?" : "Lunch this Saturday?",
    );
  });
});
