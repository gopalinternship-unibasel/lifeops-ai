/**
 * QA round 5 (11 Nov 2026), two major defects.
 *
 * 1. A week named next to a weekday was not read: "Move the dentist appointment to Friday next
 *    week at 3 pm." gave a card for THIS Friday, also when the model had answered correctly, and
 *    "to yesterday" / "to last Friday" kept the event's own day or this Friday.
 * 2. A reply that says something was done was shown unchanged in a turn with no card at all:
 *    "Set a reminder for the dentist appointment at 13:00 on Thursday, 2026-11-12. This reminder
 *    will appear in your notifications at the specified time." (the real default model).
 */
import { describe, expect, it } from "vitest";
import {
  asksForAction,
  matchEvent,
  parseChangeRequest,
  parseDay,
  reconcileCalendarChanges,
  resolveMove,
  type KnownEvent,
} from "@/server/calendar/change-request.server";
import { composeReply, NOTHING_ADDED, NOTHING_PREPARED } from "@/server/ai/reply-guard.server";

const ZRH = "Europe/Zurich";
const TODAY = "2026-11-11"; // a Wednesday
const NOW = Date.parse("2026-11-11T09:00:00Z");

/** Local Zurich wall-clock time (UTC+1 in November) as UTC ISO. */
const at = (date: string, hour: number, minute = 0) =>
  new Date(Date.parse(`${date}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00Z`) - 3_600_000).toISOString();

const EVENTS: KnownEvent[] = [
  { id: "sync", title: "Team sync — demo walkthrough", starts_at: at("2026-11-11", 19), ends_at: at("2026-11-11", 20) },
  { id: "lecture", title: "Lecture — Distributed Systems", starts_at: at("2026-11-12", 10), ends_at: at("2026-11-12", 12) },
  { id: "dentist", title: "Dentist appointment", starts_at: at("2026-11-13", 14), ends_at: at("2026-11-13", 15, 30) },
];

function move(message: string) {
  const request = parseChangeRequest(message, TODAY);
  expect(request, message).not.toBeNull();
  const match = matchEvent(request!, EVENTS, ZRH);
  expect(match.status, message).toBe("one");
  return match.status === "one" ? resolveMove(request!, match.event, ZRH) : null;
}

