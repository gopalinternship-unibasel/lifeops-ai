import { describe, expect, it } from "vitest";
import {
  matchEvent,
  parseChangeRequest,
  reconcileCalendarChanges,
  resolveMove,
  type KnownEvent,
} from "@/server/calendar/change-request.server";

const ZRH = "Europe/Zurich";
const TODAY = "2026-11-09"; // a Monday
const NOW = Date.parse("2026-11-09T21:00:00Z"); // Monday 22:00 in Zurich

// The demo calendar as QA had it (Zurich is UTC+1 in November).
const EVENTS: KnownEvent[] = [
  { id: "sync", title: "Team sync — demo walkthrough", starts_at: "2026-11-10T18:00:00.000Z", ends_at: "2026-11-10T19:00:00.000Z" },
  { id: "lecture", title: "Lecture — Distributed Systems", starts_at: "2026-11-10T09:00:00.000Z", ends_at: "2026-11-10T11:00:00.000Z" },
  { id: "dentist", title: "Dentist appointment", starts_at: "2026-11-11T13:00:00.000Z", ends_at: "2026-11-11T14:30:00.000Z" },
  { id: "prep", title: "✍️ Prepare for dentist", starts_at: "2026-11-12T07:30:00.000Z", ends_at: "2026-11-12T09:00:00.000Z" },
  { id: "acme", title: "Acme onsite interview", starts_at: "2026-11-16T09:00:00.000Z", ends_at: "2026-11-16T11:00:00.000Z" },
];

function move(message: string, suggestion?: { starts_at: string; ends_at: string }) {
  const request = parseChangeRequest(message, TODAY);
  expect(request, message).not.toBeNull();
  const match = matchEvent(request!, EVENTS, ZRH);
  return { request: request!, match, resolved: match.status === "one" ? resolveMove(request!, match.event, ZRH, suggestion) : null };
}

describe("reading a move or cancel request", () => {
  it("'start at 4 pm the same day' keeps the dentist appointment's day and length (QA round 3)", () => {
    const { match, resolved } = move("Move my dentist appointment to start at 4 pm the same day.");
    expect(match).toMatchObject({ status: "one", event: { id: "dentist" } });
    expect(resolved).toEqual({ status: "resolved", starts_at: "2026-11-11T15:00:00.000Z", ends_at: "2026-11-11T16:30:00.000Z", byRule: true });
  });

  it("a range on a named weekday: 'on Wednesday to 4:00-5:30 pm'", () => {
    const { request, resolved } = move("Move the dentist appointment on Wednesday to 4:00-5:30 pm.");
    expect(request.sourceDay?.dates).toEqual(["2026-11-11"]);
    expect(resolved).toMatchObject({ status: "resolved", starts_at: "2026-11-11T15:00:00.000Z", ends_at: "2026-11-11T16:30:00.000Z" });
  });

  it("a new day and time, 24-hour times, explicit dates and shifts", () => {
    expect(move("Reschedule tomorrow's lecture to Friday at 10 am").resolved).toMatchObject({ starts_at: "2026-11-13T09:00:00.000Z", ends_at: "2026-11-13T11:00:00.000Z" });
    expect(move("Move the dentist appointment to 16:00").resolved).toMatchObject({ starts_at: "2026-11-11T15:00:00.000Z", ends_at: "2026-11-11T16:30:00.000Z" });
    expect(move("Move the dentist appointment to Nov 13 at 2pm").resolved).toMatchObject({ starts_at: "2026-11-13T13:00:00.000Z" });
    expect(move("Move the dentist appointment to Friday").resolved).toMatchObject({ starts_at: "2026-11-13T13:00:00.000Z", ends_at: "2026-11-13T14:30:00.000Z" });
    expect(move("Push the team sync back by an hour").resolved).toMatchObject({ starts_at: "2026-11-10T19:00:00.000Z", ends_at: "2026-11-10T20:00:00.000Z" });
    expect(move("Please move the dentist appointment 30 minutes later").resolved).toMatchObject({ starts_at: "2026-11-11T13:30:00.000Z" });
    expect(move("Can you move the lecture to 2-4 pm on Thursday?").resolved).toMatchObject({ starts_at: "2026-11-12T13:00:00.000Z", ends_at: "2026-11-12T15:00:00.000Z" });
    expect(move("Change the dentist appointment to end at 4 pm").resolved).toMatchObject({ starts_at: "2026-11-11T13:00:00.000Z", ends_at: "2026-11-11T15:00:00.000Z" });
    expect(move("Move the dentist appointment to 4 pm for an hour").resolved).toMatchObject({ starts_at: "2026-11-11T15:00:00.000Z", ends_at: "2026-11-11T16:00:00.000Z" });
  });

  it("asks instead of guessing: two matching events, am or pm, which Monday", () => {
    expect(move("Move the dentist to 5 pm").match).toMatchObject({ status: "ambiguous" });
    const bare = move("Move the team sync to 8");
    expect(bare.resolved).toMatchObject({ status: "unclear", question: expect.stringContaining("8:00 AM or 8:00 PM") });
    // The model's answer decides only when it is one of the two readings.
    expect(move("Move the team sync to 8", { starts_at: "2026-11-10T19:00:00.000Z", ends_at: "2026-11-10T20:00:00.000Z" }).resolved)
      .toMatchObject({ status: "resolved", starts_at: "2026-11-10T19:00:00.000Z", byRule: false });
    expect(move("Move the team sync to 8", { starts_at: "2026-11-11T03:00:00.000Z", ends_at: "2026-11-11T04:00:00.000Z" }).resolved)
      .toMatchObject({ status: "unclear" });
    expect(move("Move the Acme interview to Monday").resolved).toMatchObject({ status: "unclear", question: expect.stringContaining("Which day") });
  });

  it("is not fooled by nouns or other requests", () => {
    expect(parseChangeRequest("Block 3–5 pm tomorrow for a gym push workout.", TODAY)).toBeNull();
    expect(parseChangeRequest("Schedule 'Review lecture notes' tomorrow from 10:30 to 11:30.", TODAY)).toBeNull();
    expect(parseChangeRequest("Draft a reply to Sam's email about lunch on Saturday: yes, 1 pm works.", TODAY)).toBeNull();
    expect(parseChangeRequest("Cancel my team sync", TODAY)).toMatchObject({ kind: "cancel", subjectWords: ["team", "sync"] });
  });
});

