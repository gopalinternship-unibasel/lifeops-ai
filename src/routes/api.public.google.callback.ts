import { createFileRoute } from "@tanstack/react-router";
import { handleGoogleOAuthCallback } from "@/server/google/callback.server";

export const Route = createFileRoute("/api/public/google/callback")({
  server: {
    handlers: {
      GET: async ({ request }) => handleGoogleOAuthCallback(request),
    },
  },
});