describe("a week named next to the weekday", () => {
  const dates = (text: string) => {
    const day = parseDay(text, TODAY).day;
    return day && day !== "same" ? day.dates : undefined;
  };

  it("reads the week (today is Wed 11 Nov 2026; weeks start on Monday)", () => {
    for (const text of [
      "friday next week at 3 pm",
      "friday of next week at 3 pm",
      "next week friday at 3 pm",
      "next week on friday at 3 pm",
      "friday in the following week at 3 pm",
      "a week from friday at 3 pm",
      "friday week at 3 pm",
      "friday after next at 3 pm",
      "friday in a week at 3 pm",
    ]) {
      expect(dates(text), text).toEqual(["2026-11-20"]);
    }
    expect(dates("thursday of next week at 2 pm")).toEqual(["2026-11-19"]);
    expect(dates("monday next week")).toEqual(["2026-11-16"]);
    expect(dates("sunday next week")).toEqual(["2026-11-22"]);
    expect(dates("friday in two weeks at 3 pm")).toEqual(["2026-11-27"]);
    expect(dates("two weeks from friday")).toEqual(["2026-11-27"]);
    expect(dates("friday of the week after next")).toEqual(["2026-11-27"]);
    // Monday of this week is over: the Monday two calendar weeks on, or two weeks after the next Monday.
    expect(dates("monday in two weeks")).toEqual(["2026-11-23", "2026-11-30"]);
    // The words about the week are taken out of the text, so the clock is still read.
    expect(parseDay("friday next week at 3 pm", TODAY).rest.replace(/\s+/g, " ").trim()).toBe("at 3 pm");
  });

  it("a plain weekday, 'this' and 'next' read as before", () => {
    expect(dates("friday at 3 pm")).toEqual(["2026-11-13"]);
    expect(dates("this friday")).toEqual(["2026-11-13"]);
    expect(dates("next friday")).toEqual(["2026-11-13", "2026-11-20"]);
    expect(dates("tomorrow")).toEqual(["2026-11-12"]);
    expect(dates("friday the 20th at 3 pm")).toEqual(["2026-11-20"]);
  });

  it("'Move the dentist appointment to Friday next week at 3 pm.' proposes Fri 20 Nov, by rule", () => {
    for (const message of [
      "Move the dentist appointment to Friday next week at 3 pm.",
      "Move the dentist appointment to next week Friday at 3 pm.",
      "Move the dentist appointment to a week from Friday at 3 pm.",
      "Please reschedule my dentist appointment to Friday of next week, 3 pm.",
    ]) {
      expect(move(message), message).toEqual({ status: "resolved", starts_at: at("2026-11-20", 15), ends_at: at("2026-11-20", 16, 30), byRule: true });
    }
    expect(move("Move the lecture to Thursday of next week at 2 pm.")).toEqual({
      status: "resolved", starts_at: at("2026-11-19", 14), ends_at: at("2026-11-19", 16), byRule: true,
    });
    expect(move("Move the dentist appointment to Friday in two weeks at 3 pm.")).toEqual({
      status: "resolved", starts_at: at("2026-11-27", 15), ends_at: at("2026-11-27", 16, 30), byRule: true,
    });
    // Only the week changes: same clock time.
    expect(move("Move the dentist appointment to Friday next week.")).toEqual({
      status: "resolved", starts_at: at("2026-11-20", 14), ends_at: at("2026-11-20", 15, 30), byRule: true,
    });
  });

  it("end to end: the model's correct answer is kept, a wrong one is corrected to the asked week", () => {
    const base = { today: TODAY, timeZone: ZRH, nowMs: NOW, events: EVENTS, modelProposals: [] };
    const message = "Move the dentist appointment to Friday next week at 3 pm.";
    const right = reconcileCalendarChanges({ ...base, message, modelChanges: [{ kind: "update", event: EVENTS[2], starts_at: at("2026-11-20", 15), ends_at: at("2026-11-20", 16, 30) }] });
    expect(right.changes.map((c) => [c.event.id, c.kind, c.next?.starts_at, c.next?.ends_at])).toEqual([["dentist", "update", at("2026-11-20", 15), at("2026-11-20", 16, 30)]]);
    const wrong = reconcileCalendarChanges({ ...base, message, modelChanges: [{ kind: "update", event: EVENTS[2], starts_at: at("2026-11-13", 15), ends_at: at("2026-11-13", 16, 30) }] });
    expect(wrong.changes.map((c) => [c.event.id, c.kind, c.next?.starts_at, c.next?.ends_at])).toEqual([["dentist", "update", at("2026-11-20", 15), at("2026-11-20", 16, 30)]]);
    const none = reconcileCalendarChanges({ ...base, message, modelChanges: [] });
    expect(none.changes.map((c) => [c.event.id, c.next?.starts_at])).toEqual([["dentist", at("2026-11-20", 15)]]);
  });

  it("a day that is over gets a question back, not this week's day", () => {
    for (const [message, day] of [
      ["Move the dentist appointment to yesterday at 3 pm.", "Tue, Nov 10"],
      ["Move the dentist appointment to last Friday at 3 pm.", "Fri, Nov 6"],
      ["Move the dentist appointment to Friday last week at 3 pm.", "Fri, Nov 6"],
      ["Move the dentist appointment to the day before yesterday.", "Mon, Nov 9"],
      ["Move the dentist appointment to two days ago at 3 pm.", "Mon, Nov 9"],
    ] as const) {
      expect(move(message), message).toEqual({ status: "unclear", question: `${day} is already over. Which day should **Dentist appointment** move to?` });
    }
    // Also when the model proposes something for it.
    const request = parseChangeRequest("Move the dentist appointment to last Friday at 3 pm.", TODAY)!;
    const resolved = resolveMove(request, EVENTS[2], ZRH, { starts_at: at("2026-11-13", 15), ends_at: at("2026-11-13", 16, 30) });
    expect(resolved.status).toBe("unclear");
  });

  it("week or month words the rules cannot place get a question back", () => {
    for (const message of [
      "Move the dentist appointment to Friday next month at 3 pm.",
      "Move the dentist appointment to Friday two weeks later at 3 pm.",
    ]) {
      expect(move(message), message).toEqual({ status: "unclear", question: "I could not tell which date you mean. Which date should **Dentist appointment** move to?" });
    }
  });

  it("yesterday's and last week's events can still be named as the event to move", () => {
    const request = parseChangeRequest("Move yesterday's lecture to Friday at 10 am.", TODAY);
    expect(request?.sourceDay?.dates).toEqual(["2026-11-10"]);
    expect(request?.day).toMatchObject({ dates: ["2026-11-13"] });
  });
});

