/**
 * Review of 24 Nov 2026: how the calendar rules read times, dates and amounts in a move request.
 * Finding 1 (dotted times "8.15 pm", "14.30", "14h30"), 3 (numeric and impossible dates), 21
 * ("midnight"), 25 ("an hour and a half", "1h30", "three hours later") and 27 ("tonight at 9",
 * "May 30" asked in November, "13 am"). Each reading is tested both ways: what must be read, and
 * what must not be.
 */
import { describe, expect, it } from "vitest";
import {
  parseChangeRequest,
  reconcileCalendarChanges,
  type KnownEvent,
  type ModelChange,
} from "@/server/calendar/change-request.server";

const ZRH = "Europe/Zurich";
const TODAY = "2026-11-24"; // a Tuesday
const NOW = Date.parse("2026-11-24T09:00:00Z"); // 10:00 in Zurich (UTC+1 in November)

/** A Zurich wall-clock time in November (UTC+1) as an ISO instant. */
const zrh = (date: string, hour: number, minute = 0) =>
  new Date(
    Date.parse(`${date}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00Z`) -
      3_600_000,
  ).toISOString();

// The demo calendar as a user sees it on Tuesday 24 Nov.
const EVENTS: KnownEvent[] = [
  {
    id: "sync",
    title: "Team sync — demo walkthrough",
    starts_at: zrh("2026-11-24", 19),
    ends_at: zrh("2026-11-24", 20),
  },
  {
    id: "lecture",
    title: "Lecture — Distributed Systems",
    starts_at: zrh("2026-11-25", 10),
    ends_at: zrh("2026-11-25", 12),
  },
  {
    id: "dentist",
    title: "Dentist appointment",
    starts_at: zrh("2026-11-26", 14),
    ends_at: zrh("2026-11-26", 15, 30),
  },
  {
    id: "acme",
    title: "Acme onsite interview",
    starts_at: zrh("2026-11-30", 10),
    ends_at: zrh("2026-11-30", 12),
  },
];
const event = (id: string) => EVENTS.find((e) => e.id === id)!;
const update = (
  id: string,
  date: string,
  from: [number, number],
  to: [number, number],
): ModelChange => ({
  kind: "update",
  event: event(id),
  starts_at: zrh(date, ...from),
  ends_at: zrh(date, ...to),
});

function reconcile(message: string, modelChanges: ModelChange[] = []) {
  return reconcileCalendarChanges({
    message,
    today: TODAY,
    timeZone: ZRH,
    nowMs: NOW,
    events: EVENTS,
    modelChanges,
    modelProposals: [],
  });
}
const parse = (message: string) => parseChangeRequest(message, TODAY);

describe("dotted and 'h' times (finding 1)", () => {
  it.each([
    ["Move the team sync to 8.15 pm", [1215]],
    ["Move the team sync to 6.20 pm", [1100]],
    ["Move the team sync to 9.10 am", [550]],
    ["Move the team sync to 9.10pm", [1270]],
    ["Move the lecture to 14.30", [870]],
    ["Move the lecture to 14h30", [870]],
    ["Move the lecture to 16:00", [960]],
    ["Move the team sync to at 8.45 pm", [1245]],
  ])("%s -> start %j", (message, minutes) => {
    expect(parse(message)?.start?.minutes).toEqual(minutes);
  });

  it("reads a dotted range", () => {
    const request = parse("Move the team sync to 8.15-9.45 pm");
    expect(request?.start?.minutes).toEqual([1215]);
    expect(request?.end?.minutes).toEqual([1305]);
  });

  it("does not read am or pm after an hour that cannot have it", () => {
    for (const message of [
      "Move the team sync to 15 pm",
      "Move the team sync to 20 pm",
      "Move the team sync to 0 am",
    ]) {
      expect(parse(message)?.start, message).toBeUndefined();
      expect(parse(message)?.vagueTime, message).toBe(true);
    }
    expect(parse("Move the team sync to 3-15 pm")?.start).toBeUndefined();
  });

  it("does not read a numeric date as a time", () => {
    const request = parse("Move the dentist appointment to 01.12.2026");
    expect(request?.start).toBeUndefined();
    expect(request?.day).toMatchObject({ dates: ["2026-12-01"] });
    // "9.10" is 9 Oct or 9:10: neither is applied by rule.
    const unclear = parse("Move the team sync to 9.10");
    expect(unclear?.start).toBeUndefined();
    expect(unclear?.day).toBeUndefined();
    expect(unclear?.vagueTime).toBe(true);
    // ... unless "at" says it is a time.
    expect(parse("Move the team sync to tomorrow at 9.10")?.start?.minutes).toEqual([550, 1270]);
  });

  it("keeps the model's correct 20:15 for '8.15 pm' instead of 'correcting' it to 15:00", () => {
    const result = reconcile("Move the team sync to 8.15 pm", [
      update("sync", "2026-11-24", [20, 15], [21, 15]),
    ]);
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0].next).toEqual({
      starts_at: zrh("2026-11-24", 20, 15),
      ends_at: zrh("2026-11-24", 21, 15),
    });
    expect(result.log.join(" ")).not.toMatch(/corrected the model's time/);
    expect(result.note).toBeUndefined();
  });

  it("uses the model's time for '15 pm' instead of making one up", () => {
    const result = reconcile("Move the team sync to 15 pm", [
      update("sync", "2026-11-24", [15, 0], [16, 0]),
    ]);
    expect(result.changes[0]).toMatchObject({
      byRule: false,
      next: { starts_at: zrh("2026-11-24", 15) },
    });
    expect(reconcile("Move the team sync to 15 pm").changes).toEqual([]);
  });
});

