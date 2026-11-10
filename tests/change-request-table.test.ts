/**
 * Which chat messages the rules read as a request to MOVE or CANCEL an existing event, and which
 * they leave to the ordinary path (the model's own answer, checked by the reply guard).
 *
 * QA round 4 (10 Nov 2026): "Set a reminder for my dentist appointment at 1 pm on Thursday" was
 * offered as a move of the appointment, and "Set up a gym session tomorrow at 6 pm" got "I could
 * not find an event matching "up a gym session"". Rules that override the model must be
 * conservative: a message is a change request only when it clearly asks to move, reschedule,
 * shift, push, postpone, bring forward or cancel an existing event that it names. This table has
 * every phrasing of QA's report and probe, and phrasings written to break the rules, in both
 * directions.
 */
import { describe, expect, it } from "vitest";
import {
  parseChangeRequest,
  reconcileCalendarChanges,
  type KnownEvent,
  type ModelChange,
  type ProposedBlock,
} from "@/server/calendar/change-request.server";

const ZRH = "Europe/Zurich";
const TODAY = "2026-11-09"; // a Monday
const NOW = Date.parse("2026-11-09T21:00:00Z"); // Monday 22:00 in Zurich

/** Local Zurich wall-clock time (UTC+1 in November) as UTC ISO. */
const at = (date: string, hour: number, minute = 0) =>
  new Date(Date.parse(`${date}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00Z`) - 3_600_000).toISOString();

const EVENTS: KnownEvent[] = [
  { id: "lecture", title: "Lecture — Distributed Systems", starts_at: at("2026-11-10", 10), ends_at: at("2026-11-10", 12) },
  { id: "sync", title: "Team sync — demo walkthrough", starts_at: at("2026-11-10", 19), ends_at: at("2026-11-10", 20) },
  { id: "dentist", title: "Dentist appointment", starts_at: at("2026-11-11", 14), ends_at: at("2026-11-11", 15, 30) },
  { id: "gym", title: "Gym — push workout", starts_at: at("2026-11-12", 15), ends_at: at("2026-11-12", 17) },
  { id: "lunch", title: "Lunch with Sam", starts_at: at("2026-11-14", 13), ends_at: at("2026-11-14", 14) },
  { id: "acme", title: "Acme onsite interview", starts_at: at("2026-11-16", 10), ends_at: at("2026-11-16", 12) },
];
const byId = (id: string) => EVENTS.find((event) => event.id === id)!;
const base = { today: TODAY, timeZone: ZRH, nowMs: NOW, events: EVENTS };

function reconcile(message: string, model: { changes?: ModelChange[]; proposals?: ProposedBlock[]; unknownChangeRefs?: number } = {}) {
  return reconcileCalendarChanges({
    ...base,
    message,
    modelChanges: model.changes ?? [],
    modelProposals: model.proposals ?? [],
    unknownChangeRefs: model.unknownChangeRefs,
  });
}

/** The worst a model can answer: every event the message names, moved; cancelled; and proposed again as a new event. */
function worstCase(message: string): { moved: ModelChange[]; cancelled: ModelChange[]; proposals: ProposedBlock[] } {
  const named = EVENTS.filter((event) =>
    event.title.toLowerCase().split(/[^a-z]+/).some((word) => word.length > 2 && message.toLowerCase().includes(word)),
  );
  const targets = named.length > 0 ? named : [byId("dentist")];
  return {
    moved: targets.map((event) => ({ kind: "update" as const, event, starts_at: at("2026-11-13", 13), ends_at: at("2026-11-13", 14) })),
    cancelled: targets.map((event) => ({ kind: "delete" as const, event })),
    proposals: targets.map((event) => ({ title: event.title, starts_at: at("2026-11-13", 13), ends_at: at("2026-11-13", 14) })),
  };
}

/* ------------------------------------------------------------------------------------------
 * Direction 1: requests for something new, questions and refusals. Never a move or a cancel.
 * ---------------------------------------------------------------------------------------- */

