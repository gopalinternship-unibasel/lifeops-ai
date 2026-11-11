/**
 * Review of the round-5 fixes (11 Nov 2026, _e2e/lifeops-qa/r6). The reviewer ran the new day
 * reader and reply rule next to their predecessor (600 day inputs, 103 requests, about 90
 * replies) and found:
 *  - "Friday this week" and a date with a week word next to it were refused ("I could not tell
 *    which date you mean"), a week in a contrast or a reason ("not next week") was applied to
 *    the day, and titles that contain the new words were not found;
 *  - the new claim patterns removed sound sentences from answers to questions (an inbox summary
 *    lost three of four emails);
 *  - common ways of asking ("Can we move ...?", "6 pm." after a question back) were not seen as
 *    requests, so a reply that said "done" was still shown with no card and no notice.
 * These are the reviewer's cases.
 */
import { describe, expect, it } from "vitest";
import {
  asksForAction,
  asksForCalendarAction,
  followsUpOnAction,
  matchEvent,
  parseChangeRequest,
  parseDay,
  reconcileCalendarChanges,
  resolveMove,
  type KnownEvent,
} from "@/server/calendar/change-request.server";
import { composeReply, NOTHING_ADDED, NOTHING_ON_CALENDAR, NOTHING_PREPARED } from "@/server/ai/reply-guard.server";

const ZRH = "Europe/Zurich";
const TODAY = "2026-11-11"; // a Wednesday
const NOW = Date.parse("2026-11-11T09:00:00Z");

/** Local Zurich wall-clock time (UTC+1 in November) as UTC ISO. */
const at = (date: string, hour: number, minute = 0) =>
  new Date(Date.parse(`${date}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00Z`) - 3_600_000).toISOString();

const EVENTS: KnownEvent[] = [
  { id: "sync", title: "Team sync — demo walkthrough", starts_at: at("2026-11-11", 19), ends_at: at("2026-11-11", 20) },
  { id: "lecture", title: "Lecture — Distributed Systems", starts_at: at("2026-11-12", 10), ends_at: at("2026-11-12", 12) },
  { id: "dentist", title: "Dentist appointment", starts_at: at("2026-11-13", 14), ends_at: at("2026-11-13", 15, 30) },
  { id: "week", title: "Week in review", starts_at: at("2026-11-13", 16), ends_at: at("2026-11-13", 17) },
  { id: "mile", title: "Last mile review", starts_at: at("2026-11-14", 15), ends_at: at("2026-11-14", 16) },
  { id: "acme", title: "Acme onsite interview", starts_at: at("2026-11-17", 10), ends_at: at("2026-11-17", 12) },
];
const base = { today: TODAY, timeZone: ZRH, nowMs: NOW, events: EVENTS, modelProposals: [] };

/** What the rules make of a message when the model returns nothing: [event id, new start, new end] or the note. */
function card(message: string, modelChanges: Parameters<typeof reconcileCalendarChanges>[0]["modelChanges"] = []) {
  const r = reconcileCalendarChanges({ ...base, message, modelChanges });
  return r.changes.length ? r.changes.map((c) => [c.event.id, c.next?.starts_at, c.next?.ends_at]) : r.note;
}
const UNCLEAR = (title: string) => `I could not tell which date you mean. Which date should **${title}** move to?`;

