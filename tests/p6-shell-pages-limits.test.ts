import { describe, expect, it } from "vitest";
import { describeIssues, profileLengthProblem, TEXT_LIMITS } from "@/lib/validation";

describe("text limits shared with the database", () => {
  it("match the CHECK constraints agreed for the tables", () => {
    expect(TEXT_LIMITS).toEqual({
      profileName: 100,
      profileRole: 100,
      profileGoals: 2000,
      taskTitle: 300,
      taskReason: 1000,
      eventTitle: 200,
      eventNotes: 2000,
      chatMessage: 12000,
      draftSubject: 300,
      draftBody: 12000,
      draftRecipient: 320,
    });
  });

  it("names the first profile field that is too long, before the database refuses it", () => {
    expect(profileLengthProblem({ name: "Alex", role: "Student", goals: "Ship the paper" })).toBeNull();
    expect(profileLengthProblem({ name: "n".repeat(100), role: null, goals: "g".repeat(2000) })).toBeNull();
    expect(profileLengthProblem({ name: "n".repeat(101), goals: "" })).toBe(
      "Your name is too long: the limit is 100 characters. Please shorten it.",
    );
    expect(profileLengthProblem({ name: "Alex", goals: "g".repeat(2001) })).toBe(
      "Your goals text is too long: the limit is 2,000 characters. Please shorten it.",
    );
  });

  it("gives the profile fields readable names in validation messages", () => {
    expect(describeIssues([{ code: "too_big", type: "string", maximum: 2000, path: ["goals"] }])).toBe(
      "Your goals text is too long: the limit is 2,000 characters. Please shorten it.",
    );
    expect(describeIssues([{ code: "too_small", type: "string", minimum: 1, path: ["name"] }])).toBe("Your name is empty.");
  });
});