/** A request for something new: whatever the model returns, no existing event is changed. */
const NEW_ITEMS: string[] = [
  // QA round 4, the report and the code probe
  "Set a reminder for my dentist appointment at 1 pm on Thursday.",
  "Set aside an hour before the lecture tomorrow at 9 am to review notes.",
  "Set up a call to prepare for the dentist on Thursday at 1 pm.",
  "Set up a gym session tomorrow at 6 pm for an hour.",
  "Put a 1-hour gym session on Friday at 6 pm.",
  "Set a call with mom for Saturday at 5 pm.",
  "Change of plans: block 3-5 pm tomorrow for a gym push workout.",
  // written to break the rules
  "Put prep time for the Acme interview on Sunday at 3 pm.",
  "Add a reminder: cancel the team sync.",
  "Add a task to move the car before the dentist appointment.",
  "Remind me to reschedule the dentist appointment tomorrow at 9 am.",
  "Remind me about the dentist appointment an hour before.",
  "Schedule a call to cancel my gym membership tomorrow at 3 pm.",
  "Block 30 minutes before the lecture to print the slides.",
  "Book a follow-up dentist appointment for Friday at 2 pm.",
  "Set a reminder 30 minutes earlier than my dentist appointment.",
  "Create a reminder to move my car before the dentist appointment at 1 pm on Wednesday.",
  "Plan a study block after the lecture tomorrow from 1 to 3 pm.",
  "Schedule dinner after the team sync tomorrow at 8:30 pm.",
  "Add 'Cancel Netflix' tomorrow at 9 am.",
  "Make time for the dentist: block Wednesday 1-2 pm for travel.",
  "Reserve an hour for the Acme interview prep on Friday at 4 pm.",
  "Set up the team sync room booking for tomorrow at 6:30 pm.",
  "Pencil in a coffee with Sam before lunch on Saturday at 11 am.",
  "Block 3–5 pm tomorrow for a gym push workout.",
  "Schedule 'Review lecture notes' tomorrow from 10:30 to 11:30.",
  "Reminder: cancel the gym membership on Friday at 9 am.",
  "Book the dentist for Friday at 2 pm too.",
  "Set a reminder to cancel the gym on Thursday.",
  "Remind me that I need to cancel the team sync.",
  "Remind me to call mom and cancel the team sync.",
  "Remind me to call the dentist, and move the dentist appointment to Friday.",
  "Note to self: cancel the team sync.",
  "Add an event: cancel Netflix tomorrow at 9 am.",
  "Schedule the dentist appointment for Friday at 2 pm instead.",
  "Book lunch with Sam on Sunday instead of Saturday.",
  "Email Sam: cancel lunch on Saturday.",
  "Email the team that the sync is cancelled.",
  "Draft an email to move the team sync to Thursday.",
  "Reply to Sam: can we move lunch to Sunday at 1 pm?",
  "Tell Sam I need to move our lunch to Sunday.",
  "Move over, I need to add a lunch at noon tomorrow.",
  "Postpone nothing; just add lunch at noon tomorrow.",
];

/**
 * Not a request to change an event, although the message names one and has a verb the rules
 * know: the object is something else, the verb is negated, or it is a question.
 */
const NOT_A_CHANGE: string[] = [
  "Drop the idea of a run; block 7-8 am tomorrow for a run instead.",
  "Add lunch at noon tomorrow and put the team sync notes in the shared folder.",
  "Set my dentist appointment reminder for 1 pm.",
  "Set the alarm for the lecture at 8 am tomorrow.",
  "Put the lecture slides on the team drive.",
  "Bring snacks to the team sync.",
  "Bring my laptop to the team sync at 7 pm.",
  "Drop off the dry cleaning before the dentist appointment at 1 pm.",
  "Pull together notes for the Acme interview on Sunday at 4 pm.",
  "Shift my focus to the lecture at 3 pm.",
  "Push workout tomorrow at 6 pm for an hour.",
  "Change my mind about the dentist appointment.",
  "Delete the note about the lecture.",
  "Remove the lecture task from my priorities.",
  "Change the subject of the reply to Sam about lunch.",
  "Don't cancel the team sync.",
  "Please don't move the dentist appointment.",
  "I don't want to cancel the team sync.",
  "Do not reschedule the Acme interview.",
  "What's on Saturday?",
  "When is my dentist appointment?",
  "How long is the lecture tomorrow?",
  "Draft a reply to Sam's email about lunch on Saturday: yes, 1 pm works.",
  "Thanks, the gym session was great.",
  "Move forward with the Acme interview prep.",
  "Is the dentist appointment later than the lecture?",
  "What time does the lecture start at?",
  "Delete my last message about the lecture.",
  "Shift work on Thursday from 3 to 5 pm at the gym.",
];

