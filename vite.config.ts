// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - tanstackStart, viteReact, tailwindcss, tsConfigPaths, cloudflare (build-only),
//     componentTagger (dev-only), VITE_* env injection, @ path alias, React/TanStack dedupe,
//     error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... } }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";

// Local development runs on http://localhost:5190 (see RUNNING.md). Outside a Lovable
// sandbox the wrapper merges these server options over its own default (port 8080 on "::").
// Inside a Lovable sandbox the wrapper still forces its own port 8080.
const port = Number(process.env.PORT ?? 5190);

export default defineConfig({
  vite: {
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
