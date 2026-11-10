/**
 * QA round 4 (10 Nov 2026): requests that start with "set", "put" or "change" and name an
 * existing event were read as a MOVE of that event ("Set a reminder for my dentist appointment at
 * 1 pm on Thursday" became "Update event Dentist appointment: Thu 16:00-17:30 -> 13:00-14:30"),
 * and plain new-event requests ("Set up a gym session tomorrow at 6 pm") got "I could not find
 * an event matching "up a gym session"". These are the phrasings of QA's code probe.
 */
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

/** Local Zurich wall-clock time (UTC+1 in November) as UTC ISO. */
const at = (date: string, hour: number, minute = 0) =>
  new Date(Date.parse(`${date}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00Z`) - 3_600_000).toISOString();

const EVENTS: KnownEvent[] = [
  { id: "sync", title: "Team sync — demo walkthrough", starts_at: at("2026-11-10", 19), ends_at: at("2026-11-10", 20) },
  { id: "lecture", title: "Lecture — Distributed Systems", starts_at: at("2026-11-10", 10), ends_at: at("2026-11-10", 12) },
  { id: "dentist", title: "Dentist appointment", starts_at: at("2026-11-11", 14), ends_at: at("2026-11-11", 15, 30) },
  { id: "acme", title: "Acme onsite interview", starts_at: at("2026-11-16", 10), ends_at: at("2026-11-16", 12) },
];
const dentist = EVENTS[2];
const base = { today: TODAY, timeZone: ZRH, nowMs: NOW, events: EVENTS };

function move(message: string) {
  const request = parseChangeRequest(message, TODAY);
  expect(request, message).not.toBeNull();
  const match = matchEvent(request!, EVENTS, ZRH);
  expect(match.status, message).toBe("one");
  return match.status === "one" ? resolveMove(request!, match.event, ZRH) : null;
}