describe("direction 1: new items, questions and refusals are never a move or a cancel", () => {
  it("QA's phrasings are not even read as a change request", () => {
    for (const message of NEW_ITEMS.slice(0, 7)) expect(parseChangeRequest(message, TODAY), message).toBeNull();
  });

  it.each(NEW_ITEMS)("new item: %s", (message) => {
    const worst = worstCase(message);
    // The model proposes a new item (titled like the event the message names, as the real default
    // model did in QA round 4): it stays a new item.
    const proposed = reconcile(message, { proposals: worst.proposals });
    expect(proposed.changeRequest).toBe(false);
    expect(proposed.changes).toEqual([]);
    expect(proposed.note).toBeUndefined();
    expect(proposed.proposals).toHaveLength(worst.proposals.length);
    // The model moves or cancels the event anyway: left out, and the reply is told.
    for (const changes of [worst.moved, worst.cancelled]) {
      const changed = reconcile(message, { changes, proposals: worst.proposals });
      expect(changed.changeRequest).toBe(false);
      expect(changed.changes).toEqual([]);
      expect(changed.note).toContain("I did not read your message as asking for that");
      expect(changed.proposals).toHaveLength(worst.proposals.length);
    }
    // The model returns nothing: no note, the model's reply stands.
    expect(reconcile(message)).toMatchObject({ changeRequest: false, changes: [], proposals: [] });
    expect(reconcile(message).note).toBeUndefined();
  });

  it.each(NOT_A_CHANGE)("not a change: %s", (message) => {
    const worst = worstCase(message);
    for (const changes of [worst.moved, worst.cancelled]) {
      const changed = reconcile(message, { changes });
      expect(changed.changeRequest).toBe(false);
      expect(changed.changes).toEqual([]);
      expect(changed.note).toContain("I did not read your message as asking for that");
    }
    const quiet = reconcile(message);
    expect(quiet).toMatchObject({ changeRequest: false, changes: [], proposals: [] });
    expect(quiet.note).toBeUndefined();
    // A new item the model proposes is kept as a new item (with the title of an existing event
    // it is reported, so the reply says it would be a second one).
    const proposed = reconcile(message, { proposals: worst.proposals });
    expect(proposed.changeRequest).toBe(false);
    expect(proposed.changes).toEqual([]);
    expect(proposed.proposals).toHaveLength(worst.proposals.length);
  });

  it("'set' and 'put' never start a move by rule: only a move the model itself made of the event they name is kept", () => {
    const sync = byId("sync");
    const saturday = { kind: "update" as const, event: sync, starts_at: at("2026-11-14", 9), ends_at: at("2026-11-14", 10) };
    for (const message of ["Put the team sync on Friday.", "Set the team sync for Friday at 7 pm.", "Put the team sync on my calendar for Friday at 7 pm."]) {
      // The model returned nothing, or a new event: no move. The new event is reported as a second one.
      expect(reconcile(message), message).toMatchObject({ changeRequest: false, changes: [] });
      expect(reconcile(message).note, message).toBeUndefined();
      const second = reconcile(message, { proposals: [{ title: sync.title, starts_at: at("2026-11-13", 19), ends_at: at("2026-11-13", 20) }] });
      expect(second.changes, message).toEqual([]);
      expect(second.proposals, message).toHaveLength(1);
      expect(second.sameTitleAs.map((s) => s.event.id), message).toEqual(["sync"]);
      // The model moved that very event: kept, with the day (and time) the message names.
      const moved = reconcile(message, { changes: [saturday] });
      expect(moved.changes, message).toEqual([{ kind: "update", event: sync, next: { starts_at: at("2026-11-13", 19), ends_at: at("2026-11-13", 20) }, byRule: true }]);
      // The model moved ANOTHER event: left out.
      const other = reconcile(message, { changes: [{ kind: "update", event: byId("lecture"), starts_at: at("2026-11-13", 19), ends_at: at("2026-11-13", 21) }] });
      expect(other.changes, message).toEqual([]);
      expect(other.note, message).toContain("I did not read your message as asking for that");
    }
  });

  it("without a verb the rules read, the model's own change is kept only when the message asks for a change", () => {
    const friday = { kind: "update" as const, event: byId("sync"), starts_at: at("2026-11-13", 19), ends_at: at("2026-11-13", 20) };
    for (const message of ["The team sync needs to be on Friday instead.", "Can the team sync be on Friday instead?", "Can we push the team sync to Friday?", "Change the team sync"]) {
      const r = reconcile(message, { changes: [friday] });
      expect(r.changeRequest, message).toBe(false);
      expect(r.changes, message).toEqual([{ kind: "update", event: byId("sync"), next: { starts_at: friday.starts_at, ends_at: friday.ends_at, title: undefined }, byRule: false }]);
    }
    const renamed = reconcile("Rename the team sync to Demo dry run", { changes: [{ kind: "update", event: byId("sync"), title: "Demo dry run" }] });
    expect(renamed.changes).toEqual([{ kind: "update", event: byId("sync"), next: { starts_at: undefined, ends_at: undefined, title: "Demo dry run" }, byRule: false }]);
  });

  it("the reminder the model titles like its event is called a reminder; the appointment is untouched", () => {
    const r = reconcile("Set a reminder for my dentist appointment at 1 pm on Thursday.", {
      proposals: [{ title: "Dentist appointment", starts_at: at("2026-11-12", 13), ends_at: at("2026-11-12", 14, 30) }],
    });
    expect(r.proposals).toEqual([{ title: "Reminder: Dentist appointment", starts_at: at("2026-11-12", 13), ends_at: at("2026-11-12", 14, 30) }]);
    expect(r).toMatchObject({ changeRequest: false, changes: [], sameTitleAs: [] });
  });
});