describe("the day that is asked for", () => {
  it("'this week' next to the weekday is this week's day", () => {
    for (const message of [
      "Move the dentist appointment to Friday this week at 3 pm.",
      "Move the dentist appointment to this week on Friday at 3 pm.",
      "Move the dentist appointment to Friday at 3 pm this week.",
      "Move the dentist appointment to Friday of this week at 3 pm.",
    ]) {
      expect(card(message), message).toEqual([["dentist", at("2026-11-13", 15), at("2026-11-13", 16, 30)]]);
    }
    // Also over the model's own (correct) answer.
    expect(card("Move the dentist appointment to Friday this week at 3 pm.", [{ kind: "update", event: EVENTS[2], starts_at: at("2026-11-13", 15), ends_at: at("2026-11-13", 16, 30) }]))
      .toEqual([["dentist", at("2026-11-13", 15), at("2026-11-13", 16, 30)]]);
    // A day of this week that is over is said to be over.
    expect(card("Move the dentist appointment to Monday this week at 3 pm.")).toBe("Mon, Nov 9 is already over. Which day should **Dentist appointment** move to?");
  });

  it("a date is known whatever week word stands next to it", () => {
    expect(card("Move the dentist appointment to Friday the 20th at 3 pm, next week.")).toEqual([["dentist", at("2026-11-20", 15), at("2026-11-20", 16, 30)]]);
    expect(card("Move the dentist appointment to next week, Friday the 20th at 3 pm.")).toEqual([["dentist", at("2026-11-20", 15), at("2026-11-20", 16, 30)]]);
    expect(card("Move the Acme interview to Tuesday 24 November at 10 am, a week later.")).toEqual([["acme", at("2026-11-24", 10), at("2026-11-24", 12)]]);
    expect(card("Move the team sync to tomorrow at 10 am like last week.")).toEqual([["sync", at("2026-11-12", 10), at("2026-11-12", 11)]]);
    expect(card("Move the dentist appointment to Monday at 9 am, first thing in the week.")).toEqual([["dentist", at("2026-11-16", 9), at("2026-11-16", 10, 30)]]);
  });

  it("a week in a contrast or a reason is not the week that is asked for", () => {
    expect(card("Move the Acme interview to this Friday at 10 am instead of next week.")).toEqual([["acme", at("2026-11-13", 10), at("2026-11-13", 12)]]);
    expect(card("Move the Acme interview to Friday at 10 am, not next week.")).toEqual([["acme", at("2026-11-13", 10), at("2026-11-13", 12)]]);
    expect(card("Move the dentist appointment to Friday at 3 pm as next week is full.")).toEqual([["dentist", at("2026-11-13", 15), at("2026-11-13", 16, 30)]]);
    expect(card("Move the dentist appointment to Saturday at 10 am, same as last Saturday.")).toEqual([["dentist", at("2026-11-14", 10), at("2026-11-14", 11, 30)]]);
    // The week that IS asked for still counts.
    expect(card("Move the Acme interview to Friday next week at 10 am, not this week.")).toEqual([["acme", at("2026-11-20", 10), at("2026-11-20", 12)]]);
  });

  it("'the' before the weekday", () => {
    expect(card("Move the dentist appointment to the Friday of next week at 3 pm.")).toEqual([["dentist", at("2026-11-20", 15), at("2026-11-20", 16, 30)]]);
    expect(card("Move the lecture to the Thursday of next week at 2 pm.")).toEqual([["lecture", at("2026-11-19", 14), at("2026-11-19", 16)]]);
    expect(card("Move the dentist appointment to the Friday after next.")).toEqual([["dentist", at("2026-11-20", 14), at("2026-11-20", 15, 30)]]);
    expect(card("Move the dentist appointment to the Friday of the week after next at 3 pm.")).toEqual([["dentist", at("2026-11-27", 15), at("2026-11-27", 16, 30)]]);
  });

  it("a date the rules do not work out gets a question back, not 'already over'", () => {
    expect(card("Move the dentist appointment to the last Friday of the month at 3 pm.")).toBe(UNCLEAR("Dentist appointment"));
    expect(card("Move the dentist appointment to Friday in the last week of November at 3 pm.")).toBe(UNCLEAR("Dentist appointment"));
    expect(card("Move the dentist appointment to Friday next month at 3 pm.")).toBe(UNCLEAR("Dentist appointment"));
  });

  it("titles that contain a day or week word are still found", () => {
    expect(card("Move the Friday week in review to Monday at 10 am.")).toEqual([["week", at("2026-11-16", 10), at("2026-11-16", 11)]]);
    expect(card("Move the review for Last mile to Friday at 3 pm.")).toEqual([["mile", at("2026-11-13", 15), at("2026-11-13", 16)]]);
    expect(card("Move the Last mile review to Friday at 3 pm.")).toEqual([["mile", at("2026-11-13", 15), at("2026-11-13", 16)]]);
  });

  it("two readings that differ are asked about", () => {
    const dates = (text: string, today = TODAY) => {
      const day = parseDay(text, today).day;
      return day && day !== "same" ? day.dates : undefined;
    };
    expect(dates("in two weeks on monday")).toEqual(["2026-11-23", "2026-11-30"]);
    expect(dates("monday in two weeks")).toEqual(["2026-11-23", "2026-11-30"]);
    expect(dates("friday week", "2026-11-13")).toEqual(["2026-11-20", "2026-11-27"]);
    expect(dates("friday week")).toEqual(["2026-11-20"]);
    // "The following Friday" is read like "next Friday": the model's answer decides between the two.
    expect(dates("the following friday at 3 pm")).toEqual(["2026-11-13", "2026-11-20"]);
    const request = parseChangeRequest("Move the dentist appointment to the following Friday at 3 pm.", TODAY)!;
    const match = matchEvent(request, EVENTS, ZRH);
    expect(match.status).toBe("one");
    if (match.status === "one") {
      expect(resolveMove(request, match.event, ZRH)).toEqual({ status: "unclear", question: "Which day did you mean for **Dentist appointment**: Fri, Nov 13 or Fri, Nov 20?" });
      expect(resolveMove(request, match.event, ZRH, { starts_at: at("2026-11-20", 15), ends_at: at("2026-11-20", 16, 30) }))
        .toEqual({ status: "resolved", starts_at: at("2026-11-20", 15), ends_at: at("2026-11-20", 16, 30), byRule: false });
    }
  });

  it("a week named without a day", () => {
    const thisWeek = [{ kind: "update" as const, event: EVENTS[2], starts_at: at("2026-11-14", 14), ends_at: at("2026-11-14", 15, 30) }];
    const nextWeek = [{ kind: "update" as const, event: EVENTS[2], starts_at: at("2026-11-18", 14), ends_at: at("2026-11-18", 15, 30) }];
    // The week alone: the model's day counts only if it lies in that week.
    expect(card("Move the dentist appointment to next week.", nextWeek)).toEqual([["dentist", at("2026-11-18", 14), at("2026-11-18", 15, 30)]]);
    expect(card("Move the dentist appointment to next week.", thisWeek)).toBe("Which day in the week of Mon, Nov 16 should **Dentist appointment** move to?");
    expect(card("Move the dentist appointment to next week.")).toBe("Which day in the week of Mon, Nov 16 should **Dentist appointment** move to?");
    // With "the same day" or a time, the event keeps its weekday.
    expect(card("Move the dentist appointment to the same day next week.")).toEqual([["dentist", at("2026-11-20", 14), at("2026-11-20", 15, 30)]]);
    expect(card("Move the dentist appointment to next week at 3 pm.")).toEqual([["dentist", at("2026-11-20", 15), at("2026-11-20", 16, 30)]]);
    expect(card("Move the dentist appointment to the week after next at 3 pm.")).toEqual([["dentist", at("2026-11-27", 15), at("2026-11-27", 16, 30)]]);
    // Counted from today.
    expect(card("Move the dentist appointment to a week from tomorrow at 3 pm.")).toEqual([["dentist", at("2026-11-19", 15), at("2026-11-19", 16, 30)]]);
    expect(card("Move the dentist appointment to tomorrow week at 3 pm.")).toEqual([["dentist", at("2026-11-19", 15), at("2026-11-19", 16, 30)]]);
  });

  it("a request the rules do not read: the model's day must be a day the message names", () => {
    const message = "The dentist appointment needs to move to Friday next week at 3 pm.";
    const wrong = [{ kind: "update" as const, event: EVENTS[2], starts_at: at("2026-11-13", 15), ends_at: at("2026-11-13", 16, 30) }];
    const right = [{ kind: "update" as const, event: EVENTS[2], starts_at: at("2026-11-20", 15), ends_at: at("2026-11-20", 16, 30) }];
    expect(card(message, wrong)).toBe("The AI model proposed Fri, Nov 13 for **Dentist appointment**, which is not a day your message names. Which day and time should it move to?");
    expect(card(message, right)).toEqual([["dentist", at("2026-11-20", 15), at("2026-11-20", 16, 30)]]);
    // No day in the message: the model's own day stands, as before.
    expect(card("The dentist appointment needs to be later.", [{ kind: "update", event: EVENTS[2], starts_at: at("2026-11-13", 16), ends_at: at("2026-11-13", 17, 30) }]))
      .toEqual([["dentist", at("2026-11-13", 16), at("2026-11-13", 17, 30)]]);
  });

  it("'Can we move ...?' is a request the rules read", () => {
    // The model answers with this Friday: the rules correct it to the week that was asked for.
    const wrong = [{ kind: "update" as const, event: EVENTS[2], starts_at: at("2026-11-13", 15), ends_at: at("2026-11-13", 16, 30) }];
    expect(card("Can we move the dentist appointment to Friday next week at 3 pm?", wrong)).toEqual([["dentist", at("2026-11-20", 15), at("2026-11-20", 16, 30)]]);
    expect(card("Is it possible to move the dentist appointment to Friday next week at 3 pm?", wrong)).toEqual([["dentist", at("2026-11-20", 15), at("2026-11-20", 16, 30)]]);
    expect(card("Can we push the team sync to Friday?")).toEqual([["sync", at("2026-11-13", 19), at("2026-11-13", 20)]]);
  });
});

