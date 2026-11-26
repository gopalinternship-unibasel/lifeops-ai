// A real Gmail draft came out as "... Best, Gopal Best, gopalkrishnadeveloper": the model signed
// off and the server added its own sign-off (live test, 26 Nov 2026).
import { describe, expect, it } from "vitest";
import { endsWithSignOff, withSignOff } from "@/server/chat-turn.server";

describe("draft sign-off", () => {
  it("adds no second sign-off when the model signed off with another name", () => {
    const body = "Thanks for the heads-up. I've noted the December 1 date.\n\nBest,\nGopal";
    expect(withSignOff(body, "gopalkrishnadeveloper")).toBe(body);
  });

  it("recognises common sign-offs on their own line or with a name", () => {
    expect(endsWithSignOff("Text.\n\nKind regards,\nMaria Lopez")).toBe(true);
    expect(endsWithSignOff("Text.\n\nThanks,\nSam")).toBe(true);
    expect(endsWithSignOff("Text.\nCheers")).toBe(true);
    expect(endsWithSignOff("Text.\n\nBest, Gopal")).toBe(true);
  });

  it("does not take an ordinary sentence for a sign-off", () => {
    expect(endsWithSignOff("Thanks for the heads-up on the Cloudflare Observability pricing changes.")).toBe(false);
    expect(endsWithSignOff("I will review it.\nRegards to the whole team at the Basel office and everyone else")).toBe(false);
  });

  it("still signs a body that has no sign-off", () => {
    expect(withSignOff("Thanks, I will be there.", "Gopal Krishna")).toBe("Thanks, I will be there.\n\nBest,\nGopal");
  });
});