/* ------------------------------------------------------------------------------------------
 * Direction 2: clear requests to move or cancel an event the message names.
 * ---------------------------------------------------------------------------------------- */

const MOVES: [message: string, event: string, start: string, end: string][] = [
  ["Move my dentist appointment to start at 4 pm the same day.", "dentist", at("2026-11-11", 16), at("2026-11-11", 17, 30)],
  ["Move my dentist appointment to Thursday at 1 pm.", "dentist", at("2026-11-12", 13), at("2026-11-12", 14, 30)],
  ["Move the dentist appointment on Wednesday to 4:00-5:30 pm.", "dentist", at("2026-11-11", 16), at("2026-11-11", 17, 30)],
  ["Reschedule tomorrow's lecture to Friday at 10 am", "lecture", at("2026-11-13", 10), at("2026-11-13", 12)],
  ["Move the dentist appointment to 16:00", "dentist", at("2026-11-11", 16), at("2026-11-11", 17, 30)],
  ["Move the dentist appointment to Nov 13 at 2pm", "dentist", at("2026-11-13", 14), at("2026-11-13", 15, 30)],
  ["Move the dentist appointment to Nov. 13 at 2pm", "dentist", at("2026-11-13", 14), at("2026-11-13", 15, 30)],
  ["Move the dentist appointment to Friday", "dentist", at("2026-11-13", 14), at("2026-11-13", 15, 30)],
  ["Push the team sync back by an hour", "sync", at("2026-11-10", 20), at("2026-11-10", 21)],
  ["Push back the team sync an hour", "sync", at("2026-11-10", 20), at("2026-11-10", 21)],
  ["Please move the dentist appointment 30 minutes later", "dentist", at("2026-11-11", 14, 30), at("2026-11-11", 16)],
  ["Can you move the lecture to 2-4 pm on Thursday?", "lecture", at("2026-11-12", 14), at("2026-11-12", 16)],
  ["Change the dentist appointment to end at 4 pm", "dentist", at("2026-11-11", 14), at("2026-11-11", 16)],
  ["Change my dentist appointment to 4 pm", "dentist", at("2026-11-11", 16), at("2026-11-11", 17, 30)],
  ["Change the time of my dentist appointment to 3 pm", "dentist", at("2026-11-11", 15), at("2026-11-11", 16, 30)],
  ["Move the dentist appointment to 4 pm for an hour", "dentist", at("2026-11-11", 16), at("2026-11-11", 17)],
  ["Bring the dentist appointment forward by an hour", "dentist", at("2026-11-11", 13), at("2026-11-11", 14, 30)],
  ["Pull the team sync forward by 30 minutes", "sync", at("2026-11-10", 18, 30), at("2026-11-10", 19, 30)],
  ["Put off the dentist appointment by 30 minutes", "dentist", at("2026-11-11", 14, 30), at("2026-11-11", 16)],
  ["Postpone the team sync by 30 minutes", "sync", at("2026-11-10", 19, 30), at("2026-11-10", 20, 30)],
  ["Delay the team sync by 15 minutes", "sync", at("2026-11-10", 19, 15), at("2026-11-10", 20, 15)],
  ["Shift the lecture to 1 pm tomorrow", "lecture", at("2026-11-10", 13), at("2026-11-10", 15)],
  ["I need to reschedule my dentist appointment to Thursday at 9 am.", "dentist", at("2026-11-12", 9), at("2026-11-12", 10, 30)],
  ["Reschedule my dentist appointment for Friday at 2 pm.", "dentist", at("2026-11-13", 14), at("2026-11-13", 15, 30)],
  ["Could you please postpone the Acme interview to Nov 17?", "acme", at("2026-11-17", 10), at("2026-11-17", 12)],
  ["Move the Acme interview to 2 pm", "acme", at("2026-11-16", 14), at("2026-11-16", 16)],
  ["Let's push the lecture to 1 pm", "lecture", at("2026-11-10", 13), at("2026-11-10", 15)],
  ["Move tomorrow's team sync to 8 pm", "sync", at("2026-11-10", 20), at("2026-11-10", 21)],
  ["Move the 2 pm appointment on Wednesday to 3 pm", "dentist", at("2026-11-11", 15), at("2026-11-11", 16, 30)],
  ["Move Dentist appointment to Friday at 3 pm", "dentist", at("2026-11-13", 15), at("2026-11-13", 16, 30)],
  ["Hey MONDAY, move the dentist appointment to 4 pm", "dentist", at("2026-11-11", 16), at("2026-11-11", 17, 30)],
  ["ok move the team sync to 8:30 pm", "sync", at("2026-11-10", 20, 30), at("2026-11-10", 21, 30)],
  ["Move the team sync meeting to 8 pm", "sync", at("2026-11-10", 20), at("2026-11-10", 21)],
  ["Move the dentist to 5 pm", "dentist", at("2026-11-11", 17), at("2026-11-11", 18, 30)],
  ["Move lunch with Sam to Sunday", "lunch", at("2026-11-15", 13), at("2026-11-15", 14)],
  ["Move the gym to 6 pm on Thursday", "gym", at("2026-11-12", 18), at("2026-11-12", 20)],
  // A reason or a second request names another time; it is not the new time.
  ["Move the dentist appointment to Friday because I have a lecture on Wednesday at 4 pm.", "dentist", at("2026-11-13", 14), at("2026-11-13", 15, 30)],
  ["Move the dentist appointment to Friday so that it doesn't clash with the lecture at 10 am.", "dentist", at("2026-11-13", 14), at("2026-11-13", 15, 30)],
  ["Move the dentist appointment to Friday, it clashes with the gym at 3 pm.", "dentist", at("2026-11-13", 14), at("2026-11-13", 15, 30)],
  ["Move the dentist appointment so it starts at 4 pm.", "dentist", at("2026-11-11", 16), at("2026-11-11", 17, 30)],
  ["Move the dentist appointment to 5 pm and block 3-5 pm tomorrow for the gym.", "dentist", at("2026-11-11", 17), at("2026-11-11", 18, 30)],
  ["Move the dentist appointment to 4 pm. Then add lunch tomorrow at noon.", "dentist", at("2026-11-11", 16), at("2026-11-11", 17, 30)],
  ["Add lunch tomorrow at noon and move the dentist appointment to 5 pm.", "dentist", at("2026-11-11", 17), at("2026-11-11", 18, 30)],
  ["Change of plans: move the dentist appointment to 5 pm.", "dentist", at("2026-11-11", 17), at("2026-11-11", 18, 30)],
  ["Schedule change: move the dentist appointment to 5 pm", "dentist", at("2026-11-11", 17), at("2026-11-11", 18, 30)],
  ["Quick question: can you move the dentist to 5 pm?", "dentist", at("2026-11-11", 17), at("2026-11-11", 18, 30)],
  ["Thanks! Now move the gym to Friday at 5 pm", "gym", at("2026-11-13", 17), at("2026-11-13", 19)],
  ["Yes, move the dentist appointment to 5 pm", "dentist", at("2026-11-11", 17), at("2026-11-11", 18, 30)],
  ["We need to move the team sync to 8 pm", "sync", at("2026-11-10", 20), at("2026-11-10", 21)],
  ["Actually, cancel that and move the dentist appointment to Friday at 3 pm instead", "dentist", at("2026-11-13", 15), at("2026-11-13", 16, 30)],
  ["Set a reminder for 9 am, then move the dentist appointment to 5 pm", "dentist", at("2026-11-11", 17), at("2026-11-11", 18, 30)],
  ["Move the dentist appointment to 5 pm and remind me to bring the forms", "dentist", at("2026-11-11", 17), at("2026-11-11", 18, 30)],
  ["Move the dentist appointment from 2 pm to 4 pm", "dentist", at("2026-11-11", 16), at("2026-11-11", 17, 30)],
  ["Move the dentist appointment from Wednesday to Friday", "dentist", at("2026-11-13", 14), at("2026-11-13", 15, 30)],
  ["Move the dentist appointment to tomorrow, same time", "dentist", at("2026-11-10", 14), at("2026-11-10", 15, 30)],
  ["Move the dentist appointment to the 13th", "dentist", at("2026-11-13", 14), at("2026-11-13", 15, 30)],
  ["Move the dentist appointment to Fri, Nov 13 at 2 pm", "dentist", at("2026-11-13", 14), at("2026-11-13", 15, 30)],
  ["Move the interview to Tuesday the 17th at 10 am", "acme", at("2026-11-17", 10), at("2026-11-17", 12)],
  ["Move the gym session to tomorrow morning at 7", "gym", at("2026-11-10", 7), at("2026-11-10", 9)],
  ["Move the team sync to tomorrow evening at 8", "sync", at("2026-11-10", 20), at("2026-11-10", 21)],
  ["Postpone the team sync until 9 pm", "sync", at("2026-11-10", 21), at("2026-11-10", 22)],
  ["Delay my dentist appointment until 3 pm", "dentist", at("2026-11-11", 15), at("2026-11-11", 16, 30)],
  ["Bring the lecture forward to 9 am", "lecture", at("2026-11-10", 9), at("2026-11-10", 11)],
  ["Block 2 hours for study and push the lecture back an hour", "lecture", at("2026-11-10", 11), at("2026-11-10", 13)],
  ["pls reschedule dentist appt to fri 3pm", "dentist", at("2026-11-13", 15), at("2026-11-13", 16, 30)],
  ["Move my 2pm to 4pm", "dentist", at("2026-11-11", 16), at("2026-11-11", 17, 30)],
  ["Move the push workout to 6 pm", "gym", at("2026-11-12", 18), at("2026-11-12", 20)],
  ["MOVE MY DENTIST APPOINTMENT TO 4PM", "dentist", at("2026-11-11", 16), at("2026-11-11", 17, 30)],
];

