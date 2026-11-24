import { describe, expect, it } from "vitest";
import { normalizeServerFnOrigin, toServerFnUrl } from "@/lib/server-fn-origin";

const FN = "https://tqgbgpchxbzzuofxjdaj.supabase.co/functions/v1/lifeops-api";

describe("normalizeServerFnOrigin", () => {
  it("is empty when the setting is missing (Vercel and local builds)", () => {
    expect(normalizeServerFnOrigin(undefined)).toBeUndefined();
    expect(normalizeServerFnOrigin("  ")).toBeUndefined();
  });
  it("drops trailing slashes", () => {
    expect(normalizeServerFnOrigin(`${FN}/`)).toBe(FN);
  });
  it("refuses a value that is not an http(s) URL", () => {
    expect(() => normalizeServerFnOrigin("tqgbgpchxbzzuofxjdaj.supabase.co")).toThrow(/must start with/);
  });
});

describe("toServerFnUrl", () => {
  it("leaves URLs alone without an origin", () => {
    expect(toServerFnUrl("/_serverFn/abc", undefined)).toBe("/_serverFn/abc");
  });
  it("prefixes TanStack's relative server-function URL, query included", () => {
    expect(toServerFnUrl("/lifeops-ai/_serverFn/abc?payload=x", FN)).toBe(`${FN}/lifeops-ai/_serverFn/abc?payload=x`);
  });
  it("keeps the /_serverFn marker the bearer-token patch in auth-context.tsx looks for", () => {
    expect(String(toServerFnUrl("/lifeops-ai/_serverFn/abc", FN))).toContain("/_serverFn");
  });
  it("leaves absolute and protocol-relative URLs and Request objects alone", () => {
    expect(toServerFnUrl("https://example.com/x", FN)).toBe("https://example.com/x");
    expect(toServerFnUrl("//example.com/x", FN)).toBe("//example.com/x");
    const req = new Request("https://example.com/y");
    expect(toServerFnUrl(req, FN)).toBe(req);
  });
});
