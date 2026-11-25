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
    // "from scratch" is an idiom, not "scratch the team sync" (reviewer of 24 Nov 2026).
    "Redo the team sync slides from scratch",
    "Let's start the team sync prep from scratch",
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

  const syncTo8: ModelChange = {
    kind: "update",
    event: event("sync"),
    starts_at: zrh("2026-11-24", 20),
    ends_at: zrh("2026-11-24", 21),
  };
  it.each([
    "I'm thinking the team sync should move to 8 pm, please do it",
    "Should the team sync be moved to 8 pm? Yes please do it",
    "Should the team sync move to 8 pm? Go ahead.",
    "I might move the team sync to 8 pm. Yes, do it.",
    // "thinking" without about, of, if or whether is not a thought about whether to do it.
    "I'm thinking the team sync should move to 8 pm",
    // A direct imperative at the start of a sentence or a clause (review of 25 Nov 2026).
    "Should the team sync move to 8 pm? If so, do it.",
    "Should the team sync move to 8 pm? Yes.",
    "Should the team sync move to 8 pm? Just do it.",
    "Should the team sync move to 8 pm? Please do it when you can.",
  ])("keeps the change when the message also says to go ahead: %s", (message) => {
    const result = reconcile(message, [syncTo8]);
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0].next?.starts_at).toBe(zrh("2026-11-24", 20));
    expect(result.unasked).toBeFalsy();
  });

  it.each([
    ["Should I cancel the team sync? Yes or no?", cancelSync],
    ["Should I cancel the team sync, or should I do it later?", cancelSync],
    ["I can't cancel the team sync, yes?", cancelSync],
    ["Not sure if I should cancel the team sync, don't do it yet", cancelSync],
    ["I'm wondering whether to move the team sync to 8 pm", syncTo8],
    // "do it" about the user's own doing, put off, or as a maybe (review of 25 Nov 2026).
    ["Should I cancel the team sync? I'll do it myself later", cancelSync],
    ["I'm thinking of cancelling the team sync. Let me do it later.", cancelSync],
    ["Should I cancel the team sync or just do it next week?", cancelSync],
    ["Should I cancel the team sync? I'd rather do it tomorrow", cancelSync],
    ["Should I cancel the team sync? Maybe, do it if it clashes", cancelSync],
    ["Should I cancel the team sync? If it clashes, do it.", cancelSync],
    ["Should I cancel the team sync? Yes, but I'll do it myself later", cancelSync],
    ["Should the team sync move to 8 pm? Do it later.", syncTo8],
    ["Should the team sync move to 8 pm? Go ahead, but only if Alicia agrees.", syncTo8],
    ["Should the team sync move to 8 pm? Yes?", syncTo8],
    // Put off, or on a condition, also with other lead words (review of 25 Nov 2026, second pass).
    ["Should I cancel the team sync? Do it, but not yet", cancelSync],
    ["Should I cancel the team sync? Then do it later", cancelSync],
    ["Should I cancel the team sync? Yes, thanks, but not yet", cancelSync],
    ["Should I cancel the team sync? Go ahead, next week", cancelSync],
    ["Should I cancel the team sync? And do it myself", cancelSync],
    ["Should the team sync move to 8 pm? Do it whenever Alicia agrees", syncTo8],
    // A change request on a condition next to the question (pre-existing, same review).
    ["Should I cancel the team sync? Cancel it if Alicia agrees", cancelSync],
    ["Should I cancel the team sync? Go ahead and cancel it if it clashes", cancelSync],
    ["Should I cancel the team sync? Cancel it, but not now", cancelSync],
  ])("a go-ahead word that is not one does not keep the change: %s", (message, change) => {
    const result = reconcile(message, [change]);
    expect(result.changes).toHaveLength(0);
    expect(result.unasked).toBe(true);
  });

  // Review of 25 Nov 2026 (second pass): the first go-ahead rule of this round dropped these clear
  // go-aheads, which the older rule had kept.
  it.each([
    ["Should I cancel the team sync? Then do it", cancelSync],
    ["Should I cancel the team sync? Ok, then do it", cancelSync],
    ["Should I cancel the team sync? Definitely do it", cancelSync],
    ["Should I cancel the team sync? Yes, and do it now", cancelSync],
    ["Should I cancel the team sync? Do it now, not later", cancelSync],
    ["Should I cancel the team sync? Do it, not tomorrow", cancelSync],
    ["Should I cancel the team sync? Sure, why not", cancelSync],
    ["Should I cancel the team sync? Yes, thanks", cancelSync],
    ["Should I cancel the team sync? Yes that's right", cancelSync],
    ["Should I cancel the team sync? Do it, if you can", cancelSync],
    ["Should I cancel the team sync? Do it if you can", cancelSync],
    ["Should I cancel the team sync? When you can, do it.", cancelSync],
    ["Should I cancel the team sync? Cancel it", cancelSync],
    ["Should I cancel the team sync? Yes, cancel it if you can", cancelSync],
    ["Should the team sync move to 8 pm? Yes, do it - when you can", syncTo8],
    ["Should the team sync move to 8 pm? Do it whenever you can", syncTo8],
    ["Should the team sync move to 8 pm? Go ahead, next time ask first", syncTo8],
    ["Should the team sync move to 8 pm? Absolutely, go ahead", syncTo8],
    ["Should the team sync move to 8 pm? Fine, do it", syncTo8],
  ])("keeps the model's change for a go-ahead after the question: %s", (message, change) => {
    const result = reconcile(message, [change]);
    expect(result.changes).toEqual([
      change.kind === "delete"
        ? { kind: "delete", event: event("sync"), byRule: false }
        : {
            kind: "update",
            event: event("sync"),
            next: { starts_at: change.starts_at, ends_at: change.ends_at },
            byRule: false,
          },
    ]);
    expect(result.note).toBeUndefined();
    expect(result.unasked).toBeFalsy();
  });

  it("still prepares a change on a condition that is not next to a question", () => {
    expect(reconcile("Cancel the team sync if it clashes", [cancelSync]).changes).toEqual([
      { kind: "delete", event: event("sync"), byRule: true },
    ]);
  });
});