const CANCELS: [message: string, event: string][] = [
  ["Cancel my team sync", "sync"],
  ["Cancel the dentist appointment.", "dentist"],
  ["Please cancel the Acme interview.", "acme"],
  ["Delete the team sync for tomorrow", "sync"],
  ["Remove tomorrow's lecture", "lecture"],
  ["Remove the lecture from my calendar", "lecture"],
  ["Drop the team sync", "sync"],
  ["Call off the team sync", "sync"],
  ["Scrap the lecture", "lecture"],
  ["Cancel my appointment", "dentist"],
  ["Cancel lunch", "lunch"],
  ["Cancel the gym session on Thursday", "gym"],
  ["Cancel the team sync tomorrow and block 7-8 pm for dinner.", "sync"],
  ["I have to cancel the lecture, I am sick.", "lecture"],
  ["Cancel the team sync, the client cancelled.", "sync"],
  ["Cancel lunch with Sam, please", "lunch"],
  ["Drop the gym on Thursday, I'm tired", "gym"],
  ["Remove the gym from Thursday", "gym"],
  ["Sure, please cancel the team sync", "sync"],
  ["Would you kindly cancel the lecture", "lecture"],
  ["Move it to 5 pm and cancel the team sync", "sync"],
];

describe("direction 2: clear requests to move or cancel a named event are read by rule", () => {
  it.each(MOVES)("move: %s", (message, id, start, end) => {
    const event = byId(id);
    const expected = [{ kind: "update", event, next: { starts_at: start, ends_at: end }, byRule: true }];
    // Whatever the model returns: nothing, a wrong move, or the event again as a new one.
    const wrong = { kind: "update" as const, event, starts_at: at("2026-11-12", 4), ends_at: at("2026-11-12", 5) };
    for (const model of [
      {},
      { changes: [wrong] },
      { proposals: [{ title: event.title, starts_at: at("2026-11-14", 16), ends_at: at("2026-11-14", 17) }] },
      { changes: [{ kind: "delete" as const, event: byId(id === "sync" ? "lecture" : "sync") }] },
    ]) {
      const r = reconcile(message, model);
      expect(r.changeRequest).toBe(true);
      expect(r.changes).toEqual(expected);
      expect(r.note).toBeUndefined();
      // The moved event is never offered again as a new one.
      expect(r.proposals.filter((p) => p.title === event.title)).toEqual([]);
    }
  });

  it.each(CANCELS)("cancel: %s", (message, id) => {
    const event = byId(id);
    for (const model of [{}, { changes: [{ kind: "delete" as const, event: byId(id === "sync" ? "lecture" : "sync") }] }]) {
      const r = reconcile(message, model);
      expect(r.changeRequest).toBe(true);
      expect(r.changes).toEqual([{ kind: "delete", event, byRule: true }]);
      expect(r.note).toBeUndefined();
    }
  });

  it("a second request in the same message keeps its own proposal", () => {
    const gym = { title: "Gym", starts_at: at("2026-11-10", 15), ends_at: at("2026-11-10", 17) };
    expect(reconcile("Move the dentist appointment to 5 pm and block 3-5 pm tomorrow for the gym.", { proposals: [gym] }).proposals).toEqual([gym]);
    const dinner = { title: "Dinner", starts_at: at("2026-11-10", 19), ends_at: at("2026-11-10", 20) };
    expect(reconcile("Cancel the team sync tomorrow and block 7-8 pm for dinner.", { proposals: [dinner] }).proposals).toEqual([dinner]);
  });
});

