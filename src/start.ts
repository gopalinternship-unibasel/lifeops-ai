import { createCsrfMiddleware, createMiddleware, createStart } from "@tanstack/react-start";
import { normalizeServerFnOrigin, toServerFnUrl } from "@/lib/server-fn-origin";
import { guardServerFnResponse, serverFnStatusHandler } from "@/lib/server-fn-errors";

/**
 * Start options, used by every build (Vercel, local, GitHub Pages).
 *
 * CSRF: this is the check TanStack Start applies by itself when an app has no src/start.ts
 * (server-function calls must come from the same origin). Defining a start instance replaces that
 * default, so it is listed here explicitly and behaves exactly as before.
 *
 * Error statuses (src/lib/server-fn-errors.ts): after the CSRF check, a call to a server function
 * this build does not have (an out-of-date page) gets 404 and an unreadable payload 400, each with
 * a sentence the page can show, instead of TanStack's 500. Real results and the functions' own
 * errors pass unchanged.
 *
 * Server-function fetch: every build checks the answers in the browser, because TanStack's client
 * takes an error in JSON without its own header (a gateway's 546 or 504) for a result.
 *
 * GitHub Pages: that build is made with VITE_SERVER_FN_ORIGIN set, and server-function calls go
 * to the Supabase Edge Function "lifeops-api", which runs the same server code. The function
 * accepts only the Pages origin and hands the call on as a same-origin request, so the CSRF check
 * above still applies there. The global fetch is looked up at call time, so the bearer-token patch
 * in src/lib/auth-context.tsx still adds the signed-in user's token.
 */
const serverFnOrigin = normalizeServerFnOrigin(import.meta.env.VITE_SERVER_FN_ORIGIN as string | undefined);

const serverFnStatusMiddleware = createMiddleware().server((ctx) => serverFnStatusHandler(ctx));

export const startInstance = createStart(() => ({
  requestMiddleware: [
    createCsrfMiddleware({ filter: (ctx) => ctx.handlerType === "serverFn" }),
    serverFnStatusMiddleware,
  ],
  serverFns: {
    fetch: (input: RequestInfo | URL, init?: RequestInit) =>
      fetch(toServerFnUrl(input, serverFnOrigin), init).then(guardServerFnResponse),
  },
}));
