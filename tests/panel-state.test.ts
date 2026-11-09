import { describe, expect, it } from "vitest";
import { isToday, mergeUnique, withoutHandledCards } from "@/lib/panel-state";
import { cardIdsOfPanel, withDraftCardId } from "@/server/chat-cards.server";
import type { PanelPayload } from "@/types/panel";

const panel: PanelPayload = {
  pendingEvents: [
    { id: "pending-a", title: "Gym", starts_at: "2026-11-10T14:00:00.000Z", ends_at: "2026-11-10T16:00:00.000Z" },
    { id: "pending-b", title: "Read", starts_at: "2026-11-10T17:00:00.000Z", ends_at: "2026-11-10T18:00:00.000Z" },
  ],
  pendingEventChanges: [
    {
      id: "change-a",
      kind: "delete",
      event_id: "ev-1",
      original: { title: "Team sync", starts_at: "2026-11-09T18:00:00Z", ends_at: "2026-11-09T19:00:00Z" },
    },
  ],
  emailDraft: { id: "draft-a", messageId: "m1", to: "sam@example.com", subject: "Lunch", body: "Yes, 1 pm works." },
};

describe("handled workspace cards after a reload", () => {
  it("leaves out saved, applied and dismissed cards and keeps the rest actionable", () => {
    const result = withoutHandledCards(panel, {
      "pending-a": { status: "saved", resultId: "ev-9" },
      "change-a": { status: "applied", resultId: "ev-1" },
    });
    expect(result.pendingEvents?.map((e) => e.id)).toEqual(["pending-b"]);
    expect(result.pendingEventChanges).toEqual([]);
    expect(result.emailDraft?.saved).toBeUndefined();
  });

  it("shows a saved reply read-only with the body that was saved, and drops a dismissed one", () => {
    const saved = withoutHandledCards(panel, {
      "draft-a": { status: "saved", resultId: "d1", savedBody: "Yes, 1 pm works. See you!" },
    });
    expect(saved.emailDraft).toMatchObject({ saved: true, body: "Yes, 1 pm works. See you!" });
    expect(withoutHandledCards(panel, { "draft-a": { status: "dismissed", resultId: null } }).emailDraft).toBeUndefined();
  });

  it("gives drafts stored before card ids existed a stable id and lists every card id", () => {
    const old = { emailDraft: { messageId: "m1", to: "a", subject: "s", body: "b" } };
    const withId = withDraftCardId(old, "msg-42");
    expect(withId?.emailDraft?.id).toBe("draft-msg-42");
    expect(withDraftCardId(old, "msg-42")?.emailDraft?.id).toBe("draft-msg-42"); // same id on every load
    expect(cardIdsOfPanel(panel)).toEqual(["pending-a", "pending-b", "change-a", "draft-a"]);
  });
});

describe("today's schedule", () => {
  const now = new Date(2026, 10, 9, 15, 8); // Monday 15:08 local time

  it("keeps only blocks that overlap today", () => {
    const today = { starts_at: new Date(2026, 10, 9, 19).toISOString(), ends_at: new Date(2026, 10, 9, 20).toISOString() };
    const tomorrow = { starts_at: new Date(2026, 10, 10, 15).toISOString(), ends_at: new Date(2026, 10, 10, 17).toISOString() };
    const overnight = { starts_at: new Date(2026, 10, 8, 23).toISOString(), ends_at: new Date(2026, 10, 9, 1).toISOString() };
    expect(isToday(today, now)).toBe(true);
    expect(isToday(tomorrow, now)).toBe(false);
    expect(isToday(overnight, now)).toBe(true);
  });

  it("merges the same event written in different ISO formats once", () => {
    const merged = mergeUnique(
      [{ title: "Gym", starts_at: "2026-11-10T14:00:00+00:00", ends_at: "2026-11-10T16:00:00+00:00" }],
      [{ title: "Gym", starts_at: "2026-11-10T14:00:00.000Z", ends_at: "2026-11-10T16:00:00.000Z" }],
    );
    expect(merged).toHaveLength(1);
  });
});