describe("the reply rule", () => {
  const answer = (modelReply: string) => composeReply({ modelReply, timeZone: ZRH, pendingEvents: [], pendingEventChanges: [], askedForAction: false, actionRequest: false });
  const afterRequest = (modelReply: string, opts: Partial<Parameters<typeof composeReply>[0]> = {}) =>
    composeReply({ modelReply, timeZone: ZRH, pendingEvents: [], pendingEventChanges: [], askedForAction: true, actionRequest: true, ...opts });

  it("an answer to a question is shown as the model wrote it", () => {
    for (const reply of [
      "According to his email, the plumber will show up between 2 and 4 pm on Thursday.",
      "The charge will appear on your next statement.",
      "Yes, the invitation was sent by Acme on Monday at 09:14.",
      "Sam wrote that he emailed the venue and confirmed the table for 1 pm.",
      "I put together the list below.",
      "You will get the slides on Friday.",
      "The email from Ana was sent on Monday.",
      "Your calendar is updated every time you save a card.",
    ]) {
      expect(answer(reply), reply).toBe(reply);
    }
    const inbox = [
      "Here is your inbox:",
      "- **Ana** — Deck — \"I'll send the final deck tomorrow morning.\"",
      "- **HR** — Your application — \"I have forwarded your CV to the hiring manager.\"",
      "- **Sam** — Lunch — \"I confirmed the table for 1 pm.\"",
      "- **Library** — Due date — your books are due on Friday.",
    ].join("\n");
    expect(answer(inbox)).toBe(inbox);
  });

  it("after a request, a card of another kind is not what was asked for", () => {
    // Only an insight or priorities card: the claim goes, the notice says so.
    expect(afterRequest("Your yoga session is on your calendar for tomorrow at 6 pm.", { hasOtherCards: true })).toBe(NOTHING_ADDED);
    // Only a reply draft: the calendar part has no card.
    const emailDraft = { id: "d1", messageId: "e1", to: "recruiter@acme.io", subject: "Onsite", body: "Thanks", saved: false, draftId: null };
    const both = afterRequest("Your yoga session is on your calendar and the reply to the recruiter is drafted.", { emailDraft });
    expect(both).toBe(`The reply to recruiter@acme.io is under **Insights** as a draft suggestion. Edit it and click **Save as draft**; nothing is sent.\n\n${NOTHING_ON_CALENDAR}`);
    // A note about a change the model made unasked: the claim goes, the note stands.
    const aside = afterRequest("Your yoga session is on your calendar.", { changeNote: "The AI model also suggested moving **Lecture**; I did not read your message as asking for that.", changeNoteIsAside: true });
    expect(aside).toBe("The AI model also suggested moving **Lecture**; I did not read your message as asking for that. Nothing in your calendar was changed.");
    // Nothing at all.
    expect(afterRequest("Your team sync was moved to 6 pm.")).toBe(NOTHING_PREPARED);
    // What the model only quotes is not its own claim.
    expect(afterRequest("Sam wrote \"I'll send the invite\". Which day suits you?")).toBe(`Sam wrote "I'll send the invite". Which day suits you?\n\n${NOTHING_ADDED}`);
  });

  it("asksForAction: more ways of asking", () => {
    for (const message of [
      "Can we move the team sync to 6 pm?",
      "Can I move my dentist appointment to Friday at 4 pm?",
      "Could we cancel the team sync?",
      "Is it possible to move the lecture to Friday?",
      "I want you to add a yoga session tomorrow at 6 pm.",
      "When you have a moment, add a yoga session tomorrow at 6 pm.",
      "Draft me a reply to the recruiter.",
      "Write me an email to Sam saying I will be late.",
      "Extend the lecture to 1 pm.",
      "Rename the team sync to Demo dry run.",
      "Update my dentist appointment to 4 pm.",
      "Could you set a reminder for the lecture?",
      "Tomorrow at 6 pm add a yoga session.",
      "Help me schedule a call with Ana on Friday at 2 pm.",
      "The dentist appointment needs to move to Friday at 4 pm.",
      "Follow up with the recruiter about the offer.",
    ]) {
      expect(asksForAction(message), message).toBe(true);
    }
  });

  it("a request for information that starts with a calendar verb gets its answer unchanged", () => {
    for (const [message, reply] of [
      ["Remind me what is on my calendar tomorrow.", "Tomorrow you have the lecture at 10 am; the team sync is moved to 7 pm."],
      ["Remind me when my dentist appointment is.", "Your dentist appointment is scheduled for Friday at 2 pm."],
      ["Create a summary of my inbox.", "You have 3 unread emails. The onsite interview with Acme is confirmed for Monday at 10 am."],
      ["Schedule for tomorrow?", "Tomorrow: the lecture is booked from 10 am to 12 pm."],
    ]) {
      expect(asksForCalendarAction(message), message).toBe(false);
      expect(asksForAction(message), message).toBe(false);
      const shown = composeReply({ modelReply: reply, timeZone: ZRH, pendingEvents: [], pendingEventChanges: [], actionRequest: asksForCalendarAction(message), askedForAction: asksForAction(message) });
      expect(shown, message).toBe(reply);
    }
  });

  it("asksForAction: requests for information are not requests to do something", () => {
    for (const message of [
      "Remind me what is on my calendar tomorrow.",
      "Remind me when my dentist appointment is.",
      "Remind me what is in my inbox.",
      "Create a summary of my inbox.",
      "Make a list of my unread emails.",
      "Make a summary of my week.",
      "Schedule for tomorrow?",
      "Email summary, please.",
      "Mail from today?",
      "Plan for today?",
      "Show my reminders.",
      "Any reminders for today?",
      "Confirm that I have no meetings on Friday.",
      "Reply from the recruiter yet?",
      "Book recommendations for the weekend?",
      "Can you tell me what is on my calendar tomorrow?",
      "Could you show me my week?",
    ]) {
      expect(asksForAction(message), message).toBe(false);
    }
  });

  it("a short answer to MONDAY's own question or notice continues the request", () => {
    const asked = "Which day did you mean for **Dentist appointment**: Fri, Nov 13 or Fri, Nov 20?";
    for (const message of ["6 pm.", "Yes, go ahead.", "Tomorrow at 6 pm for one hour.", "The 20th."]) {
      expect(followsUpOnAction(NOTHING_ADDED, message), message).toBe(true);
      expect(followsUpOnAction(asked, message), message).toBe(true);
    }
    for (const message of ["Thanks.", "Ok", "Never mind.", "What is on tomorrow?", "No"]) {
      expect(followsUpOnAction(NOTHING_ADDED, message), message).toBe(false);
    }
    // After an ordinary answer nothing is continued.
    expect(followsUpOnAction("Your dentist appointment is on Friday at 2 pm.", "6 pm.")).toBe(false);
    expect(followsUpOnAction(null, "6 pm.")).toBe(false);
  });
});