describe("checking the model's calendar answer against the request", () => {
  const base = { today: TODAY, timeZone: ZRH, nowMs: NOW, events: EVENTS };
  const dentist = EVENTS[2];

  it("QA attempt 1: the model's move to 04:00 the next day is corrected to 16:00 the same day", () => {
    const r = reconcileCalendarChanges({
      ...base,
      message: "Move my dentist appointment to start at 4 pm the same day.",
      modelChanges: [{ kind: "update", event: dentist, starts_at: "2026-11-12T03:00:00.000Z" }],
      modelProposals: [],
    });
    expect(r.changeRequest).toBe(true);
    expect(r.changes).toEqual([
      { kind: "update", event: dentist, next: { starts_at: "2026-11-11T15:00:00.000Z", ends_at: "2026-11-11T16:30:00.000Z" }, byRule: true },
    ]);
    expect(r.log.join(" ")).toContain("corrected the model's time");
  });

  it("QA attempts 2 and 3: a NEW 'Dentist appointment' becomes a move of the existing one, no second appointment", () => {
    for (const proposal of [
      { title: "Dentist appointment", starts_at: "2026-11-14T15:00:00.000Z", ends_at: "2026-11-14T16:30:00.000Z", notes: "Moved to 4:00 PM today" },
      { title: "Dentist appointment", starts_at: "2026-11-11T15:00:00.000Z", ends_at: "2026-11-11T16:30:00.000Z" },
    ]) {
      const r = reconcileCalendarChanges({
        ...base,
        message: "Move my dentist appointment to start at 4 pm the same day.",
        modelChanges: [],
        modelProposals: [proposal],
      });
      expect(r.proposals).toEqual([]);
      expect(r.changes).toHaveLength(1);
      expect(r.changes[0]).toMatchObject({ kind: "update", event: { id: "dentist" }, next: { starts_at: "2026-11-11T15:00:00.000Z", ends_at: "2026-11-11T16:30:00.000Z" } });
    }
  });

  it("changes for other events and hallucinated extras are dropped; a cancel targets the named event", () => {
    const r = reconcileCalendarChanges({
      ...base,
      message: "Cancel my team sync",
      modelChanges: [
        { kind: "delete", event: EVENTS[0] },
        { kind: "delete", event: EVENTS[1] },
      ],
      modelProposals: [],
    });
    expect(r.changes).toEqual([{ kind: "delete", event: EVENTS[0], byRule: true }]);
  });

  it("refuses with a reason instead of offering a wrong card", () => {
    const ambiguous = reconcileCalendarChanges({ ...base, message: "Move the dentist to 5 pm", modelChanges: [{ kind: "update", event: dentist, starts_at: "2026-11-11T16:00:00.000Z" }], modelProposals: [] });
    expect(ambiguous.changes).toEqual([]);
    expect(ambiguous.note).toMatch(/More than one event matches "the dentist".*Dentist appointment.*Prepare for dentist/);

    const unknown = reconcileCalendarChanges({ ...base, message: "Move my yoga class to 6 pm", modelChanges: [], modelProposals: [] });
    expect(unknown.note).toContain('I could not find an event matching "my yoga class"');

    const past = reconcileCalendarChanges({ ...base, message: "Move the team sync to 9 am today", modelChanges: [], modelProposals: [] });
    expect(past.note).toContain("has already passed");
  });

  it("without a readable request, a model move to the early hours is refused unless the user asked for it", () => {
    const early = reconcileCalendarChanges({
      ...base,
      message: "The dentist appointment needs to be later.",
      modelChanges: [{ kind: "update", event: dentist, starts_at: "2026-11-12T03:00:00.000Z", ends_at: "2026-11-12T04:30:00.000Z" }],
      modelProposals: [],
    });
    expect(early.changes).toEqual([]);
    expect(early.note).toContain("does not look like what you asked for");

    const fine = reconcileCalendarChanges({
      ...base,
      message: "The dentist appointment needs to be later.",
      modelChanges: [{ kind: "update", event: dentist, starts_at: "2026-11-11T16:00:00.000Z", ends_at: "2026-11-11T17:30:00.000Z" }],
      modelProposals: [],
    });
    expect(fine.changes).toHaveLength(1);
    expect(fine.changeRequest).toBe(false);
  });

  it("a proposal that repeats an existing event exactly is dropped; real new events stay", () => {
    const r = reconcileCalendarChanges({
      ...base,
      message: "Block 3-5 pm tomorrow for a gym push workout.",
      modelChanges: [],
      modelProposals: [
        { title: "Lecture — Distributed Systems", starts_at: EVENTS[1].starts_at, ends_at: EVENTS[1].ends_at },
        { title: "Gym — push workout", starts_at: "2026-11-10T14:00:00.000Z", ends_at: "2026-11-10T16:00:00.000Z" },
      ],
    });
    expect(r.proposals.map((p) => p.title)).toEqual(["Gym — push workout"]);
    expect(r.changeRequest).toBe(false);
  });
});
