/**
 * Review of 24 Nov 2026, finding 4: a time named in the reason for a move, or as a limit on it
 * ("before 3 pm", "except 7 pm"), was read as the new time and replaced the model's correct
 * answer by rule; "Friday or Monday" became Friday.
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
const NOW = Date.parse("2026-11-24T09:00:00Z");
const zrh = (date: string, hour: number, minute = 0) =>
  new Date(
    Date.parse(`${date}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00Z`) -
      3_600_000,
  ).toISOString();

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

describe("a time in the reason is not the new time", () => {
  it.each([
    [
      "Move the team sync to tomorrow, the lecture is at 10 am",
      update("sync", "2026-11-25", [19, 0], [20, 0]),
      zrh("2026-11-25", 19),
    ],
    [
      "Move the dentist appointment to Friday (I have a lecture at 3 pm)",
      update("dentist", "2026-11-27", [14, 0], [15, 30]),
      zrh("2026-11-27", 14),
    ],
    [
      "Move the dentist appointment to Friday: the lecture is at 3 pm",
      update("dentist", "2026-11-27", [14, 0], [15, 30]),
      zrh("2026-11-27", 14),
    ],
    [
      "Move the dentist appointment to Friday - I have a lecture at 3 pm",
      update("dentist", "2026-11-27", [14, 0], [15, 30]),
      zrh("2026-11-27", 14),
    ],
    [
      "Move the team sync to tomorrow cause I'm busy at 7 pm",
      update("sync", "2026-11-25", [20, 0], [21, 0]),
      zrh("2026-11-25", 20),
    ],
    [
      "Move the team sync to tomorrow cuz I have a class at 7 pm",
      update("sync", "2026-11-25", [20, 0], [21, 0]),
      zrh("2026-11-25", 20),
    ],
  ])("%s", (message, model, start) => {
    const result = reconcile(message, [model]);
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0].next?.starts_at).toBe(start);
    expect(result.log.join(" ")).not.toMatch(/corrected the model's time/);
  });

  it("does not change the end to a time from the reason", () => {
    const result = reconcile("Move the dentist appointment to Friday, my lecture ends at 3 pm", [
      update("dentist", "2026-11-27", [14, 0], [15, 30]),
    ]);
    expect(result.changes[0].next).toEqual({
      starts_at: zrh("2026-11-27", 14),
      ends_at: zrh("2026-11-27", 15, 30),
    });
  });

  it("does not keep the event at a time the reason rules out", () => {
    // The team sync is at 7 pm; "I'm busy at 7 pm" tomorrow means not at 7 pm.
    const result = reconcile("Move the team sync to tomorrow cause I'm busy at 7 pm");
    expect(result.changes).toEqual([]);
    expect(result.note).toMatch(
      /What time on Wed, Nov 25 should \*\*Team sync — demo walkthrough\*\* move to\?/,
    );
    expect(
      reconcile("Move the team sync to tomorrow cause I'm busy at 7 pm", [
        update("sync", "2026-11-25", [19, 0], [20, 0]),
      ]).changes,
    ).toEqual([]);
  });

  it("still reads a destination that follows the verb's own words (regression)", () => {
    expect(
      reconcile("Move the dentist appointment so it starts at 4 pm").changes[0].next?.starts_at,
    ).toBe(zrh("2026-11-26", 16));
    expect(reconcile("Postpone the team sync until 9 pm").changes[0].next?.starts_at).toBe(
      zrh("2026-11-24", 21),
    );
    expect(reconcile("Move the lecture until 1 pm").changes[0].next).toEqual({
      starts_at: zrh("2026-11-25", 10),
      ends_at: zrh("2026-11-25", 13),
    });
    expect(
      reconcile("Move the dentist appointment to Friday, the 27th at 3 pm").changes[0].next
        ?.starts_at,
    ).toBe(zrh("2026-11-27", 15));
    expect(
      reconcile("Move the dentist appointment to Friday at 3 pm because the lecture is at 10 am")
        .changes[0].next?.starts_at,
    ).toBe(zrh("2026-11-27", 15));
  });

  it("does not take a date in brackets or a description of the event for a reason", () => {
    expect(
      reconcile("Move the dentist appointment to Friday (the 27th) at 3 pm").changes[0].next
        ?.starts_at,
    ).toBe(zrh("2026-11-27", 15));
    expect(
      reconcile("Move the dentist appointment to Friday: the 27th at 3 pm").changes[0].next
        ?.starts_at,
    ).toBe(zrh("2026-11-27", 15));
    expect(
      reconcile("Move the dentist appointment, the one that is on Thursday, to 3 pm").changes[0]
        .next?.starts_at,
    ).toBe(zrh("2026-11-26", 15));
  });

  // Reviewer of 24 Nov 2026: a relative clause that names the event was cut off as a reason, and
  // the destination after it with it, so the request got no card and no note at all.
  it.each([
    ["Move the team sync, the meeting that is at 7 pm, to 8 pm", "sync", zrh("2026-11-24", 20)],
    [
      "Move the dentist appointment, the appointment that is on Thursday, to Friday",
      "dentist",
      zrh("2026-11-27", 14),
    ],
    ["Move the team sync (the meeting which is at 7 pm) to 8 pm", "sync", zrh("2026-11-24", 20)],
    // Without the noun (review of 25 Nov 2026).
    ["Move the team sync, which is at 7 pm, to 8 pm", "sync", zrh("2026-11-24", 20)],
    [
      "Move the dentist appointment, which is on Thursday, to Friday",
      "dentist",
      zrh("2026-11-27", 14),
    ],
    ["Move the team sync (which is at 7 pm) to 8 pm", "sync", zrh("2026-11-24", 20)],
  ])("reads a relative clause about the event as part of its name: %s", (message, id, start) => {
    const result = reconcile(message);
    expect(result.note).toBeUndefined();
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]).toMatchObject({
      event: { id },
      byRule: true,
      next: { starts_at: start },
    });
  });

  it("asks for the day and time when a reason took the destination with it", () => {
    // Review of 25 Nov 2026: such a request got no card and no note at all.
    for (const message of [
      "Move the team sync, it is at 7 pm, to 8 pm",
      "Postpone the team sync, it is at 7 pm, to 8 pm",
    ]) {
      const result = reconcile(message);
      expect(result.changes, message).toEqual([]);
      expect(result.note, message).toBe(
        "Which day and time should **Team sync — demo walkthrough** move to?",
      );
    }
    // The model's own answer is still offered.
    const withModel = reconcile("Move the team sync, it is at 7 pm, to 8 pm", [
      update("sync", "2026-11-24", [20, 0], [21, 0]),
    ]);
    expect(withModel.changes[0]).toMatchObject({
      byRule: false,
      next: { starts_at: zrh("2026-11-24", 20) },
    });
  });

  it("still cuts a sentence about something else with a relative clause in it", () => {
    // No new time follows the clause: it is the reason, and 4 pm is not the new time.
    const result = reconcile(
      "Move the dentist appointment to Friday, the lecture that I have is at 4 pm",
    );
    expect(result.changes[0].next?.starts_at).toBe(zrh("2026-11-27", 14));
  });
});

describe("a limit on the new time is not the new time", () => {
  it("reads the limit words", () => {
    expect(
      parseChangeRequest("Move the dentist appointment to Friday before 3 pm", TODAY),
    ).toMatchObject({
      start: undefined,
      vagueTime: true,
      bounds: { latest: 900, latestExclusive: true },
    });
    expect(
      parseChangeRequest("Move the dentist appointment to Friday no later than 5 pm", TODAY)
        ?.bounds,
    ).toMatchObject({ latest: 1020, latestExclusive: false });
    expect(
      parseChangeRequest("Move the dentist appointment to Friday at 5 pm at the latest", TODAY)
        ?.bounds,
    ).toMatchObject({ latest: 1020 });
    expect(
      parseChangeRequest("Move the dentist appointment to Friday after 6 pm", TODAY)?.bounds,
    ).toMatchObject({ earliest: 1080 });
    expect(
      parseChangeRequest("Move the dentist appointment to Friday after the lecture at 10 am", TODAY)
        ?.bounds,
    ).toMatchObject({ earliest: 600 });
    expect(
      parseChangeRequest("Move the team sync to tomorrow anytime except 7 pm", TODAY)?.bounds,
    ).toMatchObject({ avoid: [1140] });
  });

  it("keeps the model's answer when it is inside the limits", () => {
    const result = reconcile("Move the dentist appointment to Friday before 3 pm", [
      update("dentist", "2026-11-27", [13, 0], [14, 30]),
    ]);
    expect(result.changes[0]).toMatchObject({
      byRule: false,
      next: { starts_at: zrh("2026-11-27", 13), ends_at: zrh("2026-11-27", 14, 30) },
    });
    // "anytime after 8 pm" names the team sync and a limit, without "to".
    const after = reconcile("Move the team sync anytime after 8 pm", [
      update("sync", "2026-11-24", [21, 0], [22, 0]),
    ]);
    expect(after.changes[0]).toMatchObject({
      byRule: false,
      next: { starts_at: zrh("2026-11-24", 21) },
    });
    expect(
      reconcile("Move the team sync anytime after 8 pm", [
        update("sync", "2026-11-24", [19, 30], [20, 30]),
      ]).changes,
    ).toEqual([]);
  });

  it("does not offer a model answer outside the limits, and asks without one", () => {
    expect(
      reconcile("Move the dentist appointment to Friday before 3 pm", [
        update("dentist", "2026-11-27", [15, 0], [16, 30]),
      ]).changes,
    ).toEqual([]);
    expect(
      reconcile("Move the team sync to tomorrow anytime except 7 pm", [
        update("sync", "2026-11-25", [19, 0], [20, 0]),
      ]).changes,
    ).toEqual([]);
    const alone = reconcile("Move the dentist appointment to Friday before 3 pm");
    expect(alone.changes).toEqual([]);
    expect(alone.note).toMatch(/What time on Fri, Nov 27/);
  });

  it("keeps 'end by', 'by an hour' and 'until' as before (regression)", () => {
    expect(reconcile("Move the dentist appointment to end by 5 pm").changes[0].next).toEqual({
      starts_at: zrh("2026-11-26", 14),
      ends_at: zrh("2026-11-26", 17),
    });
    expect(parseChangeRequest("Push the team sync back by 30 minutes", TODAY)).toMatchObject({
      shiftMin: 30,
    });
    expect(
      parseChangeRequest("Push the team sync back by 30 minutes", TODAY)?.bounds,
    ).toBeUndefined();
  });
});

describe("two days named with 'or'", () => {
  it("asks which day, or takes the model's choice of the two", () => {
    const alone = reconcile("Move the dentist appointment to Friday or Monday");
    expect(alone.changes).toEqual([]);
    expect(alone.note).toBe(
      "Which day did you mean for **Dentist appointment**: Fri, Nov 27 or Mon, Nov 30?",
    );
    const monday = reconcile("Move the dentist appointment to Friday or Monday", [
      update("dentist", "2026-11-30", [14, 0], [15, 30]),
    ]);
    expect(monday.changes[0]).toMatchObject({
      byRule: false,
      next: { starts_at: zrh("2026-11-30", 14) },
    });
    // Another day than the two is not taken.
    expect(
      reconcile("Move the dentist appointment to Friday or Monday", [
        update("dentist", "2026-12-01", [14, 0], [15, 30]),
      ]).changes,
    ).toEqual([]);
  });

  it("does not split a single day (regression)", () => {
    expect(
      parseChangeRequest("Move the dentist appointment to Friday at 3 or 4 pm", TODAY)?.day,
    ).toMatchObject({ dates: ["2026-11-27"] });
  });
});
