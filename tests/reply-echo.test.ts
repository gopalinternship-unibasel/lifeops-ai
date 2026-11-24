import { describe, expect, it } from "vitest";
import { composeReply, NOTHING_PREPARED } from "@/server/ai/reply-guard.server";
import type { PendingEvent } from "@/types/panel";

const ZRH = "Europe/Zurich";
const followUp: PendingEvent = {
  id: "pending-1",
  title: "Follow-up emails to startups",
  starts_at: "2026-11-20T09:00:00.000Z",
  ends_at: "2026-11-20T11:00:00.000Z",
};
const CARD_LINE =
  "Proposed for your calendar:\n- **Follow-up emails to startups**: Fri, Nov 20, 10:00 AM – 12:00 PM\n\nNothing is saved until you click **Save to Calendar** on the right.";

// Live on 19 Nov 2026: the model copied the server's own confirmation from an earlier reply in
// the chat history; the guard removed its time line and kept the heading and the footer, so the
// reply showed an empty "Proposed for your calendar:" block before the real one.
describe("the model's copy of the server's card line", () => {
  for (const actionRequest of [false, true]) {
    it(`is dropped, the card line appears once (actionRequest=${actionRequest})`, () => {
      const reply = composeReply({
        modelReply: CARD_LINE,
        timeZone: ZRH,
        pendingEvents: [followUp],
        pendingEventChanges: [],
        actionRequest,
        askedForAction: true,
      });
      expect(reply).toBe(CARD_LINE);
    });
  }

  it("keeps the model's own words around it", () => {
    const reply = composeReply({
      modelReply: `Good luck with the meetings!\n\n${CARD_LINE}`,
      timeZone: ZRH,
      pendingEvents: [followUp],
      pendingEventChanges: [],
      actionRequest: true,
      askedForAction: true,
    });
    expect(reply).toBe(`Good luck with the meetings!\n\n${CARD_LINE}`);
  });

  it("with no card, a copied card line is not a proposal", () => {
    const reply = composeReply({
      modelReply: CARD_LINE,
      timeZone: ZRH,
      pendingEvents: [],
      pendingEventChanges: [],
      actionRequest: true,
      askedForAction: true,
    });
    expect(reply).not.toContain("Save to Calendar");
    expect(reply).toBe(NOTHING_PREPARED);
  });
});
