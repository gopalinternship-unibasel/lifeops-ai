// When every proposal of a turn is refused (its time is over or it overlaps a known event), the
// model's own "please save" sentence must go: the closing line already says none can be saved.
// Live check of 26 Nov 2026: "Please save the event to confirm it." stood above "None of these
// can be saved."
import { describe, expect, it } from "vitest";
import { composeReply } from "@/server/ai/reply-guard.server";
import type { PendingEvent } from "@/types/panel";

const ZRH = "Europe/Zurich";
const reading = {
  id: "p1",
  title: "Reading",
  starts_at: "2026-11-26T08:00:00Z",
  ends_at: "2026-11-26T09:00:00Z",
} as PendingEvent;
const gym = {
  id: "p2",
  title: "Gym",
  starts_at: "2026-11-27T07:00:00Z",
  ends_at: "2026-11-27T08:00:00Z",
} as PendingEvent;

function reply(modelReply: string, pendingEvents: PendingEvent[], refused: string[]) {
  return composeReply({
    modelReply,
    timeZone: ZRH,
    pendingEvents,
    pendingEventChanges: [],
    refused,
    actionRequest: true,
    askedForAction: true,
    year: 2026,
  });
}

describe("a reply whose proposals are all refused", () => {
  it("drops the model's request to save", () => {
    const text = reply("Please save the event to confirm it.", [reading], ["p1"]);
    expect(text).not.toMatch(/Please save/);
    expect(text).toMatch(/None of these can be saved/);
  });

  it("keeps the model's other sentences", () => {
    const text = reply("Reading is good for focus. Please save the event to confirm it.", [reading], ["p1"]);
    expect(text).toContain("Reading is good for focus.");
    expect(text).not.toMatch(/Please save/);
  });

  it("leaves the request to save alone when one proposal can still be saved", () => {
    const text = reply("Please save the event to confirm it.", [reading, gym], ["p1"]);
    expect(text).toContain("Please save the event to confirm it.");
  });
});
