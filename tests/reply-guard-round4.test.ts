/**
 * QA round 4 (10 Nov 2026): replies the guard still let through with the test double, and the
 * reply for a reminder that the parser used to turn into a move.
 */
import { describe, expect, it } from "vitest";
import { composeReply, hasWrongWeekday, NOTHING_ANSWERED, removeActionClaims, resolveRefs } from "@/server/ai/reply-guard.server";
import type { EmailDraftSuggestion, PendingEvent } from "@/types/panel";

const ZRH = "Europe/Zurich";
const refs = {
  events: { E1: "Team sync — demo walkthrough", E2: "Dentist appointment" },
  emails: { e3: 'the email "Lunch this Saturday?"' },
};

describe("short ids in replies", () => {
  it("known ids become the event's title or the email; a sentence about an unknown id is removed", () => {
    expect(resolveRefs("E2 is on Wednesday. Moved E99. Sam wrote e3.", refs)).toEqual({
      text: 'Dentist appointment is on Wednesday. Sam wrote the email "Lunch this Saturday?".',
      removed: 1,
    });
    // Without an email map (Gmail), "e5" is left alone.
    expect(resolveRefs("Version e5 is out.", { events: refs.events }).text).toBe("Version e5 is out.");
  });

  it("'Moved E99.' (an event id the calendar does not have): nothing is claimed, nothing internal shown", () => {
    const reply = composeReply({
      modelReply: "Moved E99.",
      timeZone: ZRH,
      pendingEvents: [],
      pendingEventChanges: [],
      changeRequest: true,
      changeNote: 'I could not find an event matching "the hallucinated thing" in your calendar for the next 3 weeks.',
      refs,
    });
    expect(reply).toBe('I could not find an event matching "the hallucinated thing" in your calendar for the next 3 weeks. Nothing in your calendar was changed.');
    // Even with no note at all, the claim does not survive.
    const bare = composeReply({ modelReply: "Moved E99.", timeZone: ZRH, pendingEvents: [], pendingEventChanges: [], refs });
    expect(bare).not.toMatch(/E99|Moved/);
  });

  it("a claim that starts the sentence is a claim; a heading with a colon is not", () => {
    expect(removeActionClaims("Done! Scheduled your gym session. Have a nice day.").text).toBe("Have a nice day.");
    expect(removeActionClaims("Scheduled for Friday: the lecture at 10:00.").removed).toBe(0);
  });
});

describe("the real default model's reminder answer (10 Nov 2026)", () => {
  it("'Reminder set for Thursday 2026-11-14 13:00:00 ...' with no card is not shown as done", () => {
    const reply = composeReply({
      modelReply: "Reminder set for Thursday 2026-11-14 13:00:00 for the dentist appointment.",
      timeZone: ZRH,
      pendingEvents: [],
      pendingEventChanges: [],
      refs,
      year: 2026,
      askedForAction: true,
    });
    expect(reply).toBe("The AI model answered without a valid proposal, so nothing was prepared or changed. Please try again, naming the day and the time.");
    // The same answer to a question gets the neutral notice (review of 24 Nov 2026).
    expect(
      composeReply({
        modelReply: "Reminder set for Thursday 2026-11-14 13:00:00 for the dentist appointment.",
        timeZone: ZRH,
        pendingEvents: [],
        pendingEventChanges: [],
        refs,
        year: 2026,
      }),
    ).toBe(NOTHING_ANSWERED);
  });

  it("other 'set' claims are claims; 'set to' and plain sentences are not", () => {
    expect(removeActionClaims("Your gym session is set. I set a reminder for you. Enjoy!").text).toBe("Enjoy!");
    expect(removeActionClaims("The meeting is set to discuss the demo.").removed).toBe(0);
  });

  it("a weekday that is not its date's is wrong; a right one is fine", () => {
    expect(hasWrongWeekday("Reminder on Thursday 2026-11-14 at 13:00", 2026)).toBe(true);
    expect(hasWrongWeekday("Thu, Nov 14", 2026)).toBe(true);
    expect(hasWrongWeekday("Thursday 2026-11-12 at 13:00", 2026)).toBe(false);
    expect(hasWrongWeekday("Thu, Nov 12, 1:00 PM", 2026)).toBe(false);
    expect(hasWrongWeekday("Saturday 14 Nov", 2026)).toBe(false);
  });
});

describe("drafts", () => {
  it("'Draft ready.' without a draft card is removed and the user is told why there is none", () => {
    const reply = composeReply({
      modelReply: "Draft ready.",
      timeZone: ZRH,
      pendingEvents: [],
      pendingEventChanges: [],
      refs,
      emailNote: "The AI model referred to an email that is not in your inbox, so no reply draft was prepared. Nothing was saved or sent.",
    });
    expect(reply).toBe("The AI model referred to an email that is not in your inbox, so no reply draft was prepared. Nothing was saved or sent.");
  });

  it("with a draft card the model's sentence about it stays", () => {
    const draft: EmailDraftSuggestion = { id: "draft-1", messageId: "e3", to: "Sam (friend)", subject: "Lunch this Saturday?", body: "Hi Sam", saved: false, draftId: null };
    const reply = composeReply({ modelReply: "Here's a draft reply to Sam.", timeZone: ZRH, pendingEvents: [], pendingEventChanges: [], emailDraft: draft, refs });
    expect(reply).toBe("Here's a draft reply to Sam.");
  });
});

describe("a reminder is a new card, never described as a move", () => {
  it("'Ready to move your dentist appointment' next to a new reminder card is removed; the card's line says what it is", () => {
    const reminder: PendingEvent = { id: "pending-1", title: "Reminder: Dentist appointment", starts_at: "2026-11-12T12:00:00.000Z", ends_at: "2026-11-12T12:15:00.000Z" };
    const reply = composeReply({
      modelReply: "Ready to move your dentist appointment. I set a reminder for Thursday at 1 pm.",
      timeZone: ZRH,
      pendingEvents: [reminder],
      pendingEventChanges: [],
      refs,
    });
    expect(reply).toBe(
      "Proposed for your calendar:\n- **Reminder: Dentist appointment**: Thu, Nov 12, 1:00 PM – 1:15 PM\n\nNothing is saved until you click **Save to Calendar** on the right.",
    );
  });

  it("a new event with an existing event's title says it adds a second one", () => {
    const second: PendingEvent = { id: "pending-2", title: "Dentist appointment", starts_at: "2026-11-13T13:00:00.000Z", ends_at: "2026-11-13T14:30:00.000Z" };
    const reply = composeReply({
      modelReply: "Sure.",
      timeZone: ZRH,
      pendingEvents: [second],
      pendingEventChanges: [],
      notes: { "pending-2": "**Dentist appointment** is already in your calendar on Wed, Nov 11, 2:00 PM – 3:30 PM; saving this adds a second one" },
    });
    expect(reply).toContain("saving this adds a second one");
  });
});