describe("a reply that says it is done, in a turn with no card", () => {
  const compose = (modelReply: string, opts: Partial<Parameters<typeof composeReply>[0]> = {}) =>
    composeReply({ modelReply, timeZone: ZRH, pendingEvents: [], pendingEventChanges: [], askedForAction: true, actionRequest: true, ...opts });

  it("the real default model's reminder reply is replaced", () => {
    expect(
      compose("Set a reminder for the dentist appointment at 13:00 on Thursday, 2026-11-12. This reminder will appear in your notifications at the specified time."),
    ).toBe(NOTHING_PREPARED);
  });

  it("the other replies QA round 5 found unflagged are replaced", () => {
    for (const reply of [
      "You're all set! I've put it on your calendar for tomorrow at 6 pm.",
      "I emailed Sam to confirm 1 pm.",
      "It's on your calendar now.",
      "Your appointment was moved to Friday at 4 pm.",
      "Your calendar is updated.",
      "The email was dispatched to Sam.",
      "Got it, I'll remind you at 5 pm.",
      "Reminder set: dentist appointment, Thursday 13:00.",
      "Consider it done.",
      "Added a yoga session for tomorrow at 6 pm.",
      "The yoga session is booked for tomorrow at 6 pm.",
      "You'll get a reminder 30 minutes before.",
    ]) {
      expect(compose(reply), reply).toBe(NOTHING_PREPARED);
    }
  });

  it("whatever else the model wrote is followed by a plain statement that nothing was added", () => {
    // A wording no list has: it stays, but cannot stand as a confirmation.
    expect(compose("Your Thursday now includes a dentist reminder at 1 pm.")).toBe(`Your Thursday now includes a dentist reminder at 1 pm.\n\n${NOTHING_ADDED}`);
    // A question back is kept.
    expect(compose("What time should the yoga session start, and how long is it?")).toBe(`What time should the yoga session start, and how long is it?\n\n${NOTHING_ADDED}`);
    // A claim before a question: the claim goes, the question stays.
    expect(compose("I've added it. Which calendar colour would you like?")).toBe(`Which calendar colour would you like?\n\n${NOTHING_ADDED}`);
    // A plan in words is still shown.
    const plan = "Here is a plan for your afternoon:\n- 14:00 review the lecture notes\n- 16:00 gym";
    expect(compose(plan)).toBe(`${plan}\n\n${NOTHING_ADDED}`);
    // An empty reply.
    expect(compose("")).toBe(NOTHING_PREPARED);
  });

  it("a question is answered as before, and a turn with a card is confirmed from the card", () => {
    // Not a request to do something: the model's description stands, with no note.
    expect(
      composeReply({ modelReply: "Your dentist appointment is scheduled for Friday at 2 pm.", timeZone: ZRH, pendingEvents: [], pendingEventChanges: [], askedForAction: false, actionRequest: false }),
    ).toBe("Your dentist appointment is scheduled for Friday at 2 pm.");
    // After a question, a claim is still removed.
    expect(
      composeReply({ modelReply: "Yes. I'll remind you at 5 pm.", timeZone: ZRH, pendingEvents: [], pendingEventChanges: [], askedForAction: false, actionRequest: false }),
    ).toBe("Yes.");
    // With a card the reply is the card's confirmation, without the note.
    const withCard = compose("Done!", {
      pendingEvents: [{ id: "p1", title: "Yoga", starts_at: at("2026-11-12", 18), ends_at: at("2026-11-12", 19) }] as never,
    });
    expect(withCard).toContain("Proposed for your calendar:");
    expect(withCard).not.toContain(NOTHING_ADDED);
    // A note about a refused change is a result of its own.
    const refused = compose("Moved it.", { changeRequest: true, changeNote: "I could not find an event matching \"the standup\"." });
    expect(refused).toBe("I could not find an event matching \"the standup\". Nothing in your calendar was changed.");
    // Another card (an insight, priorities) is a result too.
    expect(compose("Here are your priorities.", { hasOtherCards: true })).toBe("Here are your priorities.");
  });

  it("asksForAction: requests to do something, not questions", () => {
    for (const message of [
      "Set a reminder for my dentist appointment at 1 pm on Thursday.",
      "Add a yoga session tomorrow at 6 pm.",
      "Please confirm lunch with Sam for me.",
      "Email Sam that I will be late.",
      "Can you draft a reply to the recruiter?",
      "Move the dentist appointment to Friday at 4 pm.",
      "Cancel the team sync.",
      "Remind me to call mum at 5 pm.",
      "Put the lecture on my calendar for Friday at 10 am.",
      "Let Sam know I am running late.",
    ]) {
      expect(asksForAction(message), message).toBe(true);
    }
    for (const message of [
      "When is my dentist appointment?",
      "What is on my calendar tomorrow?",
      "How many unread emails do I have?",
      "Did Sam reply about lunch?",
      "Summarise my inbox.",
      "Can you tell me what is on my calendar tomorrow?",
      "Tell me about my day.",
      "Send me my schedule for Friday.",
      "Write a summary of my week.",
      "Draft a plan for my afternoon.",
      "Do I have any reminders today?",
      "What should I write to Sam?",
      "Let me know when I am free on Friday.",
    ]) {
      expect(asksForAction(message), message).toBe(false);
    }
  });
});
