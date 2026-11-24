import { describe, expect, it, vi } from "vitest";
import {
  createHandler,
  normalizeAppBase,
  parseAllowedOrigins,
  serverFnPath,
  type FetchApp,
} from "../supabase/functions/lifeops-api/handler.ts";

const PAGES = "https://gopalinternship-unibasel.github.io";
const FN = "https://tqgbgpchxbzzuofxjdaj.supabase.co/functions/v1/lifeops-api";
const ID = "a".repeat(64);

function setup(app?: Partial<FetchApp>) {
  const seen: Request[] = [];
  const fetchApp: FetchApp = {
    fetch:
      app?.fetch ??
      (async (req: Request) => {
        seen.push(req);
        return new Response('{"ok":true}', {
          status: 200,
          headers: { "content-type": "application/json", "x-tss-serialized": "true" },
        });
      }),
  };
  const log = vi.fn();
  const handler = createHandler({
    functionName: "lifeops-api",
    appBase: "/lifeops-ai",
    allowedOrigins: new Set([PAGES]),
    loadApp: async () => fetchApp,
    log,
  });
  return { handler, seen, log };
}

describe("serverFnPath", () => {
  it("strips the function prefix Supabase hands the function", () => {
    expect(serverFnPath(`/lifeops-api/lifeops-ai/_serverFn/${ID}`, "lifeops-api", "/lifeops-ai")).toBe(
      `/lifeops-ai/_serverFn/${ID}`,
    );
    expect(serverFnPath(`/functions/v1/lifeops-api/lifeops-ai/_serverFn/${ID}`, "lifeops-api", "/lifeops-ai")).toBe(
      `/lifeops-ai/_serverFn/${ID}`,
    );
  });
  it("rejects anything that is not a server-function call", () => {
    expect(serverFnPath("/lifeops-api/lifeops-ai/_serverFn/", "lifeops-api", "/lifeops-ai")).toBeNull();
    expect(serverFnPath("/lifeops-api/lifeops-ai/app", "lifeops-api", "/lifeops-ai")).toBeNull();
    expect(serverFnPath(`/lifeops-api/_serverFn/${ID}`, "lifeops-api", "/lifeops-ai")).toBeNull();
    expect(serverFnPath(`/other/lifeops-ai/_serverFn/${ID}`, "lifeops-api", "/lifeops-ai")).toBeNull();
  });
  it("works for an app built at the site root", () => {
    expect(serverFnPath(`/lifeops-api/_serverFn/${ID}`, "lifeops-api", "")).toBe(`/_serverFn/${ID}`);
  });
});

describe("settings", () => {
  it("normalizes the app base and the origin list", () => {
    expect(normalizeAppBase("lifeops-ai")).toBe("/lifeops-ai");
    expect(normalizeAppBase("/lifeops-ai/")).toBe("/lifeops-ai");
    expect(normalizeAppBase("")).toBe("");
    expect([...parseAllowedOrigins(` ${PAGES}/ , http://localhost:4173,`)]).toEqual([PAGES, "http://localhost:4173"]);
  });
});