/* ------------------------------------------------------------------------------------------
 * A clear move or cancel verb, but the rules cannot vouch for a card: a question or a refusal.
 * ---------------------------------------------------------------------------------------- */

describe("a clear verb without a clear target or time: no card, a question or a refusal", () => {
  /** The object shares a word with an event but is something else: that event is not changed. */
  const NOT_THAT_EVENT: [message: string, closest: string][] = [
    ["Cancel the reminder for my dentist appointment", "Dentist appointment"],
    ["Move the reminder for my dentist appointment to 1 pm", "Dentist appointment"],
    ["Move the Acme interview prep to Sunday at 3 pm", "Acme onsite interview"],
    ["Reschedule the call about the Acme interview to Friday", "Acme onsite interview"],
    ["Postpone the review before the lecture to 8 am", "Lecture — Distributed Systems"],
    ["Move my dentist visit to Friday", "Dentist appointment"],
    ["Cancel the lecture notes review", "Lecture — Distributed Systems"],
    ["Move the lecture notes to the shared drive", "Lecture — Distributed Systems"],
  ];
  it.each(NOT_THAT_EVENT)("%s", (message, closest) => {
    const worst = worstCase(message);
    for (const model of [{}, { changes: worst.moved }, { changes: worst.cancelled }, { proposals: worst.proposals }]) {
      const r = reconcile(message, model);
      expect(r.changes).toEqual([]);
      expect(r.changeRequest).toBe(true);
      expect(r.note).toContain("I could not find an event matching");
      expect(r.note).toContain(`The closest is **${closest}**`);
      expect(r.proposals).toEqual([]);
    }
  });

  it("an event that is not in the calendar is not found, and no new event of that name is offered", () => {
    const yoga = reconcile("Move my yoga class to 6 pm", { proposals: [{ title: "Yoga class", starts_at: at("2026-11-10", 18), ends_at: at("2026-11-10", 19) }] });
    expect(yoga).toMatchObject({ changeRequest: true, changes: [], proposals: [] });
    expect(yoga.note).toBe('I could not find an event matching "my yoga class" in your calendar for the next 7 days.');
    const hallucinated = reconcile("Please move the hallucinated thing to tomorrow 9 am.", { unknownChangeRefs: 1 });
    expect(hallucinated.note).toContain('I could not find an event matching "the hallucinated thing"');
    // The model points at an event the message does not name: offered as a question, not a card.
    const teeth = reconcile("Move my teeth cleaning to 5 pm", { changes: [{ kind: "update", event: byId("dentist"), starts_at: at("2026-11-11", 17) }] });
    expect(teeth.changes).toEqual([]);
    expect(teeth.note).toContain("The closest is **Dentist appointment**");
  });

  it("asks instead of guessing: am or pm, which Monday, which of two events, a time that has passed", () => {
    expect(reconcile("Move the team sync to 8").note).toContain("8:00 AM or 8:00 PM");
    expect(reconcile("Move the Acme interview to Monday").note).toContain("Which day");
    expect(reconcile("Cancel the meeting tomorrow").note).toMatch(/More than one event matches.*Lecture.*Team sync/);
    expect(reconcile("Move the team sync to 9 am today").note).toContain("has already passed");
    const twoDentists = [...EVENTS, { id: "prep", title: "✍️ Prepare for dentist", starts_at: at("2026-11-12", 8, 30), ends_at: at("2026-11-12", 10) }];
    const r = reconcileCalendarChanges({ ...base, events: twoDentists, message: "Move the dentist to 5 pm", modelChanges: [], modelProposals: [] });
    expect(r.changes).toEqual([]);
    expect(r.note).toMatch(/More than one event matches "the dentist".*Dentist appointment.*Prepare for dentist/);
    for (const message of ["Move the team sync to 8", "Move the Acme interview to Monday", "Cancel the meeting tomorrow", "Move the team sync to 9 am today"]) {
      expect(reconcile(message)).toMatchObject({ changeRequest: true, changes: [] });
    }
  });

  it("several events in one request: one change per message, and none is guessed", () => {
    for (const message of ["Cancel the team sync and the lecture", "Move tomorrow's lecture and team sync to Friday", "Move the lecture, the team sync and the dentist to next week"]) {
      const r = reconcile(message, { changes: worstCase(message).cancelled });
      expect(r, message).toMatchObject({ changeRequest: true, changes: [] });
      expect(r.note, message).toMatch(/^Your message names \d events: .*I prepare one change at a time/);
    }
  });

  it("a weekday that is not the date's, or a day the event is not on: asked, not guessed", () => {
    expect(reconcile("Move the dentist appointment to Thursday Nov 13").note).toBe("Which day did you mean for **Dentist appointment**: Fri, Nov 13 or Thu, Nov 12?");
    const friday = reconcile("Cancel the dentist appointment on Friday");
    expect(friday.changes).toEqual([]);
    expect(friday.note).toContain('I could not find an event matching "the dentist appointment on friday"');
    expect(friday.note).toContain("The closest is **Dentist appointment** (Wed, Nov 11, 2:00 PM)");
    expect(reconcile("Move the dentist appointment to Wednesday").note).toBe("**Dentist appointment** is already at that time.");
  });

  it("after a cancel a new event of that name may be wanted; after a move it is the move again", () => {
    const again = { title: "Dentist appointment", starts_at: at("2026-11-13", 14), ends_at: at("2026-11-13", 15, 30) };
    const cancelled = reconcile("Cancel the dentist appointment and book a new one for Friday at 2 pm", { proposals: [again] });
    expect(cancelled.changes).toEqual([{ kind: "delete", event: byId("dentist"), byRule: true }]);
    expect(cancelled.proposals).toEqual([again]);
    expect(reconcile("Move the dentist appointment to Friday at 2 pm", { proposals: [again] }).proposals).toEqual([]);
  });

  it("a pronoun and the wrong kind of answer: 'Cancel that' answered with a move is not a cancel", () => {
    const moved = { kind: "update" as const, event: byId("dentist"), starts_at: at("2026-11-13", 9), ends_at: at("2026-11-13", 10, 30) };
    expect(reconcile("Cancel that", { changes: [moved] })).toMatchObject({ changeRequest: false, changes: [] });
    expect(reconcile("Cancel that", { proposals: [{ title: "Dentist appointment", starts_at: moved.starts_at, ends_at: moved.ends_at }] }).changes).toEqual([]);
    expect(reconcile("Cancel that", { changes: [{ kind: "delete", event: byId("dentist") }] }).changes).toEqual([{ kind: "delete", event: byId("dentist"), byRule: false }]);
    expect(reconcile("Push it to Friday", { changes: [{ kind: "delete", event: byId("gym") }] }).changes).toEqual([]);
  });

  it("a model change is kept only for an event the message mentions, by a title word or by its day", () => {
    const sync = { kind: "delete" as const, event: byId("sync") };
    expect(reconcile("I can't make it tomorrow evening", { changes: [sync] }).changes).toEqual([{ kind: "delete", event: byId("sync"), byRule: false }]);
    expect(reconcile("I can't make it on Thursday", { changes: [sync] }).changes).toEqual([]);
    expect(reconcile("Make it an hour longer", { changes: [{ kind: "update", event: byId("sync"), ends_at: at("2026-11-10", 21) }] }).changes).toEqual([]);
    expect(reconcile("Make the team sync an hour longer", { changes: [{ kind: "update", event: byId("sync"), ends_at: at("2026-11-10", 21) }] }).changes).toHaveLength(1);
    expect(reconcile("Update the dentist appointment to Friday at 9 am", { changes: [{ kind: "update", event: byId("dentist"), starts_at: at("2026-11-13", 9) }] }).changes).toHaveLength(1);
  });

  it("a pronoun names no event: the one event the model points at, with the time read by rule", () => {
    const r = reconcile("Move it to 5 pm", { changes: [{ kind: "update", event: byId("dentist"), starts_at: at("2026-11-12", 5) }] });
    expect(r.changes).toEqual([{ kind: "update", event: byId("dentist"), next: { starts_at: at("2026-11-11", 17), ends_at: at("2026-11-11", 18, 30) }, byRule: true }]);
    expect(reconcile("Move it to 5 pm")).toMatchObject({ changeRequest: false, changes: [] });
    expect(reconcile("Move it to 5 pm").note).toBeUndefined();
  });

  it("not about the calendar: the rules stay out", () => {
    for (const message of ["Cancel my Netflix subscription", "Move on to the next priority", "Move apartments on Saturday", "Remove the second priority"]) {
      const r = reconcile(message);
      expect(r, message).toMatchObject({ changeRequest: false, changes: [] });
      expect(r.note, message).toBeUndefined();
    }
  });

  it("a named event without a new day or time: the model's time if it gave one for THAT event, else no card", () => {
    const friday = { kind: "update" as const, event: byId("dentist"), starts_at: at("2026-11-13", 9), ends_at: at("2026-11-13", 10, 30) };
    expect(reconcile("Move the dentist appointment to after lunch", { changes: [friday] }).changes).toEqual([
      { kind: "update", event: byId("dentist"), next: { starts_at: friday.starts_at, ends_at: friday.ends_at }, byRule: false },
    ]);
    const other = reconcile("Move the dentist appointment", { changes: [{ kind: "update", event: byId("lecture"), starts_at: at("2026-11-13", 9), ends_at: at("2026-11-13", 11) }] });
    expect(other.changes).toEqual([]);
    expect(other.note).toContain("I did not read your message as asking for that");
    expect(reconcile("Change the lecture to online")).toMatchObject({ changeRequest: false, changes: [] });
    expect(reconcile("Change the lecture to online").note).toBeUndefined();
  });
});