describe("new-item requests that start with set / put / change are not moves", () => {
  it("'Set a reminder for my dentist appointment at 1 pm on Wednesday': the reminder stays, no move", () => {
    // What the real default model returned in QA round 4: a NEW "Dentist appointment" at 13:00.
    const message = "Set a reminder for my dentist appointment at 1 pm on Wednesday.";
    expect(parseChangeRequest(message, TODAY)).toBeNull();
    const r = reconcileCalendarChanges({
      ...base,
      message,
      modelChanges: [],
      modelProposals: [{ title: "Dentist appointment", starts_at: at("2026-11-11", 13), ends_at: at("2026-11-11", 14, 30) }],
    });
    expect(r.changeRequest).toBe(false);
    expect(r.changes).toEqual([]);
    expect(r.note).toBeUndefined();
    expect(r.proposals).toEqual([{ title: "Reminder: Dentist appointment", starts_at: at("2026-11-11", 13), ends_at: at("2026-11-11", 14, 30) }]);
  });

  it("a model move of the event the reminder is about is dropped, and the reply is told why", () => {
    const r = reconcileCalendarChanges({
      ...base,
      message: "Set a reminder for my dentist appointment at 1 pm on Wednesday.",
      modelChanges: [{ kind: "update", event: dentist, starts_at: at("2026-11-11", 13), ends_at: at("2026-11-11", 14, 30) }],
      modelProposals: [],
    });
    expect(r.changes).toEqual([]);
    expect(r.changeRequest).toBe(false);
    expect(r.note).toContain("I did not read your message as asking for that");
  });

  it("QA's probe variants: set aside, set up, put, set a call, change of plans, prep time, drop the idea, bring", () => {
    const cases: [string, { title: string; starts_at: string; ends_at: string }][] = [
      ["Set aside an hour before the lecture tomorrow at 9 am to review notes.", { title: "Review notes", starts_at: at("2026-11-10", 9), ends_at: at("2026-11-10", 10) }],
      ["Set up a call to prepare for the dentist on Wednesday at 1 pm.", { title: "Call to prepare for dentist", starts_at: at("2026-11-11", 13), ends_at: at("2026-11-11", 13, 30) }],
      ["Set up a gym session tomorrow at 6 pm for an hour.", { title: "Gym session", starts_at: at("2026-11-10", 18), ends_at: at("2026-11-10", 19) }],
      ["Put a 1-hour gym session on Friday at 6 pm.", { title: "Gym session", starts_at: at("2026-11-13", 18), ends_at: at("2026-11-13", 19) }],
      ["Set a call with mom for Saturday at 5 pm.", { title: "Call with mom", starts_at: at("2026-11-14", 17), ends_at: at("2026-11-14", 17, 30) }],
      ["Change of plans: block 3-5 pm tomorrow for a gym push workout.", { title: "Gym push workout", starts_at: at("2026-11-10", 15), ends_at: at("2026-11-10", 17) }],
      ["Put prep time for the Acme interview on Sunday at 3 pm.", { title: "Acme interview prep", starts_at: at("2026-11-15", 15), ends_at: at("2026-11-15", 16) }],
      ["Drop the idea of a run; block 7-8 am tomorrow for a run instead.", { title: "Morning run", starts_at: at("2026-11-10", 7), ends_at: at("2026-11-10", 8) }],
      ["Bring snacks to the team sync.", { title: "Buy snacks", starts_at: at("2026-11-10", 17), ends_at: at("2026-11-10", 17, 30) }],
    ];
    for (const [message, proposal] of cases) {
      const r = reconcileCalendarChanges({ ...base, message, modelChanges: [], modelProposals: [proposal] });
      expect({ message, changeRequest: r.changeRequest, changes: r.changes, note: r.note, proposals: r.proposals }).toEqual({
        message,
        changeRequest: false,
        changes: [],
        note: undefined,
        proposals: [proposal],
      });
    }
  });

  it("change / bring / put off with a definite event still move it, by rule; set / put only when the model moved it too", () => {
    expect(move("Change my dentist appointment to 4 pm")).toMatchObject({ status: "resolved", starts_at: at("2026-11-11", 16), ends_at: at("2026-11-11", 17, 30), byRule: true });
    for (const [message, starts_at] of [["Set the team sync to 8 pm", at("2026-11-10", 20)], ["Put the dentist appointment on Friday", at("2026-11-13", 14)]] as const) {
      const event = message.includes("sync") ? EVENTS[0] : dentist;
      // The rules alone never make a move out of set / put ...
      expect(reconcileCalendarChanges({ ...base, message, modelChanges: [], modelProposals: [] })).toMatchObject({ changeRequest: false, changes: [] });
      // ... but a move of that event by the model is kept, with the time the message names.
      const r = reconcileCalendarChanges({ ...base, message, modelChanges: [{ kind: "update", event, starts_at: at("2026-11-14", 9) }], modelProposals: [] });
      expect(r.changes).toMatchObject([{ kind: "update", event: { id: event.id }, next: { starts_at }, byRule: true }]);
    }
    expect(move("Bring the dentist appointment forward by an hour")).toMatchObject({ starts_at: at("2026-11-11", 13), ends_at: at("2026-11-11", 14, 30) });
    expect(move("Put off the dentist appointment by 30 minutes")).toMatchObject({ starts_at: at("2026-11-11", 14, 30) });
    expect(move("Postpone the team sync by 30 minutes")).toMatchObject({ starts_at: at("2026-11-10", 19, 30), ends_at: at("2026-11-10", 20, 30) });
    expect(move("Push back the team sync an hour")).toMatchObject({ starts_at: at("2026-11-10", 20) });
    const r = reconcileCalendarChanges({ ...base, message: "Change my dentist appointment to 4 pm", modelChanges: [], modelProposals: [] });
    expect(r).toMatchObject({ changeRequest: true, changes: [{ kind: "update", event: { id: "dentist" } }] });
  });

  it("a weak verb whose object is not exactly an event is not a move: 'Set my dentist appointment reminder for 1 pm'", () => {
    const r = reconcileCalendarChanges({
      ...base,
      message: "Set my dentist appointment reminder for 1 pm",
      modelChanges: [],
      modelProposals: [{ title: "Dentist appointment reminder", starts_at: at("2026-11-11", 13), ends_at: at("2026-11-11", 13, 15) }],
    });
    expect(r.changeRequest).toBe(false);
    expect(r.changes).toEqual([]);
    expect(r.proposals.map((p) => p.title)).toEqual(["Dentist appointment reminder"]);
  });

  it("the request's clause ends at the next request: its destination is not read from the next one", () => {
    const r = reconcileCalendarChanges({
      ...base,
      message: "Move the dentist appointment to 5 pm and block 3-5 pm tomorrow for the gym.",
      modelChanges: [],
      modelProposals: [{ title: "Gym", starts_at: at("2026-11-10", 15), ends_at: at("2026-11-10", 17) }],
    });
    expect(r.changes).toEqual([
      { kind: "update", event: dentist, next: { starts_at: at("2026-11-11", 17), ends_at: at("2026-11-11", 18, 30) }, byRule: true },
    ]);
    expect(r.proposals.map((p) => p.title)).toEqual(["Gym"]);
    const cancel = reconcileCalendarChanges({
      ...base,
      message: "Remove the gym session from my plan and block 3-5 pm tomorrow for reading.",
      modelChanges: [],
      modelProposals: [{ title: "Reading", starts_at: at("2026-11-10", 15), ends_at: at("2026-11-10", 17) }],
    });
    expect(cancel.request?.subject).toBe("the gym session from my plan");
    expect(cancel.proposals.map((p) => p.title)).toEqual(["Reading"]);
    // A full stop after an abbreviation does not end the request; one after a sentence does.
    expect(move("Move the dentist appointment to Nov. 13 at 2pm")).toMatchObject({ starts_at: at("2026-11-13", 14), byRule: true });
    expect(move("Move the dentist appointment to 4 pm. Then add lunch tomorrow at noon.")).toMatchObject({ starts_at: at("2026-11-11", 16), ends_at: at("2026-11-11", 17, 30) });
  });

  it("moving an event that is not there: no new event of that name instead; an unknown event id is reported", () => {
    const yoga = reconcileCalendarChanges({
      ...base,
      message: "Move my yoga class to 6 pm",
      modelChanges: [],
      modelProposals: [{ title: "Yoga class", starts_at: at("2026-11-10", 18), ends_at: at("2026-11-10", 19) }],
    });
    expect(yoga.proposals).toEqual([]);
    expect(yoga.note).toContain('I could not find an event matching "my yoga class"');
    // The test double's "Please move the hallucinated thing to tomorrow 9 am." -> event id E99.
    const hallucinated = reconcileCalendarChanges({
      ...base,
      message: "Please move the hallucinated thing to tomorrow 9 am.",
      modelChanges: [],
      modelProposals: [],
      unknownChangeRefs: 1,
    });
    expect(hallucinated.note).toContain('I could not find an event matching "the hallucinated thing"');
    const noVerb = reconcileCalendarChanges({ ...base, message: "The hallucinated thing should be later.", modelChanges: [], modelProposals: [], unknownChangeRefs: 1 });
    expect(noVerb.note).toContain("not in your calendar");
  });

  it("a new event with the title of an existing one is reported (it would be a second one)", () => {
    const r = reconcileCalendarChanges({
      ...base,
      message: "Book my dentist appointment for Friday 2 pm too.",
      modelChanges: [],
      modelProposals: [{ title: "Dentist appointment", starts_at: at("2026-11-13", 14), ends_at: at("2026-11-13", 15, 30) }],
    });
    expect(r.changes).toEqual([]);
    expect(r.sameTitleAs).toEqual([{ title: "Dentist appointment", event: dentist }]);
  });
});
