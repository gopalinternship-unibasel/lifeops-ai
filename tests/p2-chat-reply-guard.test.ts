/**
 * The reply guard (src/server/ai/reply-guard.server.ts), findings of the review of
 * 24 Nov 2026: 17, 18, 79, 83, 84, 86, 91, 102, 106, 111, and the review of their fixes.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import { describe, expect, it } from "vitest";
import {
  cardConfirmations,
  composeReply,
  hasWrongWeekday,
  NOTHING_ADDED,
  NOTHING_ANSWERED,
  NOTHING_PREPARED,
  NOTHING_SENT,
  resolveRefs,
  stripInternalMarkers,
  toTwelveHourClock,
} from "@/server/ai/reply-guard.server";
import { followsUpOnAction } from "@/server/calendar/change-request.server";
import type { EmailDraftSuggestion } from "@/types/panel";

const ZRH = "Europe/Zurich";
const base = { timeZone: ZRH, pendingEvents: [], pendingEventChanges: [], year: 2026 };

describe("an id next to its own title is not replaced by the title again (17)", () => {
  const refs = { events: { E1: "Team sync — demo walkthrough" } };
  it.each([
    "• E1: 19:00–20:00 Team sync — demo walkthrough",
    "• E1. 19:00–20:00 Team sync — demo walkthrough",
    "• E1 — 19:00–20:00 Team sync — demo walkthrough",
    "E1: 19:00–20:00 Team sync — demo walkthrough",
    "- E1: Team sync — demo walkthrough at 19:00",
  ])("%s", (input) => {
    const out = resolveRefs(stripInternalMarkers(input), refs).text;
    expect(out.match(/Team sync — demo walkthrough/g)).toHaveLength(1);
    expect(out).not.toMatch(/E1|^[-•]\s*[—:.]/);
    expect(composeReply({ ...base, modelReply: input, refs }).match(/Team sync — demo walkthrough/g)).toHaveLength(1);
  });

  it("an id in running text still becomes the title", () => {
    expect(resolveRefs("You have E1 at 19:00.", refs).text).toBe("You have Team sync — demo walkthrough at 19:00.");
  });

  it("an id in running text is not dropped when the line also names the event: no sentence cut off (review of the fix)", () => {
    const out = resolveRefs("Reminder: Team sync — demo walkthrough is E1.", refs).text;
    expect(out).toBe("Reminder: Team sync — demo walkthrough is Team sync — demo walkthrough.");
    expect(out).not.toMatch(/\bis\s*\.?$/);
    // A row prefix in the middle of a line ("Today: E1 Team sync ...") is still dropped.
    expect(resolveRefs("Today: E1 Team sync — demo walkthrough at 7 PM.", refs).text).toBe("Today: Team sync — demo walkthrough at 7 PM.");
    expect(resolveRefs("- E1: Team sync — demo walkthrough", refs).text).toBe("- Team sync — demo walkthrough");
  });
});

describe("'•' lines become a Markdown list (18)", () => {
  it("in the cleaned reply", () => {
    expect(stripInternalMarkers("**📬 Inbox (2 unread)**\n\n• **A** — *x*\n• **B** — *y*")).toBe("**📬 Inbox (2 unread)**\n\n- **A** — *x*\n- **B** — *y*");
    const html = renderToStaticMarkup(createElement(ReactMarkdown, null, composeReply({ ...base, modelReply: "Your inbox:\n• **A** — *x*\n• **B** — *y*" })));
    expect(html.match(/<li>/g)).toHaveLength(2);
    expect(html).not.toContain("•");
  });
});

describe("the prompt's own annotations are removed (79)", () => {
  it("(UNREAD), (task: ..., importance ...) and the same-meeting note; the sender's own brackets stay", () => {
    const input =
      "- **Sam (friend)** — *Lunch this Saturday?* — Free for lunch? (task: Lunch with Sam, importance low)\n" +
      "- **Prof. Marlow** — *Research paper* — Please ensure citations are complete… (UNREAD)\n" +
      "- **Alicia (manager)** — *Team sync moved to 7 PM today* (task: Team sync at 7 PM (revise demo script), importance high) (same meeting as calendar event E1 19:00-20:00, already in the calendar at that time)\n" +
      "- A note (importance: high)";
    const out = stripInternalMarkers(input);
    expect(out).not.toMatch(/\(UNREAD\)|\(task:|importance (?:low|high|medium)|same meeting|revise demo script\)/);
    expect(out).toContain("**Sam (friend)**");
    expect(out).toContain("**Alicia (manager)**");
    expect(out).toContain("Please ensure citations are complete…");
    expect(composeReply({ ...base, modelReply: input })).not.toMatch(/\(UNREAD\)|\(task:/);
    // A model's own lowercase "(unread)" in prose stays.
    expect(stripInternalMarkers("Two emails are still (unread).")).toBe("Two emails are still (unread).");
  });
});

describe("answers to questions keep what an email says (83, 102)", () => {
  const answer = (modelReply: string) => composeReply({ ...base, modelReply, actionRequest: false, askedForAction: false });
  it.each([
    "Alicia's email says the team sync has been moved to 7 PM today.",
    "Stripe says your invoice has been sent.",
    "According to Sam's message, the table has been booked for 1 pm.",
    '- **Ana** — *Final deck* — "I sent the final deck this morning, please review."',
  ])("kept: %s", (sentence) => {
    expect(answer(sentence)).toBe(sentence);
  });

  it("a claim of the model's own is still removed, and a question gets a neutral notice, not 'naming the day and the time'", () => {
    const reply = answer("Your Acme onsite interview has been scheduled for Monday at 10:00.");
    expect(reply).toBe(NOTHING_ANSWERED);
    expect(reply).not.toMatch(/naming the day and the time/);
    expect(answer("Your order is in e9.").length).toBeGreaterThan(0);
    expect(composeReply({ ...base, modelReply: "Your order is in e9.", refs: { events: {}, emails: { e1: "x" } } })).not.toContain("naming the day and the time");
    // The neutral notice is not read as a question back.
    expect(followsUpOnAction(NOTHING_ANSWERED, "6 pm")).toBe(false);
  });

  it("after a request to do something the same claim is still not shown", () => {
    expect(composeReply({ ...base, modelReply: "Alicia's email says the team sync has been moved to 7 PM today.", actionRequest: true, askedForAction: true })).toBe(NOTHING_PREPARED);
  });

  it("an inbox summary in the prompt's own bullet format keeps its lines and its heading (review of the fix)", () => {
    // The reply to "Please check all my emails and messages." (a question: nothing asked to be done).
    const summary = [
      "**📬 Inbox (4 unread)**",
      "- **Alicia** — *Team sync moved to 7 PM today* — The team sync has been moved to 7 PM today.",
      "- **Stripe** — *Invoice* — Your invoice has been sent.",
      "- **Sam (friend)**: *Lunch Saturday?* — I have booked a table for 1 pm.",
      "- **Prof. Marlow** — *Research paper* — Please send the final draft.",
      "",
      "**📅 Today**",
      "- 7:00 PM – 8:00 PM Team sync — demo walkthrough",
    ].join("\n");
    expect(answer(summary)).toBe(summary);
  });

  it.each([
    "The team sync has been moved to 7 PM today, according to Alicia's email.",
    "The team sync has been moved to 7 PM today, Alicia says.",
    "Alicia's message: the team sync has been moved to 7 PM today.",
    "**Alicia's email:** the team sync has been moved to 7 PM today.",
    "Email from Stripe: your invoice email was sent.",
  ])("kept, the attribution after the claim or with a colon: %s", (sentence) => {
    expect(answer(sentence)).toBe(sentence);
  });

  it("the model's own claims stay removed in a question turn", () => {
    expect(answer("I've moved the team sync to 7 PM, as you said.")).toBe(NOTHING_ANSWERED);
    expect(answer("Done — the sync is at 7 PM now.")).toBe(NOTHING_ANSWERED);
    expect(answer("- **Alicia** — *Sync* — Reminder set for 7 PM.")).toBe(NOTHING_ANSWERED);
  });
});

describe("near variants of 'done' after a request with no card (84)", () => {
  const compose = (modelReply: string, opts: Partial<Parameters<typeof composeReply>[0]> = {}) =>
    composeReply({ ...base, modelReply, askedForAction: true, actionRequest: true, ...opts });

  it.each([
    "Your reminder is all set for Thursday at 13:00.",
    "Your yoga session tomorrow at 18:00 is in the calendar.",
    "Okay, the yoga session now starts tomorrow at 18:00.",
    "Great, your yoga session is all set for tomorrow at 18:00.",
    "Your yoga session is locked in for tomorrow at 18:00.",
    "Done — yoga is on for tomorrow at 18:00.",
    "Your reminder is all set.",
    "It is in the calendar.",
    "I'll make sure you remember.",
  ])("replaced: %s", (reply) => {
    expect(compose(reply)).toBe(NOTHING_PREPARED);
  });

  it("'has been told' after a request to tell someone", () => {
    expect(compose("Sam has been told you will be late.", { actionRequest: false })).toBe(NOTHING_PREPARED);
  });

  it("a question back, a suggestion and a plan in words stay", () => {
    expect(compose("What time should the yoga session start?")).toBe(`What time should the yoga session start?\n\n${NOTHING_ADDED}`);
    expect(compose("You could do yoga tomorrow at 18:00 or on Thursday.")).toBe(`You could do yoga tomorrow at 18:00 or on Thursday.\n\n${NOTHING_ADDED}`);
    const plan = "Here is a plan for tomorrow:\n- 14:00 review the lecture notes\n- 16:00 gym";
    expect(compose(plan)).toBe(`${plan}\n\n${NOTHING_ADDED}`);
  });
});

describe("a request to send (86)", () => {
  it("is told where drafts go, not to name a day and a time", () => {
    const reply = composeReply({ ...base, modelReply: "I can't send emails for you.", actionRequest: false, askedForAction: true, sendRequest: true });
    expect(reply).not.toMatch(/naming the day and the time/);
    expect(reply).toMatch(/never sends/i);
    expect(followsUpOnAction(reply, "Yes, send it.")).toBe(false);
    expect(composeReply({ ...base, modelReply: "", actionRequest: false, askedForAction: true, sendRequest: true })).toBe(NOTHING_SENT);
  });

  it("a calendar request keeps the calendar notice", () => {
    expect(composeReply({ ...base, modelReply: "Sure.", actionRequest: true, askedForAction: true, sendRequest: false })).toBe(`Sure.\n\n${NOTHING_ADDED}`);
  });
});

describe("a number before a word that starts like a month is not a date (91)", () => {
  it("correct sentences stay", () => {
    expect(hasWrongWeekday("On Monday 3 marketing calls are planned.", 2026)).toBe(false);
    expect(hasWrongWeekday("On Tuesday 2 decks are due.", 2026)).toBe(false);
    expect(hasWrongWeekday("Wednesday 4 junior interviews are booked in.", 2026)).toBe(false);
    expect(hasWrongWeekday("Monday marketing 10 am is free.", 2026)).toBe(false);
    expect(composeReply({ ...base, modelReply: "On Monday 3 marketing calls are planned." })).toBe("On Monday 3 marketing calls are planned.");
  });

  it("real month words are still checked", () => {
    expect(hasWrongWeekday("Thu, Nov 14", 2026)).toBe(true);
    expect(hasWrongWeekday("Saturday 14 November", 2026)).toBe(false);
    expect(hasWrongWeekday("Thursday 14 November", 2026)).toBe(true);
    // 1 Sep 2026 is a Tuesday (2027: a Wednesday), so "Mon, Sept 1" is wrong and "Tue, Sept 1" right.
    expect(hasWrongWeekday("Mon, Sept 1", 2026)).toBe(true);
    expect(hasWrongWeekday("Tue, Sept 1", 2026)).toBe(false);
    expect(hasWrongWeekday("Tuesday, December 1", 2026)).toBe(false);
  });
});

describe("the card's closing sentence is its own paragraph (106)", () => {
  it("is not part of the last bullet", () => {
    const [line] = cardConfirmations({
      pendingEvents: [{ id: "p1", title: "Run", starts_at: "2026-11-25T06:00:00.000Z", ends_at: "2026-11-25T07:00:00.000Z" }],
      pendingEventChanges: [],
      timeZone: ZRH,
    });
    expect(line).toMatch(/\n\nNothing is saved until you click/);
    const html = renderToStaticMarkup(createElement(ReactMarkdown, null, line));
    expect(html).toContain("</ul>\n<p>Nothing is saved until you click");
    expect(html).not.toMatch(/<li>[^<]*Nothing is saved/);
  });
});

describe("times as the cards show them, and drafts not repeated (111)", () => {
  it("24-hour times become 12-hour ones; am/pm, ISO and quoted times stay", () => {
    expect(toTwelveHourClock("Your calendar for Friday:\n\n• Dentist appointment: 14:00–15:30")).toBe("Your calendar for Friday:\n\n• Dentist appointment: 2:00 PM – 3:30 PM");
    // Only numbers that stand as a time ("at 12:00", "at 08:15"); "so 12:30" and "is 00:00" do not say so.
    expect(toTwelveHourClock("The lecture ends at 12:00, so 12:30 works. Breakfast at 08:15, midnight is 00:00.")).toBe(
      "The lecture ends at 12:00 PM, so 12:30 works. Breakfast at 8:15 AM, midnight is 00:00.",
    );
    // One clock per sentence: the ambiguous "11:00" next to "13:00" is converted as well.
    expect(toTwelveHourClock("From 11:00 to 13:00 and 11:00–13:00.")).toBe("From 11:00 AM to 1:00 PM and 11:00 AM – 1:00 PM.");
    expect(toTwelveHourClock("At 9:30 or 2:00 PM; 2026-11-24T14:00:00; Sam wrote \"see you at 14:00\".")).toBe("At 9:30 or 2:00 PM; 2026-11-24T14:00:00; Sam wrote \"see you at 14:00\".");
  });

  it("a price, a ratio, a score or a name next to a number stays; a mixed sentence is converted whole (review of the fix)", () => {
    for (const text of [
      "Price 12:50 CHF.",
      "The screen has a 16:10 ratio.",
      "John 13:45",
      "The match ended 12:10.",
      "The ratio is 16:10 at most.",
    ]) {
      expect(toTwelveHourClock(text), text).toBe(text);
    }
    expect(toTwelveHourClock("From 9:00 to 17:00 you are free.")).toBe("From 9:00 AM to 5:00 PM you are free.");
    expect(toTwelveHourClock("You are free between 9:00 and 17:00.")).toBe("You are free between 9:00 AM and 5:00 PM.");
    expect(toTwelveHourClock("Lunch at 12:30 costs 12:50 CHF.")).toBe("Lunch at 12:30 PM costs 12:50 CHF.");
    // Next to a day word, and at the start of a list item.
    expect(toTwelveHourClock("Friday 14:00 works, or 16:00 on Monday.")).toBe("Friday 2:00 PM works, or 4:00 PM on Monday.");
    expect(toTwelveHourClock("Plan:\n- 14:00 review the notes\n- 9:00 gym")).toBe("Plan:\n- 2:00 PM review the notes\n- 9:00 gym");
    // An event's time in a list item, after its title.
    expect(toTwelveHourClock("- Dentist appointment: 14:00\n- **Team sync** (19:00)")).toBe("- Dentist appointment: 2:00 PM\n- **Team sync** (7:00 PM)");
    expect(toTwelveHourClock("Score: 12:10 after the break.")).toBe("Score: 12:10 after the break.");
    // Two sentences: the second one's ambiguous time is not on the first one's clock.
    expect(toTwelveHourClock("The sync is at 19:00. The bus leaves at 7:15.")).toBe("The sync is at 7:00 PM. The bus leaves at 7:15.");
  });

  it("a reply that repeats the draft points to the draft card instead", () => {
    const draft: EmailDraftSuggestion = { id: "d", messageId: "e3", to: "Sam (friend)", subject: "Lunch", body: "Hi Sam — yes, let's do lunch on Saturday around 1 pm.\n\nBest,\nDemo", saved: false, draftId: null };
    const reply = composeReply({ ...base, modelReply: "Hi Sam — yes, let's do lunch on Saturday around 1 pm.", emailDraft: draft });
    expect(reply).toContain("under **Insights**");
    expect(reply).not.toContain("let's do lunch");
    // A short sentence about the draft stays.
    expect(composeReply({ ...base, modelReply: "Here's a draft reply to Sam.", emailDraft: draft })).toBe("Here's a draft reply to Sam.");
  });
});
