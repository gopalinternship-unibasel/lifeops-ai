import { afterEach, describe, expect, it, vi } from "vitest";

// isStaticShellBuild is read once when the module loads, so each case loads it afresh.
async function loadFlag() {
  vi.resetModules();
  return (await import("@/lib/static-shell")).isStaticShellBuild;
}

describe("isStaticShellBuild", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is false when VITE_SERVER_FN_ORIGIN is not set (Vercel and local builds)", async () => {
    vi.stubEnv("VITE_SERVER_FN_ORIGIN", "");
    expect(await loadFlag()).toBe(false);
  });

  it("is true in the GitHub Pages build, which sets VITE_SERVER_FN_ORIGIN", async () => {
    vi.stubEnv(
      "VITE_SERVER_FN_ORIGIN",
      "https://tqgbgpchxbzzuofxjdaj.supabase.co/functions/v1/lifeops-api",
    );
    expect(await loadFlag()).toBe(true);
  });
});
