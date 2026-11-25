import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { runWithStartContext } from "@tanstack/start-storage-context";
import { fromJSON, toCrossJSONAsync } from "seroval";
import {
  SERVER_FN_MESSAGES,
  guardServerFnResponse,
  serverFnStatusHandler,
  unknownServerFnResponse,
  unreadablePayloadAnswer,
  unreadablePayloadResponse,
} from "@/lib/server-fn-errors";

const URL_PATH = `/lifeops-ai/_serverFn/${"0".repeat(64)}`;

function json(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

type Fetcher = (url: string, args: unknown[], handler: unknown) => Promise<unknown>;

// TanStack's client fetcher, as the browser runs it. The package does not export it, so it is
// loaded from the installed files (the version the app is built with).
const clientCoreDir = dirname(createRequire(import.meta.url).resolve("@tanstack/start-client-core/package.json"));
const { serverFnFetcher } = (await import(
  pathToFileURL(join(clientCoreDir, "dist", "esm", "client-rpc", "serverFnFetcher.js")).href
)) as { serverFnFetcher: Fetcher };

/** Runs TanStack's real client fetcher against one canned answer, with or without the guard. */
function callWith(answer: () => Response, guarded = true): Promise<unknown> {
  const handler = async () => (guarded ? guardServerFnResponse(answer()) : answer());
  return runWithStartContext({ startOptions: {} } as never, () =>
    serverFnFetcher(URL_PATH, [{ method: "POST", data: { input: "dentist thursday" } }], handler as never),
  );
}

const UNKNOWN_FN_500 = () => json({ status: 500, unhandled: true, message: "HTTPError" }, 500);

describe("guardServerFnResponse with TanStack's client fetcher", () => {
  it("without the guard, TanStack resolves an error in JSON as the result (the defect)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(callWith(UNKNOWN_FN_500, false)).resolves.toEqual({
      status: 500,
      unhandled: true,
      message: "HTTPError",
    });
  });

  it("turns h3's unhandled 500 into the 'failed' sentence, not the reload one", async () => {
    // Both editions run serverFnStatusHandler, which answers an unknown function id with a 404,
    // so an unhandled 500 from the server is a real failure (for example in a request
    // middleware): telling the visitor that the app was updated would be wrong.
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(callWith(UNKNOWN_FN_500)).rejects.toThrow(SERVER_FN_MESSAGES.failed);
    await expect(callWith(UNKNOWN_FN_500)).rejects.not.toThrow(SERVER_FN_MESSAGES.outdated);
  });

  it("shows the reload sentence for the server's 404 to an unknown server function", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const notInThisBuild = () => unknownServerFnResponse(new Error(`Server function info not found for ${"0".repeat(64)}`))!;
    await expect(callWith(notInThisBuild)).rejects.toThrow(SERVER_FN_MESSAGES.outdated);
  });

  it("turns the Supabase gateway's 546 and 504 into the timeout sentence", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(
      callWith(() => json({ code: "WORKER_LIMIT", message: "Function failed due to not having enough compute resources" }, 546)),
    ).rejects.toThrow(SERVER_FN_MESSAGES.slow);
    await expect(callWith(() => json({ message: "Gateway Timeout" }, 504))).rejects.toThrow(SERVER_FN_MESSAGES.slow);
  });

  it("turns a platform's plain-text or HTML gateway page into a sentence", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const vercelTimeout = () =>
      new Response("An error occurred with your deployment\n\nFUNCTION_INVOCATION_TIMEOUT\n\nfra1::abc", {
        status: 504,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    await expect(callWith(vercelTimeout)).rejects.toThrow(SERVER_FN_MESSAGES.slow);
    const htmlPage = () =>
      new Response("<html><body>502 Bad Gateway</body></html>", { status: 502, headers: { "content-type": "text/html" } });
    await expect(callWith(htmlPage)).rejects.toThrow(SERVER_FN_MESSAGES.unavailable);
    const gatewayNotFound = () => json({ code: "NOT_FOUND", message: "Requested function was not found" }, 404);
    await expect(callWith(gatewayNotFound)).rejects.toThrow(SERVER_FN_MESSAGES.unavailable);
    const noType = () => {
      const res = new Response(null, { status: 500 });
      res.headers.delete("content-type");
      return res;
    };
    await expect(callWith(noType)).rejects.toThrow(SERVER_FN_MESSAGES.failed);
  });

  it("keeps the app's own plain-text errors, which the pages show or recognise", async () => {
    const unauthorized = () =>
      new Response("Unauthorized: Invalid token", { status: 401, headers: { "content-type": "text/plain" } });
    await expect(callWith(unauthorized)).rejects.toThrow("Unauthorized: Invalid token");
    const session = () => new Response("Chat session not found", { status: 404 });
    await expect(callWith(session)).rejects.toThrow("Chat session not found");
    // The sign-in check's developer message on a local run without Supabase settings: capitals
    // and underscores alone do not make a body the platform's.
    const missing =
      "Missing Supabase environment variable(s): SUPABASE_URL. Configure them in .env.local or Vercel Project Settings.";
    await expect(callWith(() => new Response(missing, { status: 500 }))).rejects.toThrow(missing);
  });

  // Vercel's own plain-text error answers. The 414 body and headers were read from the live
  // site on 24 Nov 2026 (an address of 70,000 characters); the 500 is assumed to have the same
  // layout (not seen live).
  const vercelText = (status: number, code: string, withHeader = true) => () =>
    new Response(`An error occurred\n\n${code}\n\nfra1::bfdqb-1795559271982-f774878aeac9\n`, {
      status,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        ...(withHeader ? { "x-vercel-error": code } : {}),
      },
    });

  it("turns Vercel's plain-text 500 for a crashed function into a sentence", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(callWith(vercelText(500, "FUNCTION_INVOCATION_FAILED"))).rejects.toThrow(SERVER_FN_MESSAGES.failed);
    // Also when a proxy dropped the header: the request id at the end of the text gives it away.
    await expect(callWith(vercelText(500, "FUNCTION_INVOCATION_FAILED", false))).rejects.toThrow(
      SERVER_FN_MESSAGES.failed,
    );
  });

  it("turns a request the platform found too large into the 'too large' sentence", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    // toThrow(undefined) would accept any error, so pin the sentence first.
    expect(SERVER_FN_MESSAGES.tooLarge).toBe(
      "This request is too large for the server. Please shorten what you entered and try again.",
    );
    await expect(callWith(vercelText(414, "URI_TOO_LONG"))).rejects.toThrow(SERVER_FN_MESSAGES.tooLarge);
    await expect(callWith(vercelText(413, "FUNCTION_PAYLOAD_TOO_LARGE"))).rejects.toThrow(SERVER_FN_MESSAGES.tooLarge);
    // A gateway's 413 without any Vercel marker, in plain text or HTML.
    await expect(
      callWith(() => new Response("Request Entity Too Large", { status: 413, headers: { "content-type": "text/plain" } })),
    ).rejects.toThrow(SERVER_FN_MESSAGES.tooLarge);
    await expect(
      callWith(
        () =>
          new Response("<html><body>413 Request Entity Too Large</body></html>", {
            status: 413,
            headers: { "content-type": "text/html" },
          }),
      ),
    ).rejects.toThrow(SERVER_FN_MESSAGES.tooLarge);
  });

  it("passes TanStack's own answers through: serialized results and errors, notFound()", async () => {
    const value = { request: { id: "r1", status: "done" } };
    const serialized = JSON.stringify(await toCrossJSONAsync(value, { refs: new Map() }));
    const ok = new Response(serialized, {
      status: 200,
      headers: { "content-type": "application/json", "x-tss-serialized": "true" },
    });
    expect(await guardServerFnResponse(ok)).toBe(ok);
    await expect(
      callWith(
        () =>
          new Response(serialized, {
            status: 200,
            headers: { "content-type": "application/json", "x-tss-serialized": "true" },
          }),
      ),
    ).resolves.toEqual(value);

    const serializedError = new Response('{"t":0}', {
      status: 500,
      headers: { "content-type": "application/json", "x-tss-serialized": "true" },
    });
    expect(await guardServerFnResponse(serializedError)).toBe(serializedError);

    const notFound = json({ isNotFound: true, routeId: "x" }, 404);
    expect(await guardServerFnResponse(notFound)).toBe(notFound);
    const raw = new Response("raw", { status: 418, headers: { "x-tss-raw": "true" } });
    expect(await guardServerFnResponse(raw)).toBe(raw);
  });

  it("keeps the status and logs what the server sent", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = await guardServerFnResponse(json({ code: "WORKER_LIMIT" }, 546));
    expect(out.status).toBe(546);
    expect(out.headers.get("content-type")).toContain("text/plain");
    expect(await out.text()).toBe(SERVER_FN_MESSAGES.slow);
    expect(warn.mock.calls[0][0]).toContain("546");
    expect(warn.mock.calls[0][0]).toContain("WORKER_LIMIT");
  });
});

