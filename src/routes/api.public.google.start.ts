import { createFileRoute } from "@tanstack/react-router";

// OAuth must be initiated through the authenticated getGoogleOAuthUrl server function.
// Keeping this route as an explicit 410 prevents older, insecure links from working.
export const Route = createFileRoute("/api/public/google/start")({
  server: {
    handlers: {
      GET: async () => new Response("This OAuth start endpoint has been retired.", { status: 410 }),
    },
  },
});
