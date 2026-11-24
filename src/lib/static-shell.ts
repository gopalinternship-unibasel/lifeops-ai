import { normalizeServerFnOrigin } from "@/lib/server-fn-origin";

/**
 * True in the GitHub Pages build, false on Vercel and locally.
 *
 * The Pages build is made with VITE_SERVER_FN_ORIGIN set (see src/start.ts). It serves one static
 * shell for every address, with an empty slot where the page goes, so routes are rendered in the
 * browser only (see src/router.tsx).
 */
export const isStaticShellBuild = Boolean(
  normalizeServerFnOrigin(import.meta.env.VITE_SERVER_FN_ORIGIN as string | undefined),
);
