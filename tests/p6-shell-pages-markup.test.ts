/**
 * Server-rendered markup of the app shell, login, profile forms and calendar grid. The unit
 * tests run in plain Node with no DOM, so these check the HTML React produces: label/control
 * links, ARIA state, length limits and the classes that keep the phone layout inside the screen.
 */
import { createElement, Fragment, type ComponentType, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  pathname: "/app/calendar",
  auth: {
    user: null as null | { id: string; email?: string; is_anonymous?: boolean },
    session: null,
    loading: false,
    signOut: async () => {},
  },
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: Record<string, unknown>) => ({ options }),
  Link: ({ children, to, activeOptions: _activeOptions, ...rest }: { children?: ReactNode; to: string; activeOptions?: unknown }) =>
    createElement("a", { href: to, ...rest }, children),
  Outlet: () => null,
  useNavigate: () => () => {},
  useLocation: () => ({ pathname: state.pathname }),
}));

vi.mock("@/lib/auth-context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-context")>()),
  useAuth: () => state.auth,
}));

// The calendar route imports this server function; the grid itself never calls it.
vi.mock("@/functions/chat.functions", () => ({ fetchCalendar: vi.fn() }));

const { MondayMark } = await import("@/components/MondayMark");
const { Route: LoginRoute } = await import("@/routes/login");
const { Route: AppRoute } = await import("@/routes/app");
const { ProfileForm } = await import("@/routes/app.profile");
const { OnboardingProfileForm } = await import("@/routes/onboarding.profile");
const { WeekGrid, Route: CalendarRoute } = await import("@/routes/app.calendar");
const { hourLabel } = await import("@/lib/calendar-grid");

const componentOf = (route: unknown) => (route as { options: { component: ComponentType } }).options.component;
const render = (element: ReturnType<typeof createElement>) => renderToStaticMarkup(element);

/** The opening tag of the first element carrying `attr="value"`. */
function tagWith(html: string, attr: string, value: string): string {
  const at = html.indexOf(`${attr}="${value}"`);
  expect(at, `${attr}="${value}" in markup`).toBeGreaterThan(-1);
  return html.slice(html.lastIndexOf("<", at), html.indexOf(">", at) + 1);
}

/** The opening tag of the header link whose text is `label`. */
function navLink(html: string, label: string): string {
  const text = html.indexOf(`>${label}<`);
  expect(text, `link ${label}`).toBeGreaterThan(-1);
  return html.slice(html.lastIndexOf("<a", text), text + 1);
}

beforeEach(() => {
  state.pathname = "/app/calendar";
  state.auth.user = null;
  state.auth.loading = false;
});

describe("MONDAY logo mark", () => {
  it("gives every mark its own gradient, so a second mark on the page is not blank (login on phones)", () => {
    const html = render(createElement(Fragment, null, createElement(MondayMark), createElement(MondayMark, { size: 32 })));
    const ids = [...html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    for (const svg of html.split("</svg>").slice(0, 2)) {
      const id = svg.match(/<linearGradient id="([^"]+)"/)?.[1];
      expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(svg).toContain(`fill="url(#${id})"`);
    }
  });

  it("can hide its words below the sm breakpoint and keeps them by default", () => {
    expect(render(createElement(MondayMark, { hideWordmarkOnPhone: true }))).toContain('class="hidden sm:flex flex-col leading-none"');
    expect(render(createElement(MondayMark))).toContain('class="flex flex-col leading-none"');
  });
});

describe("login page", () => {
  it("ties the Email and Password labels to their inputs", () => {
    const html = render(createElement(componentOf(LoginRoute)));
    expect(html).toContain('<label for="login-email"');
    expect(tagWith(html, "id", "login-email")).toContain('type="email"');
    expect(html).toContain('<label for="login-password"');
    expect(tagWith(html, "id", "login-password")).toContain('type="password"');
  });

  it("tells hosted-demo visitors that idle demo accounts are deleted and a signed-out demo is gone", () => {
    vi.stubEnv("VITE_HOSTED_DEMO", "true");
    const html = render(createElement(componentOf(LoginRoute)));
    expect(html).toContain("Demo accounts and their data are deleted after 7 days without use");
    expect(html).toContain("a demo session cannot be reopened after you sign out");
    vi.stubEnv("VITE_HOSTED_DEMO", "false");
    expect(render(createElement(componentOf(LoginRoute)))).not.toContain("deleted after 7 days");
  });
});

describe("signed-in header", () => {
  const header = () => {
    state.auth.user = { id: "u1", email: "", is_anonymous: true };
    const html = render(createElement(componentOf(AppRoute)));
    return html.slice(html.indexOf("<header"), html.indexOf("</header>") + "</header>".length);
  };

  it("keeps the header inside a phone screen: links scroll within it, words beside icons hide", () => {
    const html = header();
    expect(html.match(/<header class="([^"]+)"/)?.[1]).toContain("px-3 sm:px-6");
    const nav = html.slice(html.indexOf("<nav"), html.indexOf(">", html.indexOf("<nav")) + 1);
    expect(nav).toContain("min-w-0");
    expect(nav).toContain("overflow-x-auto");
    // Every link keeps its full label and does not shrink; the nav scrolls instead.
    for (const label of ["Workspace", "Dashboard", "Plan", "Calendar", "Profile"]) {
      const link = navLink(html, label);
      expect(link).toContain("shrink-0");
      expect(link).toContain("whitespace-nowrap");
    }
    expect(html).toContain('class="hidden sm:flex flex-col leading-none"');
  });

  it("names the logo link and the Sign out button even when their words are hidden", () => {
    const html = header();
    expect(tagWith(html, "aria-label", "MONDAY workspace")).toContain('href="/app"');
    const signOut = tagWith(html, "aria-label", "Sign out");
    expect(signOut).toContain("<button");
    expect(html).toContain('<span class="hidden sm:inline">Sign out</span>');
  });

  it("marks only the current page's link as active", () => {
    const html = header();
    expect(navLink(html, "Calendar")).toContain('data-active="true"');
    for (const label of ["Workspace", "Dashboard", "Plan", "Profile"]) expect(navLink(html, label)).toContain('data-active="false"');
  });
});

