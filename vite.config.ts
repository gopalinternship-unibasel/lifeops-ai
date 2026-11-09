// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - tanstackStart, viteReact, tailwindcss, tsConfigPaths, cloudflare (build-only),
//     componentTagger (dev-only), VITE_* env injection, @ path alias, React/TanStack dedupe,
//     error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... } }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";
import type { Plugin } from "vite";

// Local development runs on http://localhost:5190 (see RUNNING.md). Outside a Lovable
// sandbox the wrapper merges these server options over its own default (port 8080 on "::").
// Inside a Lovable sandbox the wrapper still forces its own port 8080.
const port = Number(process.env.PORT ?? 5190);

/**
 * In `vite dev` the server functions run in this Node process, and Node's built-in fetch
 * (undici) aborts any request whose response headers take longer than 300 s, whatever
 * AbortSignal.timeout says. A local CPU model often needs longer for one non-streamed answer
 * (and the FastAPI planner waits for the same model), so the app's LLM_TIMEOUT_MS never
 * applied. Lift undici's header/body limits for the dev server; every long call in the app
 * still has its own AbortSignal timeout. Deployed builds (Cloudflare) are not affected.
 */
function longLlmRequests(): Plugin {
  return {
    name: "lifeops:long-llm-requests",
    apply: "serve",
    async configureServer() {
      const { Agent, setGlobalDispatcher } = await import("undici");
      setGlobalDispatcher(new Agent({ headersTimeout: 0, bodyTimeout: 0 }));
    },
  };
}

export default defineConfig({
  vite: {
    plugins: [longLlmRequests()],
    // With an empty dependency cache (a fresh install) Vite found these TanStack Start internals
    // only when the first page loaded, bundled them and then reloaded every open page
    // ("optimized dependencies changed. reloading"), which cut off the first-visit briefing in
    // the browser. They are imported by @tanstack/react-start and @tanstack/react-router, which
    // TanStack Start keeps out of pre-bundling, so the start-up scan cannot see them. Bundle
    // them at start-up instead.
    optimizeDeps: {
      include: [
        "@tanstack/router-core",
        "@tanstack/router-core/isServer",
        "@tanstack/router-core/ssr/client",
        "@tanstack/router-core/ssr/server",
        "@tanstack/history",
        "seroval",
        "h3-v2",
      ],
    },
    server: {
      host: "localhost",
      port,
      strictPort: true,
    },
    preview: {
      host: "localhost",
      port,
      strictPort: true,
    },
  },
});
