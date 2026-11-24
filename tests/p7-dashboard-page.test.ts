/**
 * Parts of the dashboard page (src/components/dashboard/DashboardParts.tsx, used by
 * src/routes/app.dashboard.tsx) rendered to HTML without a browser,
 * audit of 24 Nov 2026:
 *  - 40: a failed first load shows the reason and Try again, as an alert;
 *  - 113: the planner task Done button lost its name while it ran (only a spinner was left);
 *  - 44: the To field of a planner draft is a labelled input within the address length limit.
 * Layout and colours still need a look in a browser (phone and desktop width, light and dark).
 */
import { describe, expect, it } from "vitest";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  DashboardLoadError,
  RecipientField,
  TaskDoneButton,
} from "@/components/dashboard/DashboardParts";

const noop = () => {};

describe("the dashboard's first-load error (40)", () => {
  it("is an alert with the reason and a Try again button", () => {
    const html = renderToStaticMarkup(
      createElement(DashboardLoadError, {
        message: "Could not load the dashboard. Please try again in a moment.",
        onRetry: noop,
      }),
    );
    expect(html).toMatch(/^<div role="alert"/);
    expect(html).toContain("Could not load the dashboard. Please try again in a moment.");
    expect(html).toMatch(/<button type="button"[^>]*>Try again<\/button>/);
  });

  it("has a sentence even without a stored reason", () => {
    const html = renderToStaticMarkup(
      createElement(DashboardLoadError, { message: null, onRetry: noop }),
    );
    expect(html).toContain("Could not load the dashboard.");
  });
});

describe("the planner task Done button (113)", () => {
  it("keeps its name while it runs, and says that it is busy", () => {
    const busy = renderToStaticMarkup(createElement(TaskDoneButton, { busy: true, onClick: noop }));
    expect(busy).toMatch(/aria-label="Done"/);
    expect(busy).toMatch(/aria-busy="true"/);
    expect(busy).toMatch(/\sdisabled=""/);
    expect(busy).not.toMatch(/>Done</);

    const idle = renderToStaticMarkup(
      createElement(TaskDoneButton, { busy: false, onClick: noop }),
    );
    expect(idle).toMatch(/>Done<\/button>$/);
    expect(idle).not.toMatch(/aria-busy=|\sdisabled=/);
  });
});

describe("the To field of a planner draft (44, 48)", () => {
  it("is an input inside a label 'To', limited to 320 characters", () => {
    const html = renderToStaticMarkup(
      createElement(RecipientField, {
        value: "prof@uni.example",
        onChange: noop,
        disabled: false,
        testId: "action-7-to",
      }),
    );
    expect(html).toMatch(/^<label[^>]*><span[^>]*>To<\/span><input /);
    expect(html).toContain('maxLength="320"');
    expect(html).toContain('value="prof@uni.example"');
    expect(html).toContain('data-testid="action-7-to"');
  });
});
