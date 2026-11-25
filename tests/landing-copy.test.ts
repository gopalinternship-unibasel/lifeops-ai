// The landing page's claims must match what the hosted sites do: they have no Google sign-in, so
// every visitor works with the sample inbox and the app's own demo calendar (gmail.mock.ts,
// calendar.mock.ts). Source-text checks: vitest runs without a DOM here.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const landing = readFileSync(new URL("../src/routes/index.tsx", import.meta.url), "utf8");
const login = readFileSync(new URL("../src/routes/login.tsx", import.meta.url), "utf8");

describe("the landing page copy", () => {
  it("tells hosted visitors that the inbox and calendar are a sample", () => {
    expect(landing).toContain('const HOSTED_DEMO = import.meta.env.VITE_HOSTED_DEMO === "true";');
    expect(landing).toContain("Public demo with a sample inbox and calendar");
    expect(landing).toContain("so nothing connects to your real email or calendar");
    expect(landing).toContain("Reads the sample inbox, the demo calendar and the goals in your profile.");
  });

  it("makes no claim the app does not keep", () => {
    expect(landing).not.toContain("private preview");
    expect(landing).not.toMatch(/instantly/i);
    // Calendar writes always wait for the visitor's approval.
    expect(landing).toContain("puts it on the calendar once you approve");
    expect(login).toContain("writes the plan back to your calendar once you approve it");
  });
});