describe("profile forms", () => {
  const noop = () => {};
  const props = { name: "Alex", role: "Student", goals: "Ship the paper", onNameChange: noop, onRoleChange: noop, onGoalsChange: noop, onSubmit: noop };

  it("profile page: labels name their fields and the texts are capped at the database limits", () => {
    const html = render(createElement(ProfileForm, { ...props, saving: false }));
    for (const id of ["profile-name", "profile-role", "profile-goals"]) expect(html).toContain(`<label for="${id}"`);
    expect(tagWith(html, "id", "profile-name")).toContain('maxLength="100"');
    expect(tagWith(html, "id", "profile-goals")).toContain('maxLength="2000"');
    expect(tagWith(html, "id", "profile-role")).toContain("<select");
  });

  it("onboarding: labelled fields, length caps, and a role radio group that says which role is chosen", () => {
    const html = render(createElement(OnboardingProfileForm, { ...props, busy: false }));
    expect(html).toContain('<label for="onb-name"');
    expect(html).toContain('<label for="onb-goals"');
    expect(tagWith(html, "id", "onb-name")).toContain('maxLength="100"');
    expect(tagWith(html, "id", "onb-goals")).toContain('maxLength="2000"');
    expect(tagWith(html, "role", "radiogroup")).toContain('aria-labelledby="onb-role-label"');
    const radios = [...html.matchAll(/<button[^>]*role="radio"[^>]*>([^<]+)<\/button>/g)];
    expect(radios.map((m) => m[1])).toEqual(["Student", "Professional", "Founder", "Other"]);
    const checked = radios.filter((m) => m[0].includes('aria-checked="true"')).map((m) => m[1]);
    expect(checked).toEqual(["Student"]);
    // Only the chosen role is in the tab order; arrow keys move between the others.
    expect(radios.filter((m) => m[0].includes('tabindex="0"')).map((m) => m[1])).toEqual(["Student"]);
  });
});

describe("calendar page", () => {
  it("names the previous and next week buttons", () => {
    const html = render(createElement(componentOf(CalendarRoute)));
    expect(tagWith(html, "aria-label", "Previous week")).toContain("<button");
    expect(tagWith(html, "aria-label", "Next week")).toContain("<button");
  });

  const days = Array.from({ length: 7 }, (_, i) => new Date(2026, 10, 23 + i));
  const at = (d: number, h: number, m = 0) => new Date(2026, 10, d, h, m).toISOString();
  const events = [
    { id: "e1", title: "Standup", starts_at: at(24, 10), ends_at: at(24, 10, 30), notes: null, source: "mock" },
    { id: "e2", title: "Deep work", starts_at: at(25, 14), ends_at: at(25, 16), notes: null, source: "mock" },
    { id: "e3", title: "Late call", starts_at: at(26, 0, 15), ends_at: at(26, 0, 45), notes: null, source: "mock" },
  ];
  const grid = () => render(createElement(WeekGrid, { days, events, startHour: 0, today: new Date(2026, 10, 24, 9) }));

  it("gives the header and the time grid the same seven equal day tracks inside a sideways scroller", () => {
    const html = grid();
    const header = tagWith(html, "data-testid", "calendar-header-grid");
    const body = tagWith(html, "data-testid", "calendar-body-grid");
    const columns = (tag: string) => tag.match(/grid-cols-\[[^\s"]+\]/)?.[0];
    expect(columns(header)).toBe("grid-cols-[56px_repeat(7,minmax(0,1fr))]");
    expect(columns(body)).toBe(columns(header));
    expect(tagWith(html, "data-testid", "calendar-scroller")).toContain("overflow-x-auto");
    expect(html).toContain('class="min-w-[640px] sm:min-w-0"');
  });

  it("starts the week on Monday and labels the midnight row in the locale's clock, never '0 AM'", () => {
    const html = grid();
    const weekdays = [...html.matchAll(/data-day-index="(\d)"/g)].map((m) => Number(m[1]));
    expect(weekdays).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(html.indexOf(`>${days[0].toLocaleDateString(undefined, { weekday: "short" })}<`)).toBeGreaterThan(-1);
    expect(days[0].getDay()).toBe(1);
    expect(html).not.toContain(">0 AM<");
    expect(html).toContain(`>${hourLabel(0)}</span>`);
  });

  it("shows a 30-minute event's start time on its one line, and a long event's start time on phones", () => {
    const html = grid();
    const start = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    const standup = html.slice(html.indexOf('data-compact="true"'), html.indexOf("</div></div>", html.indexOf('data-compact="true"')));
    expect(standup).toContain(">Standup</span>");
    expect(standup).toContain(` · ${start(events[0].starts_at)}`);
    const deepWork = html.slice(html.indexOf('data-compact="false"'));
    expect(deepWork).toContain(`<span class="whitespace-nowrap sm:hidden">${start(events[1].starts_at)}</span>`);
  });
});
