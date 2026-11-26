import { describe, expect, it } from "vitest";
import { dropEventsAside, mergeWithExisting, sameItem, MERGED_PRIORITIES_MAX } from "@/server/ai/priority-merge.server";

const row = (rank: number, title: string) => ({ rank, title, reason: "" });

describe("merging a typed list with the inbox and calendar priorities (L5)", () => {
  it("keeps the earlier items below the new ones, with new ranks", () => {
    const merged = mergeWithExisting([row(1, "Renew passport")], [row(2, "Team sync"), row(1, "Acme interview prep")]);
    expect(merged.priorities.map((p) => [p.rank, p.title])).toEqual([
      [1, "Renew passport"],
      [2, "Acme interview prep"],
      [3, "Team sync"],
    ]);
    expect(merged.kept).toHaveLength(2);
  });

  it("leaves the list alone when it names an earlier item (a re-rank) or when there is nothing earlier", () => {
    const fresh = [row(1, "Acme interview prep"), row(2, "Team sync")];
    expect(mergeWithExisting(fresh, [row(1, "Team sync"), row(2, "Acme interview prep")]).priorities).toEqual(fresh);
    expect(mergeWithExisting(fresh, []).priorities).toEqual(fresh);
  });

  it("does not repeat an earlier item and stops at the cap", () => {
    const many = Array.from({ length: 20 }, (_, i) => row(i + 1, `Alpha${i} bravo${i}`));
    const merged = mergeWithExisting([row(1, "Renew passport")], [...many, row(21, "Alpha3 bravo3")]);
    expect(merged.priorities).toHaveLength(MERGED_PRIORITIES_MAX);
    expect(new Set(merged.priorities.map((p) => p.title)).size).toBe(MERGED_PRIORITIES_MAX);
  });

  it("matches titles by their words, not their wording", () => {
    expect(sameItem("Finish paper citations by Saturday", "Finish the paper citations")).toBe(true);
    expect(sameItem("Call mom", "Buy groceries")).toBe(false);
  });

  it("drops the 'events first' aside only when no event is listed", () => {
    const reply = "Here's your ranked list (today's events first, then tasks by importance): one, two.";
    expect(dropEventsAside(reply, [row(1, "Call mom")], ["Team sync"])).toBe("Here's your ranked list: one, two.");
    expect(dropEventsAside(reply, [row(1, "Team sync")], ["Team sync"])).toBe(reply);
    expect(dropEventsAside("No aside here.", [], [])).toBe("No aside here.");
  });
});