describe("numeric and impossible dates (finding 3)", () => {
  it("reads day-first numeric dates", () => {
    expect(parse("Move the dentist appointment to 1.12. at 4 pm")).toMatchObject({
      day: { dates: ["2026-12-01"] },
      start: { minutes: [960] },
    });
    expect(parse("Move the dentist appointment to 01.12.2026 at 16:00")).toMatchObject({
      day: { dates: ["2026-12-01"] },
      start: { minutes: [960] },
    });
    expect(parse("Move the dentist appointment to 1.12.26 at 4 pm")?.day).toMatchObject({
      dates: ["2026-12-01"],
    });
    expect(parse("Move the dentist appointment to 28/11 at 4 pm")?.day).toMatchObject({
      dates: ["2026-11-28"],
    });
    expect(parse("Move the dentist appointment to 11/28 at 4 pm")?.day).toMatchObject({
      dates: ["2026-11-28"],
    });
    expect(parse("Move the dentist appointment to 25.12 at 4 pm")?.day).toMatchObject({
      dates: ["2026-12-25"],
    });
  });

  it("moves to the date the message names, not on the event's own day", () => {
    const result = reconcile("Move the dentist appointment to 01.12.2026 at 16:00", [
      update("dentist", "2026-12-01", [16, 0], [17, 30]),
    ]);
    expect(result.changes[0].next).toEqual({
      starts_at: "2026-12-01T15:00:00.000Z",
      ends_at: "2026-12-01T16:30:00.000Z",
    });
    const byRule = reconcile("Move the dentist appointment to 28/11 at 4 pm");
    expect(byRule.changes[0]).toMatchObject({
      byRule: true,
      next: { starts_at: "2026-11-28T15:00:00.000Z" },
    });
  });

  it("asks which date when a slash date reads both ways", () => {
    const result = reconcile("Move the dentist appointment to 1/12 at 4 pm");
    expect(result.changes).toEqual([]);
    // The options carry their year, as one of them is next year.
    expect(result.note).toMatch(
      /Which day did you mean for \*\*Dentist appointment\*\*: Tue, Dec 1, 2026 or Tue, Jan 12, 2027\?/,
    );
  });

  // Reviewer of 24 Nov 2026: "3.12 at 4 pm" was moved on the event's own day by rule; only the
  // time was read.
  it("reads a day.month pair as the date when a time follows it or 'on' comes before it", () => {
    const dec3 = { starts_at: "2026-12-03T15:00:00.000Z", ends_at: "2026-12-03T16:30:00.000Z" };
    const withModel = reconcile("Move the dentist appointment to 3.12 at 4 pm", [
      update("dentist", "2026-12-03", [16, 0], [17, 30]),
    ]);
    expect(withModel.changes).toHaveLength(1);
    expect(withModel.changes[0].next).toEqual(dec3);
    expect(withModel.log.join(" ")).not.toMatch(/corrected the model's time/);
    // Without the model: Dec 3, not Thursday Nov 26.
    expect(reconcile("Move the dentist appointment to 3.12 at 4 pm").changes[0].next).toEqual(dec3);
    for (const message of [
      "Move the dentist appointment to 1.12 at 4 pm",
      "Move the dentist appointment to 1.12 4 pm",
      "Move the dentist appointment to 1.12 at 16:00",
      "Move the dentist appointment to 1.12, 4 pm",
    ]) {
      expect(reconcile(message).changes[0]?.next?.starts_at, message).toBe(
        "2026-12-01T15:00:00.000Z",
      );
    }
    expect(
      reconcile("Move the dentist appointment to 4 pm on 3.12").changes[0].next?.starts_at,
    ).toBe("2026-12-03T15:00:00.000Z");
    // "1.12 at 4": Dec 1, and 4 AM or 4 PM is asked.
    expect(reconcile("Move the dentist appointment to 1.12 at 4").note).toMatch(
      /Did you mean 4:00 AM or 4:00 PM/,
    );
  });

  it("asks which date when a day.month pair is left next to the time", () => {
    for (const message of [
      "Move the dentist appointment to 4 pm, 3.12",
      "Move the dentist appointment to 4 pm 3.12",
      "Move the dentist appointment to 4 pm, 3/12",
    ]) {
      const result = reconcile(message);
      expect(result.changes, message).toEqual([]);
      expect(result.note, message).toMatch(
        /Which date should \*\*Dentist appointment\*\* move to\?/,
      );
    }
  });

  it("does not read a dotted number in a name or an amount as a leftover date", () => {
    expect(
      reconcile("Move the team sync to 8 pm for the 2.5 release").changes[0].next?.starts_at,
    ).toBe(zrh("2026-11-24", 20));
    expect(parse("Move the team sync to 8 pm for 1.5 hours")).toMatchObject({
      start: { minutes: [1200] },
      durationMin: 90,
      dayUnclear: false,
    });
    // "at 9.10" is still a time.
    expect(parse("Move the team sync to tomorrow at 9.10")?.start?.minutes).toEqual([550, 1270]);
  });

  it.each([
    "Move the dentist appointment to Nov 31 at 4 pm",
    "Move the dentist appointment to the 31st at 4 pm",
    "Move the dentist appointment to 2026-11-31 at 4 pm",
    "Move the dentist appointment to 31.11. at 4 pm",
    "Move the dentist appointment to 30th of February at 4 pm",
  ])("asks which date for a date that does not exist: %s", (message) => {
    const result = reconcile(message);
    expect(result.changes).toEqual([]);
    expect(result.note).toMatch(/which date/i);
  });

  it("does not read numbers in an event's name, or amounts, as dates", () => {
    const events: KnownEvent[] = [
      ...EVENTS,
      {
        id: "run",
        title: "2.5 km run",
        starts_at: zrh("2026-11-26", 7),
        ends_at: zrh("2026-11-26", 7, 30),
      },
      {
        id: "chapter",
        title: "Read chapter 1.2",
        starts_at: zrh("2026-11-25", 16),
        ends_at: zrh("2026-11-25", 17),
      },
    ];
    const run = (message: string, modelChanges: ModelChange[] = []) =>
      reconcileCalendarChanges({
        message,
        today: TODAY,
        timeZone: ZRH,
        nowMs: NOW,
        events,
        modelChanges,
        modelProposals: [],
      });
    expect(parse("Move my 2.5 km run to Friday")).toMatchObject({
      sourceDay: undefined,
      day: { dates: ["2026-11-27"] },
    });
    expect(run("Move my 2.5 km run to Friday").changes[0]).toMatchObject({
      event: { id: "run" },
      next: { starts_at: zrh("2026-11-27", 7) },
    });
    expect(run("Move read chapter 1.2 to Friday at 5 pm").changes[0]).toMatchObject({
      event: { id: "chapter" },
      next: { starts_at: zrh("2026-11-27", 17) },
    });
    // Not read as a request; the model's move is kept, as no day is named.
    const later = {
      kind: "update" as const,
      event: events.find((e) => e.id === "run")!,
      starts_at: zrh("2026-11-26", 18),
      ends_at: zrh("2026-11-26", 18, 30),
    };
    expect(run("The 2.5 km run needs to be later", [later]).changes).toHaveLength(1);
    expect(parse("Push the team sync back 1/2 hour")?.day).toBeUndefined();
    // "before 25.12" is a limit, not the new day.
    expect(parse("Move the dentist appointment to before 25.12")?.day).toBeUndefined();
  });

  it("still reads dotted clock times next to dates (regression)", () => {
    expect(reconcile("Move the team sync to 8.15 pm").changes[0].next?.starts_at).toBe(
      zrh("2026-11-24", 20, 15),
    );
    expect(reconcile("Move the lecture to 14.30").changes[0].next?.starts_at).toBe(
      zrh("2026-11-25", 14, 30),
    );
    expect(
      reconcile("Move the dentist appointment to Dec 1 at 8.15 am").changes[0].next?.starts_at,
    ).toBe("2026-12-01T07:15:00.000Z");
  });
});

describe("midnight (finding 21)", () => {
  it("reads a lone midnight as the end of the day it names", () => {
    const tonight = reconcile("Move the team sync to midnight tonight");
    expect(tonight.note).toBeUndefined();
    expect(tonight.changes[0].next).toEqual({
      starts_at: "2026-11-24T23:00:00.000Z",
      ends_at: "2026-11-25T00:00:00.000Z",
    });
    const ends = reconcile("Move the dentist appointment to end at midnight");
    expect(ends.changes[0].next).toEqual({
      starts_at: "2026-11-26T13:00:00.000Z",
      ends_at: "2026-11-26T23:00:00.000Z",
    });
    expect(
      reconcile("Move the dentist appointment to Friday at midnight").changes[0].next?.starts_at,
    ).toBe("2026-11-27T23:00:00.000Z");
  });

  it("keeps midnight as the start or end of a range, and 24:00 (regression)", () => {
    expect(reconcile("Move the team sync to 10 pm until midnight").changes[0].next).toEqual({
      starts_at: "2026-11-24T21:00:00.000Z",
      ends_at: "2026-11-24T23:00:00.000Z",
    });
    expect(parse("Move the team sync to tomorrow from midnight to 2 am")).toMatchObject({
      start: { minutes: [0] },
      end: { minutes: [120] },
    });
    expect(reconcile("Move the team sync to 24:00").changes[0].next?.starts_at).toBe(
      "2026-11-24T23:00:00.000Z",
    );
  });
});

describe("amounts of time (finding 25)", () => {
  it.each([
    ["Push the team sync back an hour and a half", 90],
    ["Push the team sync back 1h30", 90],
    ["Move the team sync three hours later", 180],
    ["Move the team sync an hour and a half later", 90],
    ["Move the team sync one and a half hours later", 90],
    ["Move the team sync 1.5 hours later", 90],
    ["Push the team sync by 2h", 120],
    ["Delay the team sync by three hours", 180],
    ["Move the team sync 1 hour 30 minutes later", 90],
    ["Push the team sync back an hour and 15 minutes", 75],
    ["Push the team sync back 1h 30m", 90],
    // Regressions: the amounts that already worked.
    ["Push the team sync back by an hour", 60],
    ["Move the team sync 30 minutes earlier", -30],
    ["Bring the team sync forward half an hour", -30],
  ])("%s -> shift %i min", (message, minutes) => {
    const request = parse(message);
    expect(request?.shiftMin).toBe(minutes);
    expect(request?.subject).toBe("the team sync");
  });

  it.each([
    ["Move the team sync to 8 pm for 1h30", 90],
    ["Move the team sync to 8 pm for an hour and a half", 90],
    ["Move the team sync to 8 pm for half an hour", 30],
    ["Move the team sync to 8 pm for 2 hours", 120],
    ["Move the team sync to 8 pm for 45 min", 45],
  ])("%s -> duration %i min", (message, minutes) => {
    expect(parse(message)).toMatchObject({ start: { minutes: [1200] }, durationMin: minutes });
  });

  it("does not read a clock time as an amount, nor a bare number after 'by' as a deadline", () => {
    expect(parse("Move the team sync to 8 am")).toMatchObject({ start: { minutes: [480] } });
    expect(parse("Move the team sync to 8 am")?.shiftMin).toBeUndefined();
    expect(parse("Move the lecture to 14h30")?.shiftMin).toBeUndefined();
    expect(parse("Delay the team sync by 10")?.bounds).toBeUndefined();
    expect(parse("Move the team sync to tomorrow by 5 pm")?.bounds).toMatchObject({ latest: 1020 });
  });

  it("reads numbers in an event's name as part of the name", () => {
    const events: KnownEvent[] = [
      ...EVENTS,
      {
        id: "py",
        title: "Python 3.12 workshop",
        starts_at: zrh("2026-11-28", 9),
        ends_at: zrh("2026-11-28", 11),
      },
    ];
    const run = (message: string) =>
      reconcileCalendarChanges({
        message,
        today: TODAY,
        timeZone: ZRH,
        nowMs: NOW,
        events,
        modelChanges: [],
        modelProposals: [],
      });
    expect(run("Move the Python 3.12 workshop to Sunday").changes[0]).toMatchObject({
      event: { id: "py" },
      next: { starts_at: zrh("2026-11-29", 9) },
    });
    expect(run("Cancel the Python 3.12 workshop").changes).toEqual([
      { kind: "delete", event: events[4], byRule: true },
    ]);
    // A time named for the event, with "at", still narrows it down.
    expect(parse("Move the team sync at 19.00 to 9 pm")?.sourceClock?.minutes).toEqual([1140]);
    expect(reconcile("Move the team sync at 19h00 to 21h00").changes[0].next?.starts_at).toBe(
      zrh("2026-11-24", 21),
    );
  });

  it("applies the whole amount by rule", () => {
    expect(reconcile("Push the team sync back an hour and a half").changes[0].next).toEqual({
      starts_at: zrh("2026-11-24", 20, 30),
      ends_at: zrh("2026-11-24", 21, 30),
    });
    expect(reconcile("Move the team sync to 8 pm for 1h30").changes[0].next).toEqual({
      starts_at: zrh("2026-11-24", 20),
      ends_at: zrh("2026-11-24", 21, 30),
    });
  });

  it("finds the event and keeps the model's answer for times it does not work out", () => {
    const fromNow = reconcile("Move the team sync two hours from now", [
      update("sync", "2026-11-24", [12, 0], [13, 0]),
    ]);
    expect(fromNow.changes).toHaveLength(1);
    expect(fromNow.changes[0]).toMatchObject({
      byRule: false,
      next: { starts_at: zrh("2026-11-24", 12) },
    });
    expect(fromNow.note ?? "").not.toMatch(/could not find/);
    const quarterPast = reconcile("Move the team sync to quarter past 8 pm", [
      update("sync", "2026-11-24", [20, 15], [21, 15]),
    ]);
    expect(quarterPast.changes[0].next).toEqual({
      starts_at: zrh("2026-11-24", 20, 15),
      ends_at: zrh("2026-11-24", 21, 15),
    });
    expect(parse("Move the team sync to half past 7 pm")?.start?.minutes).toEqual([1170]);
    expect(parse("Move the team sync to a quarter to 9 pm")?.start?.minutes).toEqual([1245]);
  });
});

describe("weeks start on Monday (finding 31, chat part)", () => {
  it("reads 'next week' and 'this week' on a Sunday as Monday weeks", () => {
    const sunday = "2026-11-29";
    expect(parseChangeRequest("Move the dentist appointment to next week", sunday)?.weekStart).toBe(
      "2026-11-30",
    );
    expect(
      parseChangeRequest("Move the dentist appointment to Friday next week", sunday)?.day,
    ).toMatchObject({ dates: ["2026-12-04"] });
    expect(
      parseChangeRequest("Move the dentist appointment to Friday this week", sunday)?.day,
    ).toMatchObject({ dates: ["2026-11-27"], past: true });
    expect(
      parseChangeRequest("Move the dentist appointment to Monday next week", "2026-11-24")?.day,
    ).toMatchObject({ dates: ["2026-11-30"] });
  });
});

describe("tonight, dates in the past months, '13 am' (finding 27)", () => {
  it("reads 'tonight at 9' and 'tomorrow night at 9' as the evening", () => {
    expect(reconcile("Move the dentist appointment to tonight at 9").changes[0].next).toEqual({
      starts_at: "2026-11-24T20:00:00.000Z",
      ends_at: "2026-11-24T21:30:00.000Z",
    });
    expect(
      reconcile("Move the dentist appointment to tomorrow night at 9").changes[0].next?.starts_at,
    ).toBe("2026-11-25T20:00:00.000Z");
    expect(
      reconcile("Move the dentist appointment to this evening at 8").changes[0].next?.starts_at,
    ).toBe("2026-11-24T19:00:00.000Z");
  });

  it("still asks for 'tonight at 1' (after midnight or 1 PM) and keeps 'tomorrow morning at 7' in the morning", () => {
    const result = reconcile("Move the dentist appointment to tonight at 1");
    expect(result.changes).toEqual([]);
    expect(result.note).toMatch(/1:00 AM or 1:00 PM/);
    expect(parse("Move the dentist appointment to tomorrow morning at 7")?.start?.minutes).toEqual([
      420,
    ]);
  });

  it("reads a month and day that are more than two months back as next year", () => {
    expect(parse("Move the dentist appointment to May 30 at 2 pm")?.day).toMatchObject({
      dates: ["2027-05-30"],
    });
    expect(parse("Move the dentist appointment to 30 May at 2 pm")?.day).toMatchObject({
      dates: ["2027-05-30"],
    });
    expect(parse("Move the dentist appointment to Jan 5 at 2 pm")?.day).toMatchObject({
      dates: ["2027-01-05"],
    });
    // Next year's date six weeks ahead is moved to by rule.
    expect(reconcile("Move the dentist appointment to Jan 5 at 2 pm").changes[0]).toMatchObject({
      byRule: true,
      next: { starts_at: "2027-01-05T13:00:00.000Z" },
    });
    // A recent date is this year's, and is over.
    expect(parse("Move the dentist appointment to Nov 20 at 2 pm")?.day).toMatchObject({
      dates: ["2026-11-20"],
    });
    expect(reconcile("Move the dentist appointment to Nov 20 at 2 pm").note).toMatch(
      /already passed/,
    );
    expect(parse("Move the dentist appointment to Dec 3 at 2 pm")?.day).toMatchObject({
      dates: ["2026-12-03"],
    });
  });

  // Reviewer of 24 Nov 2026: with a 14-day window, "Nov 1" asked on Nov 24 became a by-rule card
  // for 2027-11-01, and the text showed no year.
  it("keeps a date up to two months back in this year, so it is refused as over", () => {
    for (const message of [
      "Move the dentist appointment to Nov 1 at 2 pm",
      "Move the dentist appointment to Sep 30 at 2 pm",
      "Move the dentist appointment to 1.11. at 2 pm",
    ]) {
      const result = reconcile(message);
      expect(result.changes, message).toEqual([]);
      expect(result.note, message).toMatch(/has already passed/);
    }
    const withModel = reconcile("Move the dentist appointment to Oct 30 at 2 pm", [
      update("dentist", "2026-10-30", [14, 0], [15, 30]),
    ]);
    expect(withModel.changes).toEqual([]);
    expect(withModel.note).toBe(
      "The new time for **Dentist appointment** (Fri, Oct 30, 2:00 PM) has already passed.",
    );
  });

  it("asks before moving to next year's date more than half a year ahead, with the year shown", () => {
    for (const [message, asked] of [
      ["Move the dentist appointment to May 30 at 2 pm", "Sun, May 30, 2027"],
      ["Move the dentist appointment to Aug 15 at 2 pm", "Sun, Aug 15, 2027"],
      ["Move the dentist appointment to 1.6. at 2 pm", "Tue, Jun 1, 2027"],
    ]) {
      const result = reconcile(message);
      expect(result.changes, message).toEqual([]);
      expect(result.note, message).toBe(`Did you mean ${asked} for **Dentist appointment**?`);
      // The model's agreement does not replace the question: the card would not show the year.
      expect(
        reconcile(message, [update("dentist", "2027-05-30", [14, 0], [15, 30])]).changes,
        message,
      ).toEqual([]);
    }
    // With the year written out, the move is made by rule.
    expect(
      reconcile("Move the dentist appointment to May 30, 2027 at 2 pm").changes[0],
    ).toMatchObject({
      byRule: true,
      next: { starts_at: "2027-05-30T12:00:00.000Z" },
    });
    expect(parse("Move the dentist appointment to 30 May 2027 at 2 pm")?.day).toMatchObject({
      dates: ["2027-05-30"],
    });
    expect(parse("Move the dentist appointment to 30 May 2027 at 2 pm")?.day).not.toHaveProperty(
      "confirmYear",
    );
  });

  it("does not read '13 am' as 01:00", () => {
    const alone = reconcile("Move the dentist appointment to 13 am");
    expect(
      alone.changes.some((change) => change.next?.starts_at === "2026-11-26T00:00:00.000Z"),
    ).toBe(false);
    const withModel = reconcile("Move the dentist appointment to 13 am", [
      update("dentist", "2026-11-26", [13, 0], [14, 30]),
    ]);
    expect(withModel.changes[0].next?.starts_at).toBe(zrh("2026-11-26", 13));
    // 12 am and 12 pm are still midnight and noon.
    expect(parse("Move the dentist appointment to 12 pm")?.start?.minutes).toEqual([720]);
    expect(parse("Move the dentist appointment to tomorrow at 12 am")?.start?.minutes).toEqual([0]);
  });
});
