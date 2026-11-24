/**
 * Markup of the workspace components, rendered on the server (the unit tests run in Node with
 * no DOM). Interactions (typing, clicking) are not covered here.
 */
import { readFileSync } from "node:fs";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/functions/google.functions", () => ({
  saveCalendarEvent: vi.fn(),
  saveGmailDraft: vi.fn(),
  updateCalendarEvent: vi.fn(),
  removeCalendarEvent: vi.fn(),
  getGoogleConnectionStatus: vi.fn(),
}));
vi.mock("@/functions/chat.functions", () => ({
  dismissChatCard: vi.fn(),
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

const { ChatThread } = await import("@/components/workspace/ChatThread");
const { ChatComposer } = await import("@/components/workspace/ChatComposer");
const { ContextPanel } = await import("@/components/workspace/ContextPanel");

const noop = () => undefined;
const panelProps = {
  priorities: [],
  schedule: [],
  pendingEvents: [],
  pendingEventChanges: [],
  insights: [],
  calendarStatus: { label: "Demo data", tone: "amber" as const },
  activeTab: "schedule" as const,
  onTabChange: noop,
  onPendingSaved: noop,
  onPendingDismiss: noop,
  onPendingChangeApplied: noop,
  onPendingChangeDismiss: noop,
  onDraftSaved: noop,
};
const html = (component: ComponentType<never>, props: Record<string, unknown>) =>
  renderToStaticMarkup(createElement(component as ComponentType<Record<string, unknown>>, props));
const textareaTag = (markup: string) => markup.match(/<textarea[^>]*>/)?.[0] ?? "";

describe("chat thread", () => {
  const briefing = "**📬 Inbox (2 unread)**\n\n• **A** — *x*\n• **B** — *y*";

  it("renders '•' lines of a reply as a list, like '- ' lines", () => {
    const markup = html(ChatThread, {
      messages: [{ id: "1", role: "assistant", content: briefing }],
      pending: false,
    });
    expect(markup.match(/<li>/g)).toHaveLength(2);
    expect(markup).toContain("<ul>");
    expect(markup).not.toMatch(/<p>[^<]*•/);
    const dashes = html(ChatThread, {
      messages: [{ id: "1", role: "assistant", content: briefing.replace(/•/g, "-") }],
      pending: false,
    });
    expect(dashes).toBe(markup);
  });

  it("styles replies with the app's own chat-md rules (no typography plugin classes)", () => {
    const markup = html(ChatThread, {
      messages: [{ id: "1", role: "assistant", content: "1. First\n2. Second" }],
      pending: false,
    });
    expect(markup).toContain('class="chat-md"');
    expect(markup).not.toMatch(/\bprose\b/);
    expect(markup).toContain("<ol>");
  });

  it("announces new messages and 'Thinking…' to screen readers and names the speaker", () => {
    const markup = html(ChatThread, {
      messages: [{ id: "1", role: "assistant", content: "Hi" }],
      pending: true,
    });
    expect(markup).toMatch(
      /<div role="log" aria-live="polite" aria-relevant="additions" aria-label="Conversation with MONDAY"/,
    );
    expect(markup).toMatch(
      /<div role="status"><div[^>]*data-testid="chat-pending"[\s\S]*Thinking…/,
    );
    expect(markup).toContain('<span class="sr-only">MONDAY said:</span>');
    expect(markup).toMatch(/<div aria-hidden="true"[^>]*>M<\/div>/);
  });

  it("keeps both live regions on the page before anything arrives", () => {
    const markup = html(ChatThread, { messages: [], pending: false });
    expect(markup).toContain('role="log"');
    expect(markup).toContain('<div role="status"></div>');
    expect(markup).toContain("initializing your workspace");
  });

  it("shows the empty state it is given (for example a load error) instead of 'initializing'", () => {
    const markup = html(ChatThread, {
      messages: [],
      pending: false,
      emptyState: createElement("p", { role: "alert" }, "Could not load your workspace."),
    });
    expect(markup).toContain("Could not load your workspace.");
    expect(markup).not.toContain("initializing");
  });
});

describe("chat composer", () => {
  it("has an accessible name and no description pointing at a missing element", () => {
    const tag = textareaTag(
      html(ChatComposer, { onSend: noop, busy: false, showSuggestions: false }),
    );
    expect(tag).toContain('aria-label="Message MONDAY"');
    expect(tag).not.toContain("aria-describedby");
  });

  it("stays focusable while busy (read-only, not disabled), so focus is not lost on each send", () => {
    const tag = textareaTag(
      html(ChatComposer, { onSend: noop, busy: true, showSuggestions: false }),
    );
    expect(tag).toContain('readOnly=""');
    expect(tag).not.toContain("disabled");
  });
});

describe("context panel", () => {
  it("shows a calendar load failure instead of 'No events today.'", () => {
    const markup = html(ContextPanel, {
      ...panelProps,
      scheduleError: "Could not load today's calendar.",
      calendarStatus: { label: "Calendar unavailable", tone: "red" },
    });
    expect(markup).toMatch(/<div role="alert"[^>]*>Could not load today&#x27;s calendar\.<\/div>/);
    expect(markup).not.toContain("No events today.");
    expect(markup).toContain("Calendar unavailable");
    expect(markup).not.toContain("Synced");
  });

  it("shows the badge it is given, without the always-on green pulse", () => {
    const markup = html(ContextPanel, panelProps);
    expect(markup).toMatch(
      /data-testid="calendar-status"><span aria-hidden="true" class="[^"]*bg-amber-500"><\/span> Demo data/,
    );
    expect(markup).not.toContain("animate-pulse");
    expect(markup).toContain("No events today.");
  });

  it("exposes the tabs as a tab list with the selected tab and its panel", () => {
    const markup = html(ContextPanel, panelProps);
    expect(markup).toContain('role="tablist" aria-label="Context panel"');
    expect(markup).toMatch(
      /role="tab" id="ctx-tab-schedule" aria-selected="true" aria-controls="ctx-panel" tabindex="0"/,
    );
    expect(markup).toMatch(
      /role="tab" id="ctx-tab-priorities" aria-selected="false" aria-controls="ctx-panel" tabindex="-1"/,
    );
    expect(markup).toContain('role="tabpanel" id="ctx-panel" aria-labelledby="ctx-tab-schedule"');
  });

  it("gives an alternatives card a neutral icon (not the meal chef hat)", () => {
    const markup = html(ContextPanel, {
      ...panelProps,
      activeTab: "insights",
      alternatives: { title: "Printer alternatives", bullets: ["Print at the library"] },
    });
    expect(markup).toContain("lucide-lightbulb");
    expect(markup).not.toContain("lucide-chef-hat");
  });

  it("renders two priorities with the same title as two rows", () => {
    const markup = html(ContextPanel, {
      ...panelProps,
      activeTab: "priorities",
      priorities: [
        { rank: 1, title: "Focus block", reason: "Morning" },
        { rank: 2, title: "Focus block", reason: "Afternoon" },
      ],
    });
    expect(markup.match(/<li /g)).toHaveLength(2);
  });
});

describe("workspace page", () => {
  it("lays out phones as a page that scrolls (chat one screen high, panel below), desktop as two columns", async () => {
    const { Route } = await import("@/routes/app.index");
    const Workspace = (Route as unknown as { options: { component: ComponentType } }).options
      .component;
    const markup = renderToStaticMarkup(createElement(Workspace));
    const grid = markup.match(/^<div class="([^"]+)"/)?.[1].split(" ") ?? [];
    // No fixed height below lg (that let the panel squeeze the thread to nothing).
    expect(grid).not.toContain("h-[calc(100vh-3.5rem)]");
    expect(grid).toEqual(
      expect.arrayContaining([
        "grid",
        "grid-cols-1",
        "lg:h-[calc(100dvh-3.5rem)]",
        "lg:grid-rows-[minmax(0,1fr)]",
      ]),
    );
    expect(markup).toMatch(/<section class="[^"]*\bh-\[calc\(100dvh-3\.5rem\)\] lg:h-auto/);
    // The column divider only from lg: on a phone the chat is the only column, at the screen edge.
    const section = markup.match(/<section class="([^"]+)"/)?.[1].split(" ") ?? [];
    expect(section).toContain("lg:border-r");
    expect(section).not.toContain("border-r");
    expect(markup).toMatch(/<aside class="flex flex-col[^"]*lg:h-full lg:min-h-0/);
    expect(markup).not.toMatch(/<aside class="h-full/);
  });

  it("does not take a message before the session and history are loaded, and says it is loading", async () => {
    const { Route } = await import("@/routes/app.index");
    const Workspace = (Route as unknown as { options: { component: ComponentType } }).options
      .component;
    const markup = renderToStaticMarkup(createElement(Workspace));
    const tag = textareaTag(markup);
    expect(tag).toContain('readOnly=""');
    expect(tag).toContain('placeholder="Loading your workspace…"');
    expect(markup).toContain("Loading…");
  });

  it("sends every message to the server: no canned 'create a post' answer in the page", () => {
    const source = readFileSync(new URL("../src/routes/app.index.tsx", import.meta.url), "utf8");
    expect(source).not.toMatch(/create\\s\+\(the\|a\)\\s\+post/);
    expect(source).not.toContain("Post framework");
    expect(source).not.toContain("on the right");
  });
});

describe("chat Markdown styles", () => {
  it("bring back list markers, indents and spacing that Tailwind's preflight removes", () => {
    const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.chat-md ol \{ list-style-type: decimal; padding-left: 1\.25rem; \}/);
    expect(css).toMatch(/\.chat-md ul \{ list-style-type: disc; padding-left: 1\.25rem; \}/);
    expect(css).toMatch(/\.chat-md strong \{ font-weight: 600; \}/);
  });
});
