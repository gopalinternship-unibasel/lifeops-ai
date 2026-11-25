/**
 * The dashboard's planner client (src/server/lifeops-backend.server.ts), round 2 of the audit of
 * 24 Nov 2026:
 *  - 65: a planner refusal's "detail" reached visitors after only a length and bracket filter; one
 *    with an address or a setting name was shown as it came;
 *  - 50: planner_requests.error holds at most 2000 characters, and a longer error text made the
 *    database refuse the update that closes the request.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  backend,
  BackendUnavailableError,
  REQUEST_ERROR_MAX,
  storableRequestError,
} from "@/server/lifeops-backend.server";

function answer(status: number, body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        }),
    ),
  );
}

async function failure(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error: unknown) {
    return error as Error;
  }
  throw new Error("expected the request to fail");
}

beforeEach(() => {
  vi.stubEnv("LIFEOPS_BACKEND_URL", "https://planner.test");
  vi.stubEnv("LIFEOPS_BACKEND_TOKEN", "");
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("a planner refusal's detail on the hosted sites (65)", () => {
  const internal = [
    "Set PLANNER_DATABASE_URL before approving actions",
    "Could not reach http://10.0.0.5:5432 for this action",
    "Action 7 failed: KeyError 'start_time'",
  ];

  it("is replaced by the plain sentence when it carries an address, a setting name or parser text", async () => {
    vi.stubEnv("LIFEOPS_HOSTED", "1");
    for (const detail of internal) {
      answer(400, { detail });
      const error = await failure(backend.approve("u1", 7));
      // Still the service's own refusal (no in-app fallback), only without the detail.
      expect(error).not.toBeInstanceOf(BackendUnavailableError);
      expect(error.message).toBe("The planner service could not accept this request.");
    }
    // The detail is in the server log.
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("PLANNER_DATABASE_URL"));
  });

  it("keeps a readable sentence, and a 404 with an internal detail still counts as the app's own", async () => {
    vi.stubEnv("LIFEOPS_HOSTED", "1");
    answer(400, { detail: "Action is already executed" });
    expect((await failure(backend.approve("u1", 7))).message).toBe(
      "The planner service could not do this: Action is already executed.",
    );
    answer(404, { detail: "Action 7 not found in PLANNER_SCHEMA" });
    const notFound = await failure(backend.action("u1", 7));
    expect(notFound).not.toBeInstanceOf(BackendUnavailableError);
    expect(notFound.message).toBe("The planner service could not accept this request.");
  });

  it("is kept on a local run, for the developer", async () => {
    vi.stubEnv("LIFEOPS_HOSTED", "");
    answer(400, { detail: internal[0] });
    expect((await failure(backend.approve("u1", 7))).message).toBe(
      `The planner service could not do this: ${internal[0]}.`,
    );
  });
});

describe("the stored error of a 'Plan it' request (50)", () => {
  it("is cut to the column's 2000 characters, by character", () => {
    expect(REQUEST_ERROR_MAX).toBe(2000);
    const long = `Calendar insert failed: 403 ${"x".repeat(5000)}`;
    expect(storableRequestError(long)).toHaveLength(2000);
    expect(storableRequestError(long)).toBe(long.slice(0, 2000));
    expect(storableRequestError("Planning failed. Please try again.")).toBe(
      "Planning failed. Please try again.",
    );
    // A character outside the BMP is two UTF-16 units but one character for the database.
    const emoji = "😀".repeat(2500);
    const cut = storableRequestError(emoji);
    expect(Array.from(cut)).toHaveLength(2000);
    expect(cut).toBe("😀".repeat(2000));
  });
});
