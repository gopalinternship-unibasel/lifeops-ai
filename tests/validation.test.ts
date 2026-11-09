import { describe, expect, it } from "vitest";
import { z } from "zod";
import { getErrorMessage } from "@/lib/errors";
import { describeIssues, parseInput, readableErrorMessage } from "@/lib/validation";

const ProcessChatInput = z.object({
  sessionId: z.string().uuid(),
  message: z.string().min(1).max(4000),
});
const session = "4b7f3c1e-8a3d-4c55-9a9e-3f1a2b3c4d5e";

describe("readable validation errors", () => {
  it("says a 4,001-character chat message is too long instead of showing zod JSON", () => {
    expect(() => parseInput(ProcessChatInput, { sessionId: session, message: "x".repeat(4001) })).toThrowError(
      "Your message is too long: the limit is 4,000 characters. Please shorten it.",
    );
  });

  it("returns the parsed data when the input is valid", () => {
    expect(parseInput(ProcessChatInput, { sessionId: session, message: "hi" })).toEqual({ sessionId: session, message: "hi" });
  });

  it("names empty fields and keeps custom refinement messages", () => {
    expect(describeIssues([{ code: "too_small", type: "string", minimum: 1, path: ["message"] }])).toBe("Your message is empty.");
    const Ranged = z.object({ a: z.number(), b: z.number() }).refine((v) => v.b > v.a, "Event must end after it starts");
    expect(() => parseInput(Ranged, { a: 2, b: 1 })).toThrowError("Event must end after it starts.");
  });

  it("turns a raw ZodError message (what the browser used to get) into a sentence", () => {
    const raw = ProcessChatInput.safeParse({ sessionId: session, message: "x".repeat(4001) });
    expect(raw.success).toBe(false);
    const json = raw.success ? "" : raw.error.message;
    expect(json.trim().startsWith("[")).toBe(true);
    expect(readableErrorMessage(json)).toBe("Your message is too long: the limit is 4,000 characters. Please shorten it.");
    expect(getErrorMessage(new Error(json))).toBe("Your message is too long: the limit is 4,000 characters. Please shorten it.");
    // Ordinary messages pass through.
    expect(getErrorMessage(new Error("Ollama did not answer within 900 s."))).toBe("Ollama did not answer within 900 s.");
    expect(readableErrorMessage("[not json")).toBe("[not json");
  });
});
