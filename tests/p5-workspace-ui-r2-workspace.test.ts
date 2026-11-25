/**
 * Round-2 review points on the workspace page itself (src/routes/app.index.tsx), rendered on the
 * server (the unit tests run in Node with no DOM): the move cards retired after a change is
 * applied (finding 26) and the load-error notice after a refused sign-in (finding 92).
 */
import { readdirSync, readFileSync } from "node:fs";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { PendingEventChange } from "@/types/panel";

const hoisted = vi.hoisted(() => ({
  panelProps: { current: undefined as Record<string, unknown> | undefined },
}));

vi.mock("@/functions/google.functions", () => ({
  saveCalendarEvent: vi.fn(),
  saveGmailDraft: vi.fn(),
  updateCalendarEvent: vi.fn(),
  removeCalendarEvent: vi.fn(),
  getGoogleConnectionStatus: vi.fn(),
}));
vi.mock("@/functions/chat.functions", () => ({
  dismissChatCard: vi.fn(() => Promise.resolve({ ok: true })),
  ensureChatSession: vi.fn(),
  fetchSessionHistory: vi.fn(),
  processChat: vi.fn(),
  fetchCalendar: vi.fn(),
}));
vi.mock("@/lib/auth-context", () => ({
  useAuth: () => ({ user: { id: "user-1", is_anonymous: true } }),
}));
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: Record<string, unknown>) => ({ options }),
  useNavigate: () => () => undefined,
}));
// The page's context panel, replaced by one that keeps the props the page gives it.
vi.mock("@/components/workspace/ContextPanel", () => ({
  ContextPanel: (props: Record<string, unknown>) => {
    hoisted.panelProps.current = props;
    return null;
  },
}));
vi.mock("@/lib/panel-state", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/panel-state")>();
  return { ...actual, supersededChanges: vi.fn(actual.supersededChanges) };
});

const { dismissChatCard } = await import("@/functions/chat.functions");
const { supersededChanges } = await import("@/lib/panel-state");
const { Route } = await import("@/routes/app.index");
const Workspace = (Route as unknown as { options: { component: ComponentType } }).options.component;

describe("applying a move card (finding 26, client half)", () => {
  const original = { title: "Run", starts_at: "2026-11-25T18:00:00Z", ends_at: "2026-11-25T19:00:00Z" };
  const applied: PendingEventChange = {
    id: "a",
    kind: "update",
    event_id: "ev-1",
    original,
    next: { starts_at: "2026-11-26T09:00:00Z", ends_at: "2026-11-26T10:00:00Z" },
  };
  const sibling: PendingEventChange = { ...applied, id: "b", next: { starts_at: "2026-11-25T14:00:00Z" } };

  it("retires the other open cards for the same event and stores each as dismissed", () => {
    renderToStaticMarkup(createElement(Workspace));
    const onApplied = hoisted.panelProps.current?.onPendingChangeApplied as
      | ((id: string, change: PendingEventChange) => void)
      | undefined;
    expect(onApplied).toBeTypeOf("function");
    // The page's open cards are empty in a server render; the helper stands in for the list.
    vi.mocked(supersededChanges).mockReturnValueOnce([sibling]);

    onApplied?.("a", applied);

    expect(supersededChanges).toHaveBeenCalledWith(hoisted.panelProps.current?.pendingEventChanges, applied);
    // The applied card is stored as applied by the server; only the stale sibling is dismissed.
    expect(dismissChatCard).toHaveBeenCalledTimes(1);
    expect(dismissChatCard).toHaveBeenCalledWith({ data: { cardId: "b" } });
  });
});

describe("the workspace load error (finding 92, round-2 review)", () => {
  it("shows a visitor sentence for a refused sign-in, not the sign-in check's text", () => {
    const source = readFileSync(new URL("../src/routes/app.index.tsx", import.meta.url), "utf8");
    const catchBlock = source.match(/async function bootstrap\(\)[\s\S]*?\} catch \(err: unknown\) \{([\s\S]*?)\n {4}\}/)?.[1] ?? "";
    expect(catchBlock).toContain("setBootError(getVisitorErrorMessage(err");
    expect(catchBlock).not.toContain("setBootError(getErrorMessage(");
  });

  it("every other error text of the workspace gets the same sentence (second review)", () => {
    // The calendar error in the panel, the chat error, and the toasts for remembering a
    // dismissal and for saving or applying a card showed "Unauthorized: Invalid token".
    const files = [
      "../src/routes/app.index.tsx",
      ...readdirSync(new URL("../src/components/workspace/", import.meta.url))
        .filter((name) => name.endsWith(".tsx"))
        .map((name) => `../src/components/workspace/${name}`),
    ];
    const calls: Record<string, number> = {};
    for (const file of files) {
      const source = readFileSync(new URL(file, import.meta.url), "utf8");
      expect(source, file).not.toMatch(/\bgetErrorMessage\(/);
      expect(source, file).not.toMatch(/sign-in has expired/);
      calls[file] = source.match(/\bgetVisitorErrorMessage\(/g)?.length ?? 0;
    }
    expect(calls["../src/routes/app.index.tsx"]).toBe(4);
    expect(calls["../src/components/workspace/ContextPanel.tsx"]).toBe(3);
  });
});
