import { describe, expect, it } from "vitest";
import { composeReply, removeActionClaims, stripInternalMarkers } from "@/server/ai/reply-guard.server";
import type { PendingEvent, PendingEventChange } from "@/types/panel";

const ZRH = "Europe/Zurich";

// QA round 3, user T: the model's reply for "Move my dentist appointment to start at 4 pm the same day."
const QA_REPLY =
  "Your emails and messages have been checked. Here is a summary of what's in your inbox (4 unread):\n\n" +
  "• **From** — *Subject* — short snippet\n\n📅 Today\n" +
  "- [event_id:7514bd44-0ed1-473b-9313-9414d7bdb307] QA deep work block — 9:00 AM–11:00 AM (120 min)\n" +
  "- [event_id:f7e95077-02ed-4d82-ba8d-f0cbf849e8b5] Dentist appointment — 2:00 PM–3:30 PM (90 min)\n\n" +
  "Your dentist appointment has been moved to 4:00 PM today. Please confirm this change by clicking Save.";

const move: PendingEventChange = {
  id: "change-1",
  kind: "update",
  event_id: "f7e95077-02ed-4d82-ba8d-f0cbf849e8b5",
  original: { title: "Dentist appointment", starts_at: "2026-11-11T13:00:00.000Z", ends_at: "2026-11-11T14:30:00.000Z" },
  next: { starts_at: "2026-11-11T15:00:00.000Z", ends_at: "2026-11-11T16:30:00.000Z" },
};

describe("cleaning model replies", () => {
  it("removes event ids, short ids, email ids, bare UUIDs and the prompt's template line", () => {
    const out = stripInternalMarkers(QA_REPLY);
    expect(out).not.toMatch(/event_id|7514bd44|f7e95077/);
    expect(out).not.toMatch(/From\W+Subject\W+short snippet/);
    expect(stripInternalMarkers("Move E3 [E3] (id: e2) id=e1 now")).toBe("Move E3 now");
    expect(stripInternalMarkers("- E3 14:00-15:30 Dentist appointment\n- E4 Lecture")).toBe("- 14:00-15:30 Dentist appointment\n- Lecture");
  });

  it("drops sentences that claim a finished action, keeps the rest", () => {
    const { text, removed } = removeActionClaims("I've moved your dentist appointment. Have a great day! The reply was sent. I've proposed a gym block.");
    expect(removed).toBe(2);
    expect(text).toBe("Have a great day! I've proposed a gym block.");
    // Quoting an email that says a meeting "is moved" is not a claim.
    expect(removeActionClaims("Alicia says the team sync is moved to 7 PM today.").removed).toBe(0);
  });
});

describe("the reply agrees with the cards", () => {
  it("a move request: only the card's own times, never the model's '4:00 PM today' or its ids", () => {
    const reply = composeReply({ modelReply: QA_REPLY, timeZone: ZRH, pendingEvents: [], pendingEventChanges: [move], changeRequest: true });
    expect(reply).toBe(
      "Ready to move **Dentist appointment** from Wed, Nov 11, 2:00 PM – 3:30 PM to **Wed, Nov 11, 4:00 PM – 5:30 PM**. Nothing changes until you click **Save changes** on the right.",
    );
  });

  it("a refused change says why and that nothing changed", () => {
    const reply = composeReply({
      modelReply: "Your dentist appointment has been moved to 4:00 PM today.",
      timeZone: ZRH,
      pendingEvents: [],
      pendingEventChanges: [],
      changeRequest: true,
      changeNote: 'More than one event matches "the dentist": ... Which one do you mean?',
    });
    expect(reply).toBe('More than one event matches "the dentist": ... Which one do you mean? Nothing in your calendar was changed.');
  });

  it("a new proposal: the model's time sentences are replaced by the card's line; a conflict is named", () => {
    const gym: PendingEvent = { id: "pending-1", title: "Gym — push workout", starts_at: "2026-11-10T14:00:00.000Z", ends_at: "2026-11-10T16:00:00.000Z" };
    const reply = composeReply({
      modelReply: "I've scheduled your gym session for tomorrow at 3 PM. Stay hydrated!",
      timeZone: ZRH,
      pendingEvents: [gym],
      pendingEventChanges: [],
      notes: { "pending-1": 'overlaps "Lecture": Save will be refused' },
    });
    expect(reply).toBe(
      'Stay hydrated!\n\nProposed for your calendar:\n- **Gym — push workout**: Tue, Nov 10, 3:00 PM – 5:00 PM (overlaps "Lecture": Save will be refused)\nNothing is saved until you click **Save to Calendar** on the right.',
    );
  });

  it("a claim with no card left is not repeated; the user is told nothing changed", () => {
    const reply = composeReply({ modelReply: "Your dentist appointment has been moved.", timeZone: ZRH, pendingEvents: [], pendingEventChanges: [] });
    expect(reply).toContain("nothing was changed");
  });

  it("a plain answer without cards keeps the model's text (ids removed)", () => {
    const reply = composeReply({ modelReply: "On Wednesday you have E3 [E3] the dentist appointment at 14:00.", timeZone: ZRH, pendingEvents: [], pendingEventChanges: [] });
    expect(reply).toBe("On Wednesday you have E3 the dentist appointment at 14:00.");
  });
});