describe("a request to send something (finding 86, calendar part)", () => {
  it.each([
    "Send my reply to Sam",
    "Email Alicia that I'm running late",
    "Please send it",
    "Reply to Sam and say yes",
    "Text Sam that I'm in",
    // Forwarding is sending (reviewer of 24 Nov 2026).
    "Forward the email to Sam",
    "Fwd the recruiter's email to Ana",
    "Send the meeting notes to Sam tomorrow",
    // A day or a time in what to write, or a day's people, is not where it goes (review of 25 Nov 2026).
    "Reply to Alicia that the team sync can move to 8 pm",
    "Send Sam a message that I'm moving the team sync to 8 pm",
    "Email Alicia that I need to cancel the team sync",
    "Send the slides to today's attendees",
    "Email Sam: the team sync moves to Friday",
    // What to write starts with a new subject after the person (review of 25 Nov 2026, second pass).
    "Tell Alicia I will move the team sync to 8 pm",
    "Text the team we're moving the sync to Friday",
    "Tell Sam it moves to Friday",
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
    // To a day or a time, or with a move: a calendar request (reviewer of 24 Nov 2026).
    "Send the dentist appointment to Friday",
    "Send the team sync to next week",
    "Send the team sync to 8 pm",
    "Email Sam the agenda and move the team sync to 8 pm",
    "Forward me the recruiter's email",
    // "that" naming the thing to send, and a day with its own word boundary.
    "Send that meeting to Friday",
    "Send the team sync to tomorrow",
    // A day's time slot is a time, not a day's people.
    "Send the dentist appointment to Friday's 2 pm slot",
    "Send the team sync to tomorrow's 3 pm slot",
    "Text it to 5 pm",
  ])("not a send request: %s", (message) => {
    expect(asksToSend(message)).toBe(false);
  });
});
