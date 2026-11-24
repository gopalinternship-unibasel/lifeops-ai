import { describe, expect, it } from "vitest";
import {
  NETWORK_FAILURE_MESSAGE,
  getErrorMessage,
  isAuthFailure,
  isNetworkFailure,
} from "@/lib/errors";

describe("errors shown when a request does not reach the server", () => {
  it.each([
    "Failed to fetch",
    "Load failed",
    "NetworkError when attempting to fetch resource.",
    "Network request failed",
  ])("maps the browser's network TypeError %j to a sentence for the user", (message) => {
    expect(isNetworkFailure(new TypeError(message))).toBe(true);
    expect(getErrorMessage(new TypeError(message), "Save failed")).toBe(NETWORK_FAILURE_MESSAGE);
  });

  it("does not promise that nothing was changed (the server may have finished the request)", () => {
    expect(NETWORK_FAILURE_MESSAGE).toBe(
      "Could not reach MONDAY. Check your connection and try again.",
    );
    expect(NETWORK_FAILURE_MESSAGE).not.toMatch(/nothing was (changed|saved)/i);
  });

  it("keeps every other error as it was", () => {
    expect(getErrorMessage(new TypeError("x is not a function"))).toBe("x is not a function");
    // Only fetch's TypeError is a network failure; a server message with the same words is not.
    expect(getErrorMessage(new Error("Failed to fetch"))).toBe("Failed to fetch");
    expect(getErrorMessage("Could not save your message.")).toBe("Could not save your message.");
    expect(getErrorMessage(undefined, "Fallback")).toBe("Fallback");
  });
});

describe("signed-out errors (the workspace stops waiting for an answer)", () => {
  it("recognises the auth middleware's 401 text and 401/403 statuses", () => {
    expect(isAuthFailure(new Error("Unauthorized: No authorization header provided"))).toBe(true);
    expect(isAuthFailure(new Response("Unauthorized", { status: 401 }))).toBe(true);
    expect(isAuthFailure({ status: 403, message: "Forbidden" })).toBe(true);
  });

  it("does not treat other failures as signed out", () => {
    expect(isAuthFailure(new TypeError("Failed to fetch"))).toBe(false);
    expect(
      isAuthFailure(new Error("Could not load your chat history. Please try again in a moment.")),
    ).toBe(false);
    expect(isAuthFailure(new Response("Server error", { status: 500 }))).toBe(false);
  });
});
