import { describe, expect, it } from "vitest";
import {
  canWrapEventTime,
  hourLabel,
  isCompactEvent,
  positionOnDay,
  settleUnlessCancelled,
  startOfWeekMonday,
  THREE_LINE_EVENT_MIN_PX,
  TWO_LINE_EVENT_MIN_PX,
} from "@/lib/calendar-grid";
import { formatLocalDate } from "@/lib/date";

// Local times, whatever zone the tests run in.
const local = (y: number, m: number, d: number, h: number, min = 0) => new Date(y, m - 1, d, h, min);

// The Plan page's rule (src/routes/app.plan.tsx startOfWeekMondayISO), copied here so the two
// pages can be checked against each other.
function planWeekStart(d: Date): string {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  const dow = x.getDay();
  x.setDate(x.getDate() + (dow === 0 ? -6 : 1 - dow));
  return formatLocalDate(x);
}

// Recent ICU versions put a narrow no-break space before AM/PM.
const plain = (s: string) => s.replace(/[\u202f\u00a0]/g, " ");

describe("calendar weeks start on Monday, like Plan and the dashboard", () => {
  it("puts Tuesday 24 and Sunday 29 November 2026 in the week of Monday 23 November", () => {
    expect(formatLocalDate(startOfWeekMonday(local(2026, 11, 24, 10)))).toBe("2026-11-23");
    expect(formatLocalDate(startOfWeekMonday(local(2026, 11, 29, 23, 30)))).toBe("2026-11-23");
    expect(formatLocalDate(startOfWeekMonday(local(2026, 11, 30, 0, 5)))).toBe("2026-11-30");
    const start = startOfWeekMonday(local(2026, 11, 26, 15));
    expect([start.getHours(), start.getMinutes(), start.getDay()]).toEqual([0, 0, 1]);
  });

  it("agrees with the Plan page for every day of a week, including the week the clocks change", () => {
    for (let day = 23; day <= 29; day++) {
      const d = local(2026, 11, day, 12);
      expect(formatLocalDate(startOfWeekMonday(d))).toBe(planWeekStart(d));
    }
    // Europe's clocks go forward on Sunday 29 March and back on Sunday 25 October 2026.
    for (const d of [local(2026, 3, 29, 12), local(2026, 3, 30, 1), local(2026, 10, 25, 12)]) {
      expect(formatLocalDate(startOfWeekMonday(d))).toBe(planWeekStart(d));
    }
  });
});

describe("calendar hour labels", () => {
  it("labels midnight 12 AM, not 0 AM, on a 12-hour clock", () => {
    expect(plain(hourLabel(0, "en-US"))).toBe("12 AM");
    expect(plain(hourLabel(12, "en-US"))).toBe("12 PM");
    expect(plain(hourLabel(19, "en-US"))).toBe("7 PM");
  });

  it("uses the 24-hour clock where the locale does, written like the event times", () => {
    expect(hourLabel(19, "de-CH")).toBe("19:00");
    expect(hourLabel(19, "en-GB")).toBe("19:00");
    for (const locale of ["de-CH", "en-GB", "fr-CH"]) {
      for (let h = 0; h < 24; h++) {
        // The event boxes format their times with these options (fmt in app.calendar.tsx).
        expect(hourLabel(h, locale)).toBe(local(2026, 11, 24, h).toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" }));
        expect(hourLabel(h, locale)).toMatch(/^\d{1,2}:00$/);
      }
    }
  });

  it("never prints the old '0 AM' in any of a range of locales", () => {
    for (const locale of ["en-US", "en-GB", "de-CH", "fr-CH", "it-CH", "en-IN", "ja-JP"]) {
      for (let h = 0; h < 24; h++) expect(plain(hourLabel(h, locale))).not.toMatch(/^0 /);
    }
  });
});

describe("short calendar events", () => {
  it("lays out a 30- or 45-minute event on one line so its time is not cut off", () => {
    const day = local(2026, 11, 24, 0);
    const half = { starts_at: local(2026, 11, 24, 10).toISOString(), ends_at: local(2026, 11, 24, 10, 30).toISOString() };
    const threeQuarters = { starts_at: local(2026, 11, 24, 10).toISOString(), ends_at: local(2026, 11, 24, 10, 45).toISOString() };
    const hour = { starts_at: local(2026, 11, 24, 10).toISOString(), ends_at: local(2026, 11, 24, 11).toISOString() };
    const height = (e: { starts_at: string; ends_at: string }) => positionOnDay(e, day, 6, 48)!.height;
    expect(height(half)).toBe(22);
    expect(isCompactEvent(height(half))).toBe(true);
    expect(isCompactEvent(height(threeQuarters))).toBe(true);
    expect(isCompactEvent(height(hour))).toBe(false);
    expect(TWO_LINE_EVENT_MIN_PX).toBeLessThanOrEqual(height(hour));
  });

  it("lets the time range wrap only in a box tall enough for a third line", () => {
    const day = local(2026, 11, 24, 0);
    const box = (minutes: number) =>
      positionOnDay({ starts_at: local(2026, 11, 24, 10).toISOString(), ends_at: local(2026, 11, 24, 10, minutes).toISOString() }, day, 6, 48)!.height;
    // A one-hour box (46 px) holds the title and one time line; a wrapped range was cut in half.
    expect(canWrapEventTime(box(60))).toBe(false);
    expect(canWrapEventTime(box(90))).toBe(true);
    expect(THREE_LINE_EVENT_MIN_PX).toBeGreaterThan(box(60));
  });
});

describe("calendar week loads", () => {
  function deferred<T>() {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  it("ignores a slow answer for a week the user already left (it used to replace the newer week)", async () => {
    const shown: string[] = [];
    const settled: string[] = [];
    const weekA = deferred<string>();
    const weekB = deferred<string>();
    // The page starts week A, the user clicks Next (effect cleanup cancels A), week B loads.
    const cancelA = settleUnlessCancelled(weekA.promise, { onResult: (v) => shown.push(v), onError: () => {}, onSettled: () => settled.push("A") });
    cancelA();
    settleUnlessCancelled(weekB.promise, { onResult: (v) => shown.push(v), onError: () => {}, onSettled: () => settled.push("B") });
    weekB.resolve("events of week B");
    await weekB.promise;
    weekA.resolve("events of week A");
    await new Promise((r) => setTimeout(r, 0));
    expect(shown).toEqual(["events of week B"]);
    expect(settled).toEqual(["B"]);
  });

  it("ignores a late failure of a cancelled load, and reports one that is still current", async () => {
    const errors: unknown[] = [];
    const old = deferred<string>();
    settleUnlessCancelled(old.promise, { onResult: () => {}, onError: (e) => errors.push(e) })();
    old.reject(new Error("old week failed"));
    const current = deferred<string>();
    settleUnlessCancelled(current.promise, { onResult: () => {}, onError: (e) => errors.push(e) });
    current.reject(new Error("this week failed"));
    await new Promise((r) => setTimeout(r, 0));
    expect(errors.map((e) => (e as Error).message)).toEqual(["this week failed"]);
  });
});
