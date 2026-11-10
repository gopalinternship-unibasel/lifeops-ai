/**
 * The reply guard removes sentences that claim a finished action. It must not remove what the
 * model truthfully says about the calendar: a review of the round-4 patterns found that "Your
 * dentist appointment is scheduled for Wednesday at 2 pm" (the answer to "When is my dentist
 * appointment?") was removed as a claim, which left "The AI model answered without a valid
 * proposal ...". Both directions are listed here.
 */
import { describe, expect, it } from "vitest";
import { composeReply, hasWrongWeekday, removeActionClaims } from "@/server/ai/reply-guard.server";
import { asksForCalendarAction } from "@/server/calendar/change-request.server";

const ZRH = "Europe/Zurich";
const plain = (modelReply: string, actionRequest = false) =>
  composeReply({ modelReply, timeZone: ZRH, pendingEvents: [], pendingEventChanges: [], actionRequest, year: 2026 });
const NO_PROPOSAL = "The AI model answered without a valid proposal, so nothing was prepared or changed. Please try again, naming the day and the time.";

/** True statements about the calendar or the inbox: kept, whatever the user asked. */
const DESCRIPTIONS = [
  "Your dentist appointment is on Wednesday from 14:00 to 15:30.",
  "You have two events tomorrow: the lecture at 10:00 and the team sync at 19:00.",
  "Scheduled events today are the lecture and the team sync.",
  "Scheduled for Friday: nothing yet.",
  "The meeting is set to discuss the demo.",
  "Alicia says the team sync is moved to 7 PM today.",
  "Sam asked whether lunch on Saturday at 1 pm works.",
  "I can draft a reply once you tell me which email you mean.",
  "Saturday is free after 2 pm.",
  "The lecture ends at 12:00, so 12:30 would work for lunch.",
  "I set the ranking by length: longer events first.",
];

/** Answers to a QUESTION that describe the calendar with words a confirmation also uses. */
const ANSWERS = [
  "Your dentist appointment is scheduled for Wednesday at 2 pm.",
  "You have 3 events scheduled this week.",
  "The team sync and the lecture are scheduled for tomorrow.",
  "No meetings are booked on Friday.",
];

/** Claims that something was done: removed (MONDAY changes nothing before the user clicks). */
const CLAIMS_ALWAYS = [
  "I've moved your dentist appointment to Friday.",
  "Your dentist appointment has been moved to 4:00 PM today.",
  "The event has been set for Friday.",
  "Moved your dentist appointment.",
  "Done!",
  "All set!",
  "Scheduled your gym session for 6 pm.",
  "Booked it for tomorrow at 3.",
  "Reminder set for Thursday at 1 pm.",
  "Your reminder is set.",
  "I set a reminder for Thursday at 1 pm.",
  "I've set up a gym session for you.",
  "Your gym session is set.",
  "The reply was sent.",
  "Your gym session is now scheduled for 6 pm.",
  "The block is saved to your calendar.",
];

/** Claims only in the answer to a request for something new or for a change. */
const CLAIMS_AFTER_ACTION_REQUEST = ["Your gym session is scheduled for tomorrow at 6 pm.", "Gym session booked for 6 pm tomorrow.", "Event created for Friday at 3 pm."];

describe("claims and descriptions", () => {
  it.each(DESCRIPTIONS)("kept: %s", (sentence) => {
    expect(removeActionClaims(sentence).removed).toBe(0);
    expect(removeActionClaims(sentence, true).removed).toBe(0);
    expect(plain(sentence)).toBe(sentence);
  });

  it.each(ANSWERS)("kept in the answer to a question: %s", (sentence) => {
    expect(removeActionClaims(sentence).removed).toBe(0);
    expect(plain(sentence)).toBe(sentence);
  });

  it.each(CLAIMS_ALWAYS)("removed: %s", (sentence) => {
    expect(removeActionClaims(sentence).removed).toBe(1);
    expect(plain(`${sentence} Anything else?`)).toBe("Anything else?");
    expect(plain(sentence)).toBe(NO_PROPOSAL);
  });

  it.each(CLAIMS_AFTER_ACTION_REQUEST)("removed after a request for something new or a change: %s", (sentence) => {
    expect(removeActionClaims(sentence, true).removed).toBe(1);
    expect(plain(sentence, true)).toBe(NO_PROPOSAL);
    expect(removeActionClaims(sentence).removed).toBe(0);
  });

  it("a change the model made unasked is left out; the answer to a question stands, with its times", () => {
    const note = "The AI model also suggested changing **Dentist appointment** (Wed, Nov 11, 2:00 PM). I did not read your message as asking for that, so I left it out.";
    const base = { timeZone: ZRH, pendingEvents: [], pendingEventChanges: [], changeNote: note, year: 2026 };
    expect(composeReply({ ...base, modelReply: "Your dentist appointment is on Wednesday at 14:00. I cancelled it.", changeNoteIsAside: true })).toBe(
      `Your dentist appointment is on Wednesday at 14:00.\n\n${note} Nothing in your calendar was changed.`,
    );
    // After a request for something new, a sentence with a time would read as a confirmation.
    expect(composeReply({ ...base, modelReply: "I'll remind you on Thursday at 1 PM.", changeNoteIsAside: true, actionRequest: true })).toBe(`${note} Nothing in your calendar was changed.`);
    // A refused time is not an aside: the model's own times go.
    expect(composeReply({ ...base, modelReply: "It will be at 4 AM on Thursday." })).toBe(`${note} Nothing in your calendar was changed.`);
  });

  it("which messages ask for something new or a change", () => {
    for (const message of [
      "Set a reminder for my dentist appointment at 1 pm on Thursday.",
      "Set up a gym session tomorrow at 6 pm for an hour.",
      "Block 3–5 pm tomorrow for a gym push workout.",
      "Move my dentist appointment to start at 4 pm the same day.",
      "Cancel my team sync",
      "Can you schedule lunch with Sam on Saturday at 1 pm?",
    ]) {
      expect(asksForCalendarAction(message), message).toBe(true);
    }
    for (const message of ["When is my dentist appointment?", "What's on Saturday?", "Check my emails", "Show my schedule for tomorrow", "Draft a reply to Sam's email about lunch on Saturday: yes, 1 pm works."]) {
      expect(asksForCalendarAction(message), message).toBe(false);
    }
  });

  it("a weekday next to a date: wrong only if it fits neither this year nor the next", () => {
    expect(hasWrongWeekday("Thursday 2026-11-14", 2026)).toBe(true);
    expect(hasWrongWeekday("Thu, Nov 12", 2026)).toBe(false);
    // Asked in December 2026 about January 2027: Fri, Jan 1 is right (in 2026 it was a Thursday).
    expect(hasWrongWeekday("Fri, Jan 1", 2026)).toBe(false);
    expect(hasWrongWeekday("Wed, Jan 1", 2026)).toBe(true);
    expect(hasWrongWeekday("Monday 2027-01-01", 2026)).toBe(true);
    expect(hasWrongWeekday("Sat, Feb 30", 2026)).toBe(false); // not a date: nothing to check
  });
});
