/**
 * Review of 24 Nov 2026: which model changes a message that the rules do not read as a move or
 * cancel still asks for. Finding 19 (other cancel and rebook wordings were dropped, with a note
 * telling the user to name an event they had named), finding 23 (questions, thoughts and
 * messages to others kept the model's move or cancel card) and the calendar part of finding 86
 * (a request to send something is told apart from a calendar request).
 */
import { describe, expect, it } from "vitest";
import {
  asksForAction,
  asksToSend,
  reconcileCalendarChanges,
  type KnownEvent,
  type ModelChange,
} from "@/server/calendar/change-request.server";

const ZRH = "Europe/Zurich";
const TODAY = "2026-11-24";
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
const cancelSync: ModelChange = { kind: "delete", event: event("sync") };
const dentistToFriday: ModelChange = {
  kind: "update",
  event: event("dentist"),
  starts_at: zrh("2026-11-27", 13),
  ends_at: zrh("2026-11-27", 14, 30),
};
function reconcile(message: string, modelChanges: ModelChange[]) {
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

describe("other ways to cancel or rebook (finding 19)", () => {
  it.each([
    "Get rid of the team sync.",
    "Take the team sync off my calendar.",
    "Please take the team sync out of my schedule",
    "Scratch the team sync",
    "Unschedule the team sync",
  ])("keeps the model's cancel for: %s", (message) => {
    const result = reconcile(message, [cancelSync]);
    expect(result.changes).toEqual([{ kind: "delete", event: event("sync"), byRule: false }]);
    expect(result.unasked).toBeFalsy();
  });

  it("keeps the model's move for 'rebook' and an arrow", () => {
    const rebook = reconcile("Rebook the dentist appointment for Friday at 1 pm.", [
      dentistToFriday,
    ]);
    expect(rebook.changes).toHaveLength(1);
    expect(rebook.changes[0].next?.starts_at).toBe("2026-11-27T12:00:00.000Z");
    expect(reconcile("Dentist appointment -> Friday 1 pm", [dentistToFriday]).changes).toHaveLength(
      1,
    );
  });

  it.each([
    "Remind me to get rid of the team sync.",
    "Don't take the team sync off my calendar.",
    "I'll take the day off tomorrow, so the team sync is fine",
  ])("still leaves the cancel out for: %s", (message) => {
    const result = reconcile(message, [cancelSync]);
    expect(result.changes).toEqual([]);
    expect(result.unasked).toBe(true);
  });

  it("words the note by what was left out, and does not ask to name an event the message named", () => {
    const named = reconcile("I'll take the day off, the team sync can stay", [cancelSync]);
    expect(named.note).toContain('for example "Cancel Team sync — demo walkthrough"');
    expect(named.note).not.toMatch(/name it|Move /);
    expect(named.note).toMatch(/also suggested cancelling \*\*Team sync — demo walkthrough\*\*/);
    const unnamed = reconcile("Thanks, that's all", [cancelSync]);
    expect(unnamed.note).toMatch(
      /To cancel an event, name it, for example "Cancel Team sync — demo walkthrough"/,
    );
    const move = reconcile("Thanks, that's all", [dentistToFriday]);
    expect(move.note).toMatch(
      /also suggested moving .*To move an event, name it, for example "Move Dentist appointment to Friday at 3 pm"/,
    );
  });
});

describe("questions, thoughts and messages to others (finding 23)", () => {
  it.each([
    ["Should I cancel the team sync?", cancelSync],
    ["Should I move the dentist appointment to Friday?", dentistToFriday],
    ["Would moving the dentist appointment to Friday cause a conflict?", dentistToFriday],
    ["If I move the dentist appointment to Friday, will it clash with anything?", dentistToFriday],
    ["I can't cancel the team sync, right?", cancelSync],
    ["Not sure if I should cancel the team sync.", cancelSync],
    ["I'm thinking about moving the dentist appointment to Friday.", dentistToFriday],
    ["Cancelling the team sync would be bad.", cancelSync],
    ["Let Alicia know we need to cancel the team sync.", cancelSync],
    ["We might cancel the team sync.", cancelSync],
  ])("leaves the model's change out for: %s", (message, change) => {
    const result = reconcile(message, [change]);
    expect(result.changes).toHaveLength(0);
    expect(result.unasked).toBe(true);
  });

  it.each([
    ["Can you cancel the team sync?", cancelSync],
    ["I need to cancel the team sync.", cancelSync],
    ["Can we do the dentist appointment on Friday at 1 pm instead?", dentistToFriday],
    ["Could you move the dentist appointment to Friday at 1 pm?", dentistToFriday],
    ["The team sync should be cancelled", cancelSync],
  ])("still keeps exactly one change for the request: %s", (message, change) => {
    expect(reconcile(message, [change]).changes).toHaveLength(1);
  });
});

describe("a request to send something (finding 86, calendar part)", () => {
  it.each([
    "Send my reply to Sam",
    "Email Alicia that I'm running late",
    "Please send it",
    "Reply to Sam and say yes",
    "Text Sam that I'm in",
  ])("asksToSend: %s", (message) => {
    expect(asksToSend(message)).toBe(true);
    expect(asksForAction(message)).toBe(true);
  });

  it.each([
    "Send me my schedule for tomorrow",
    "Email summary, please",
    "Draft a reply to Sam",
    "Move the team sync to 8 pm",
    "What did Sam send me?",
    "Tell me what is on tomorrow",
    "Add a yoga session tomorrow at 6 pm",
  ])("not a send request: %s", (message) => {
    expect(asksToSend(message)).toBe(false);
  });
});