describe("createHandler", () => {
  it("answers the preflight of the Pages origin with the headers TanStack needs", async () => {
    const { handler } = setup();
    const res = await handler(new Request(`${FN}/lifeops-ai/_serverFn/${ID}`, { method: "OPTIONS", headers: { origin: PAGES } }));
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(PAGES);
    expect(res.headers.get("access-control-allow-headers")).toContain("x-tsr-serverfn");
    expect(res.headers.get("access-control-allow-headers")).toContain("authorization");
    expect(res.headers.get("access-control-expose-headers")).toContain("x-tss-serialized");
    expect(res.headers.get("access-control-expose-headers")).toContain("x-tss-raw");
  });

  it("refuses other origins and calls without an Origin, before any server code runs", async () => {
    const { handler, seen } = setup();
    const url = `https://x.supabase.co/lifeops-api/lifeops-ai/_serverFn/${ID}`;
    expect((await handler(new Request(url, { method: "OPTIONS", headers: { origin: "https://evil.example" } }))).status).toBe(403);
    expect((await handler(new Request(url, { method: "POST", headers: { origin: "https://evil.example" } }))).status).toBe(403);
    expect((await handler(new Request(url, { method: "POST" }))).status).toBe(403);
    expect(seen).toHaveLength(0);
  });

  it("hands the call on as a same-origin request with the body, token and app path", async () => {
    const { handler, seen } = setup();
    const res = await handler(
      new Request(`https://x.supabase.co/lifeops-api/lifeops-ai/_serverFn/${ID}?payload=1`, {
        method: "POST",
        headers: {
          origin: PAGES,
          "sec-fetch-site": "cross-site",
          referer: `${PAGES}/lifeops-ai/app`,
          authorization: "Bearer token-1",
          "content-type": "application/json",
          "x-tsr-serverFn": "true",
        },
        body: '{"t":10}',
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(PAGES);
    expect(res.headers.get("x-tss-serialized")).toBe("true");
    expect(seen).toHaveLength(1);
    const inner = seen[0];
    const innerUrl = new URL(inner.url);
    expect(innerUrl.pathname).toBe(`/lifeops-ai/_serverFn/${ID}`);
    expect(innerUrl.search).toBe("?payload=1");
    expect(inner.headers.get("origin")).toBe(innerUrl.origin);
    expect(inner.headers.get("sec-fetch-site")).toBeNull();
    expect(inner.headers.get("referer")).toBeNull();
    expect(inner.headers.get("authorization")).toBe("Bearer token-1");
    expect(await inner.text()).toBe('{"t":10}');
  });

  it("passes GET calls without a body", async () => {
    const { handler, seen } = setup();
    const res = await handler(
      new Request(`https://x.supabase.co/lifeops-api/lifeops-ai/_serverFn/${ID}?payload=abc`, { method: "GET", headers: { origin: PAGES } }),
    );
    expect(res.status).toBe(200);
    expect(seen[0].method).toBe("GET");
    expect(seen[0].body).toBeNull();
  });

  it("gives 404 and 405 with CORS headers, so the browser can read them", async () => {
    const { handler } = setup();
    const notFound = await handler(new Request("https://x.supabase.co/lifeops-api/lifeops-ai/app", { method: "POST", headers: { origin: PAGES } }));
    expect(notFound.status).toBe(404);
    expect(notFound.headers.get("access-control-allow-origin")).toBe(PAGES);
    const put = await handler(new Request(`https://x.supabase.co/lifeops-api/lifeops-ai/_serverFn/${ID}`, { method: "PUT", headers: { origin: PAGES } }));
    expect(put.status).toBe(405);
    expect(put.headers.get("access-control-allow-origin")).toBe(PAGES);
  });

  it("returns a thrown Response as it is, and turns other failures into a 500 with CORS", async () => {
    const thrown = setup({
      fetch: () => {
        throw new Response("Unauthorized", { status: 401, headers: { "x-tss-raw": "true" } });
      },
    });
    const res401 = await thrown.handler(new Request(`https://x.supabase.co/lifeops-api/lifeops-ai/_serverFn/${ID}`, { method: "POST", headers: { origin: PAGES } }));
    expect(res401.status).toBe(401);
    expect(res401.headers.get("x-tss-raw")).toBe("true");
    expect(res401.headers.get("access-control-allow-origin")).toBe(PAGES);

    const broken = setup({
      fetch: () => {
        throw new Error("boom");
      },
    });
    const res500 = await broken.handler(new Request(`https://x.supabase.co/lifeops-api/lifeops-ai/_serverFn/${ID}`, { method: "POST", headers: { origin: PAGES } }));
    expect(res500.status).toBe(500);
    expect(res500.headers.get("access-control-allow-origin")).toBe(PAGES);
    expect(broken.log).toHaveBeenCalled();
  });
});
