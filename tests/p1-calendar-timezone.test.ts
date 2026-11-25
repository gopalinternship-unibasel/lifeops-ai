/**
 * Review of 24 Nov 2026: wall-clock times at a daylight-saving switch (finding 20) and
 * model-supplied date-times that are not real ISO date-times (finding 22).
 */
import { describe, expect, it } from "vitest";
import { localTimeToISO, parseUserDateTime } from "@/server/calendar/time-ranges.server";
import { zonedDateTimeToISO } from "@/server/timezone.server";

const ZRH = "Europe/Zurich";

describe("zonedDateTimeToISO at a daylight-saving switch", () => {
  it("moves a time that does not exist forward by the gap, in every zone", () => {
    // 28 Mar 2027, Zurich: 02:00 CET jumps to 03:00 CEST, so 02:30 is 03:30 CEST.
    expect(zonedDateTimeToISO("2027-03-28", { hour: 2, minute: 30 }, ZRH)).toBe(
      "2027-03-28T01:30:00.000Z",
    );
    // 14 Mar 2027, New York: 02:30 is 03:30 EDT (this direction was already right).
    expect(zonedDateTimeToISO("2027-03-14", { hour: 2, minute: 30 }, "America/New_York")).toBe(
      "2027-03-14T07:30:00.000Z",
    );
    // 30 Apr 2027, Cairo: clocks go from 00:00 to 01:00, so the day starts at 01:00 local, not
    // at 23:00 the day before.
    expect(zonedDateTimeToISO("2027-04-30", { hour: 0 }, "Africa/Cairo")).toBe(
      "2027-04-29T22:00:00.000Z",
    );
  });

  it("keeps a range across the gap in order", () => {
    const before = localTimeToISO("2027-03-28", "01:45", ZRH)!;
    const after = localTimeToISO("2027-03-28", "02:15", ZRH)!;
    expect(Date.parse(after)).toBeGreaterThan(Date.parse(before));
  });

  it("reads a time that occurs twice as the first one, in every zone", () => {
    // 25 Oct 2026, Zurich: 02:30 happens in CEST, then again in CET; the first is 00:30Z.
    expect(zonedDateTimeToISO("2026-10-25", { hour: 2, minute: 30 }, ZRH)).toBe(
      "2026-10-25T00:30:00.000Z",
    );
    // 1 Nov 2026, New York: 01:30 EDT comes first (05:30Z).
    expect(zonedDateTimeToISO("2026-11-01", { hour: 1, minute: 30 }, "America/New_York")).toBe(
      "2026-11-01T05:30:00.000Z",
    );
  });

  it("leaves ordinary times alone", () => {
    expect(zonedDateTimeToISO("2026-11-24", { hour: 9 }, ZRH)).toBe("2026-11-24T08:00:00.000Z");
    expect(
      zonedDateTimeToISO("2026-07-01", { hour: 9, minute: 15, second: 30, millisecond: 250 }, ZRH),
    ).toBe("2026-07-01T07:15:30.250Z");
    expect(zonedDateTimeToISO("2026-11-24", { hour: 24 }, ZRH)).toBe("2026-11-24T23:00:00.000Z");
    expect(zonedDateTimeToISO("2026-11-24", { hour: 9 }, "Asia/Kolkata")).toBe(
      "2026-11-24T03:30:00.000Z",
    );
  });
});

describe("parseUserDateTime only reads real ISO date-times", () => {
  it("rejects impossible clock values instead of rolling them over", () => {
    expect(parseUserDateTime("2026-11-24T25:00:00", ZRH)).toBeNull();
    expect(parseUserDateTime("2026-11-24T23:75", ZRH)).toBeNull();
    expect(parseUserDateTime("2026-11-24T12:00:60", ZRH)).toBeNull();
    expect(parseUserDateTime("2026-11-24T24:30", ZRH)).toBeNull();
    expect(parseUserDateTime("2026-11-24T25:00:00Z", ZRH)).toBeNull();
    expect(parseUserDateTime("2026-02-30T10:00:00Z", ZRH)).toBeNull();
    expect(parseUserDateTime("2026-02-30T10:00:00", ZRH)).toBeNull();
    // 24:00 is the end of the day.
    expect(parseUserDateTime("2026-11-24T24:00", ZRH)).toBe("2026-11-24T23:00:00.000Z");
  });

  it("does not read a date alone or other text in the server's own zone", () => {
    expect(parseUserDateTime("Tue 2026-11-24 19:00", ZRH)).toBeNull();
    expect(parseUserDateTime("Nov 24 2026 19:00", ZRH)).toBeNull();
    expect(parseUserDateTime("2026-11-24", ZRH)).toBeNull();
    expect(parseUserDateTime("tomorrow at 7", ZRH)).toBeNull();
  });

  it("still reads local and offset date-times, with fractions of a second", () => {
    expect(parseUserDateTime("2026-11-24T19:00", ZRH)).toBe("2026-11-24T18:00:00.000Z");
    expect(parseUserDateTime("2026-11-24T19:00+01:00", ZRH)).toBe("2026-11-24T18:00:00.000Z");
    expect(parseUserDateTime("2026-11-24T19:00:00-05:00", ZRH)).toBe("2026-11-25T00:00:00.000Z");
    expect(parseUserDateTime("2026-11-24T19:00:00+0530", ZRH)).toBe("2026-11-24T13:30:00.000Z");
    expect(parseUserDateTime("2026-11-24T19:00:00.000Z", ZRH)).toBe("2026-11-24T19:00:00.000Z");
    // The planner's Python timestamps carry microseconds.
    expect(parseUserDateTime("2026-11-24T18:00:00.123456+00:00", ZRH)).toBe(
      "2026-11-24T18:00:00.123Z",
    );
    expect(parseUserDateTime("2026-11-24T19:00:00.57", ZRH)).toBe("2026-11-24T18:00:00.570Z");
    expect(parseUserDateTime(" 2026-11-24 19:00:00 ", ZRH)).toBe("2026-11-24T18:00:00.000Z");
  });
});
