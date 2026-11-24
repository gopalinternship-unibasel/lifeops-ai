import { describe, expect, it, vi } from "vitest";
import { isHostedDeployment } from "@/server/deployment.server";
import { dbError, describeCause, publicError } from "@/server/public-error.server";

describe("isHostedDeployment", () => {
  it("is true for the hosted builds (VITE_HOSTED_DEMO=true)", () => {
    expect(isHostedDeployment("true", {})).toBe(true);
  });
  it("is true when LIFEOPS_HOSTED=1 is set at run time", () => {
    expect(isHostedDeployment(undefined, { LIFEOPS_HOSTED: "1" })).toBe(true);
  });
  it("is false for a local run", () => {
    expect(isHostedDeployment(undefined, {})).toBe(false);
    expect(isHostedDeployment("false", { LIFEOPS_HOSTED: "0" })).toBe(false);
  });
});

describe("publicError and dbError", () => {
  it("returns only the user message and logs the cause", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const err = dbError("save your message", {
      code: "23505",
      message: "duplicate key value violates unique constraint",
      details: "Key (id)=(1) already exists.",
      hint: null,
    });
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe("Could not save your message. Please try again in a moment.");
    expect(err.message).not.toMatch(/23505|duplicate|Key \(id\)/);
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0][1])).toContain("code=23505");
  });

  it("does not log when there is no cause", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(publicError("The AI assistant is not available right now.").message).toBe(
      "The AI assistant is not available right now.",
    );
    expect(log).not.toHaveBeenCalled();
  });

  it("describes errors, objects and strings in one line", () => {
    expect(describeCause(new TypeError("fetch failed"))).toBe("TypeError: fetch failed");
    expect(describeCause("boom")).toBe("boom");
    expect(describeCause({ status: 500 })).toBe('{"status":500}');
  });
});