describe("the server-side status middleware", () => {
  it("answers 404 with the reload sentence for an unknown server-function id", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = unknownServerFnResponse(new Error(`Server function info not found for ${"0".repeat(64)}`));
    expect(res?.status).toBe(404);
    expect(await res?.text()).toBe(SERVER_FN_MESSAGES.outdated);
    expect(unknownServerFnResponse(new Error("Could not save your message."))).toBeNull();
    expect(unknownServerFnResponse("Server function info not found for x")).toBeNull();
  });

  it("turns the unknown-id error thrown by the next step into that 404, and nothing else", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const request = new Request(`https://x.test${URL_PATH}`, { method: "POST" });
    const unknown = await serverFnStatusHandler({
      request,
      handlerType: "serverFn",
      next: () => {
        throw new Error("Server function info not found for abc");
      },
    });
    expect(unknown).toBeInstanceOf(Response);
    expect((unknown as Response).status).toBe(404);

    const boom = new Error("database down");
    await expect(
      serverFnStatusHandler({
        request,
        handlerType: "serverFn",
        next: () => Promise.reject(boom),
      }),
    ).rejects.toBe(boom);
  });

  it("leaves page requests and real answers unchanged", async () => {
    const result = { response: new Response("<html></html>", { status: 200 }) };
    expect(
      await serverFnStatusHandler({ request: new Request("https://x.test/app"), handlerType: "router", next: () => result }),
    ).toBe(result);
    const failed = {
      response: new Response('{"message":"The AI assistant is not available right now."}', {
        status: 500,
        headers: { "content-type": "application/json", "x-tss-serialized": "true" },
      }),
    };
    const request = new Request(`https://x.test${URL_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"t":0}',
    });
    expect(await serverFnStatusHandler({ request, handlerType: "serverFn", next: () => failed })).toBe(failed);
  });

  it("answers 400 for a payload that is not JSON, and leaves the body readable otherwise", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const bad = new Request(`https://x.test${URL_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    const res = await unreadablePayloadResponse(bad);
    expect(res?.status).toBe(400);
    expect(await res?.text()).toBe(SERVER_FN_MESSAGES.unreadable);

    const good = new Request(`https://x.test${URL_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"t":10}',
    });
    expect(await unreadablePayloadResponse(good)).toBeNull();
    expect(await good.text()).toBe('{"t":10}');

    const badGet = new Request(`https://x.test${URL_PATH}?payload=${encodeURIComponent("{oops")}`);
    expect((await unreadablePayloadResponse(badGet))?.status).toBe(400);
    expect(await unreadablePayloadResponse(new Request(`https://x.test${URL_PATH}`))).toBeNull();
    // No input: the browser sends no body and no content type.
    expect(await unreadablePayloadResponse(new Request(`https://x.test${URL_PATH}`, { method: "POST" }))).toBeNull();
  });

  it("answers 400 when TanStack could not read a JSON payload (seroval's step 3)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let thrown: unknown;
    try {
      fromJSON({} as never);
    } catch (error) {
      thrown = error;
    }
    const body = JSON.stringify(await toCrossJSONAsync(thrown, { refs: new Map() }));
    const serialized = new Response(body, {
      status: 500,
      headers: { "content-type": "application/json", "x-tss-serialized": "true" },
    });
    const res = await unreadablePayloadAnswer(serialized);
    expect(res?.status).toBe(400);
    expect(await res?.text()).toBe(SERVER_FN_MESSAGES.unreadable);
    // The original answer was read from a copy and is still whole.
    expect(await serialized.text()).toBe(body);

    const ownError = new Response('{"s":"AI unavailable"}', {
      status: 500,
      headers: { "content-type": "application/json", "x-tss-serialized": "true" },
    });
    expect(await unreadablePayloadAnswer(ownError)).toBeNull();
  });
});

describe("src/start.ts", () => {
  it("installs the CSRF check, the status middleware and the guarded fetch in every build", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchMock = vi.fn(async () => json({ code: "WORKER_LIMIT" }, 546));
    vi.stubGlobal("fetch", fetchMock);
    const { startInstance } = await import("@/start");
    const options = (await startInstance.getOptions()) as {
      requestMiddleware?: unknown[];
      serverFns?: { fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> };
    };
    expect(options.requestMiddleware).toHaveLength(2);
    const res = await options.serverFns!.fetch!(URL_PATH, { method: "POST" });
    // No VITE_SERVER_FN_ORIGIN in the tests (the Vercel and local builds): the URL is unchanged.
    expect(fetchMock).toHaveBeenCalledWith(URL_PATH, { method: "POST" });
    expect(res.status).toBe(546);
    expect(await res.text()).toBe(SERVER_FN_MESSAGES.slow);
  });
});
