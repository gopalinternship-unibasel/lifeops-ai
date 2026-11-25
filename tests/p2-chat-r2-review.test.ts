/**
 * Round 2 of the chat fixes: the points the review of the round-1 fixes left open (25 Nov 2026)
 * in the reply-draft reading (88), the 12-hour times (111), the folding of priorities (16), the
 * day answer (10), the id clean-up (17), the inbox line after a failed Gmail fetch (99) and the
 * reported-speech rule (83).
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import { describe, expect, it } from "vitest";
import { asksForEmailReply, checkDayAnswer, emailReplyFromModel } from "@/server/chat-turn.server";
import { composeReply, NOTHING_ANSWERED, resolveRefs, stripInternalMarkers, toTwelveHourClock } from "@/server/ai/reply-guard.server";
import { buildRuleBasedBriefing, foldSameCommitments, mentionedClockTimes } from "@/server/ai/briefing-fallback.server";
import { fetchMockEmails } from "@/server/connectors/gmail.mock";
import { demoSeedEvents } from "@/server/connectors/calendar.mock";
import { zonedDateTimeToISO } from "@/server/timezone.server";

const ZRH = "Europe/Zurich";
const TODAY = "2026-11-24"; // a Tuesday
const NOW = Date.parse("2026-11-24T09:00:00Z");
const emails = fetchMockEmails(ZRH, NOW);
const inbox = emails.map((mail) => ({ id: mail.id, from: mail.from, subject: mail.subject }));
const sync = demoSeedEvents(TODAY, ZRH).find((event) => event.seed_key === "team-sync")!;

describe("a draft asked for in other words than 'reply' (88)", () => {
  it.each([
    "Can you draft a polite decline for Sam's lunch invite?",
    "Draft a follow-up to the recruiter",
    "Draft a thank-you to Prof. Marlow",
    "Draft something for Ana",
    "Could you draft a short yes to Sam?",
    "Write Sam that lunch on Saturday works",
    "Decline Sam's lunch invitation politely",
    "Accept the invite from Ana",
    "Say yes to Sam",
    "Can you write to the recruiter?",
    "Which email should I answer first? Then draft a reply to it.",
    "Is it possible to draft a reply to Sam?",
    "When you have a moment, reply to Sam's email",
    "Do this: draft a reply to Sam",
    // Asks for the reply itself (kept from round 1: "How do I reply to Sam?").
    "How do I respond to the recruiter?",
    "What should I reply to Sam?",
  ])("is a request for a reply: %s", (message) => {
    expect(asksForEmailReply(message)).toBe(true);
  });

  it("the model's draft for a real inbox email is kept", () => {
    const result = emailReplyFromModel({
      raw: { message_id: "e3", body: "Hi Sam, thank you for the invitation, but I cannot make it on Saturday." },
      emails: inbox,
      message: "Can you draft a polite decline for Sam's lunch invite?",
    });
    expect(result.emailDraft?.messageId).toBe("e3");
    expect(result.emailNote).toBeUndefined();
  });

  it.each([
    // The five questions of round 1.
    "When is the final draft due?",
    "Did Sam reply?",
    "What is the response time of the planner?",
    "Has Sam replied to my email yet?",
    "Can you write a summary of my emails?",
    // Text for the chat, and the noun "draft".
    "Can you compose a summary of my emails?",
    "Draft a plan for my day",
    "Write a LinkedIn post about my week",
    "Draft due Friday?",
    "Write down that I need milk",
  ])("is not a request for a reply: %s", (message) => {
    expect(asksForEmailReply(message)).toBe(false);
  });

  it.each([
    "Who should I reply to first?",
    "Should I reply to Sam?",
    "Do I need to respond to Prof. Marlow?",
    "Which emails do I need to answer today?",
    "Is it worth replying to the recruiter?",
    "Should I decline Sam's lunch invite?",
  ])(
    "advice about replying is not a request for a reply: %s",
    (message) => {
      expect(asksForEmailReply(message)).toBe(false);
      // A placeholder email_reply gives neither a draft nor a note.
      expect(emailReplyFromModel({ raw: { message_id: "e1", body: "Dear Prof. Marlow, ..." }, emails: inbox, message })).toEqual({});
      expect(emailReplyFromModel({ raw: { message_id: "e99", body: "Hi" }, emails: inbox, message })).toEqual({});
    },
  );
});

describe("24-hour times in a sentence or range are converted together (111)", () => {
  it.each([
    ["The window is 13:00 to 14:00.", "The window is 1:00 PM to 2:00 PM."],
    ["Lunch is 12:00 to 13:00", "Lunch is 12:00 PM to 1:00 PM"],
    ["The sync runs 19:00 until 20:00.", "The sync runs 7:00 PM until 8:00 PM."],
    ["You are free 9:00 till 17:00.", "You are free 9:00 AM till 5:00 PM."],
    ["| 14:00 | Dentist appointment |", "| 2:00 PM | Dentist appointment |"],
    ["| Dentist appointment | 14:00–15:30 |", "| Dentist appointment | 2:00 PM – 3:30 PM |"],
    ["Your 14:00 meeting is with Ana.", "Your 2:00 PM meeting is with Ana."],
    ["Free slots: 14:00, 16:00 and 18:00", "Free slots: 2:00 PM, 4:00 PM and 6:00 PM"],
    ["Free slots: 9:00, 10:00 or 14:00.", "Free slots: 9:00 AM, 10:00 AM or 2:00 PM."],
    // The first time has no context of its own, the second one has ("at"): one clock per sentence.
    ["Dinner is 18:30, and the sync is at 19:00.", "Dinner is 6:30 PM, and the sync is at 7:00 PM."],
  ])("%s", (input, expected) => {
    expect(toTwelveHourClock(input)).toBe(expected);
  });

  it("amounts, ratios, scores and quoted times still stay", () => {
    for (const text of ["Price 12:50 CHF.", "The screen has a 16:10 ratio.", "The match ended 12:10.", "The ratio is 16:10 at most."]) {
      expect(toTwelveHourClock(text), text).toBe(text);
    }
    // In a sentence with a converted time, an amount stays as well.
    expect(toTwelveHourClock("Lunch at 13:00 costs 14:50 CHF.")).toBe("Lunch at 1:00 PM costs 14:50 CHF.");
    expect(toTwelveHourClock("Lunch at 12:30 costs 12:50 CHF.")).toBe("Lunch at 12:30 PM costs 12:50 CHF.");
    expect(toTwelveHourClock('Sam wrote "see you 13:00 to 14:00".')).toBe('Sam wrote "see you 13:00 to 14:00".');
  });
});

describe("taking part in a meeting is the meeting (16)", () => {
  const ctx = { todayEvents: [sync], emails, timeZone: ZRH };
  it.each(["Attend team sync at 7 PM", "Join the team sync", "Sit in on the team sync"])("'%s' is folded into the team sync", (title) => {
    const { priorities, folded } = foldSameCommitments(
      [
        { rank: 1, title: "Team sync — demo walkthrough", reason: "60 min block today" },
        { rank: 2, title, reason: "From Alicia's email" },
      ],
      ctx,
    );
    expect(priorities.map((p) => p.title)).toEqual(["Team sync — demo walkthrough"]);
    expect(folded).toHaveLength(1);
  });

  it("a separate preparation task still stays", () => {
    const rows = [
      { rank: 1, title: "Attend team sync at 7 PM", reason: "Today" },
      { rank: 2, title: "Prepare demo walkthrough slides", reason: "Needed for the sync" },
    ];
    expect(foldSameCommitments(rows, ctx).priorities).toEqual(rows);
  });
});

describe("the answer about one day (10)", () => {
  const at = (date: string, hour: number, minute = 0) => zonedDateTimeToISO(date, { hour, minute }, ZRH);
  const events = [
    { id: "gym", title: "Gym", starts_at: at("2026-11-25", 18), ends_at: at("2026-11-25", 19) },
    { id: "gymnastics", title: "Gymnastics class", starts_at: at("2026-11-27", 18), ends_at: at("2026-11-27", 19) },
  ];
  const ask = (modelReply: string) =>
    checkDayAnswer({ message: "What's on my calendar on Friday?", modelReply, today: TODAY, timeZone: ZRH, events, horizonDays: 21 });

  it("another day's 'Gym' put on Friday is not hidden by Friday's 'Gymnastics class'", () => {
    const result = ask("On Friday you have:\n- Gymnastics class: 6:00 PM – 7:00 PM\n- Gym: 6:00 PM");
    expect(result?.rebuilt).toBe(true);
    expect(result?.reply).toBe("Your calendar for Friday, Nov 27:\n- 6:00 PM – 7:00 PM Gymnastics class");
  });

  it("the right answer stands, also with am/pm only at the end of the range", () => {
    expect(ask("On Friday you have:\n- Gymnastics class: 6:00 PM – 7:00 PM")?.rebuilt).toBe(false);
    expect(ask("On Friday you have:\n- Gymnastics class: 6:00–7:00 PM")?.rebuilt).toBe(false);
    expect(ask("On Friday you have:\n- Gymnastics class: 5:00–7:00 PM")?.rebuilt).toBe(true);
  });

  it("am/pm at the end of a range is read for its start too", () => {
    expect([...mentionedClockTimes("Gymnastics class: 6:00–7:00 PM")].sort()).toEqual(["18:00", "19:00"]);
    expect([...mentionedClockTimes("Lecture 11:00–1:00 PM")].sort()).toEqual(["11:00", "13:00"]);
    expect([...mentionedClockTimes("Lunch 12:00–1:00 PM")].sort()).toEqual(["12:00", "13:00"]);
    expect([...mentionedClockTimes("Lecture 9–11 am")].sort()).toEqual(["09:00", "11:00"]);
    // A 24-hour range and a start with its own am/pm are read as before.
    expect([...mentionedClockTimes("Dentist 14:00–15:30")].sort()).toEqual(["14:00", "15:30"]);
    expect([...mentionedClockTimes("Dentist appointment, 2:00 PM – 3:30 pm")].sort()).toEqual(["14:00", "15:30"]);
  });
});

describe("an id in bold or before its own title (17)", () => {
  const refs = { events: { E1: "Team sync — demo walkthrough" } };
  const clean = (text: string) => resolveRefs(stripInternalMarkers(text), refs).text;

  it.each([
    ["- **E1** Team sync — demo walkthrough", "- Team sync — demo walkthrough"],
    ["- **E1**: 19:00–20:00 Team sync — demo walkthrough", "- 19:00–20:00 Team sync — demo walkthrough"],
    ["- __E1__ Team sync — demo walkthrough", "- Team sync — demo walkthrough"],
    ["E1 (Team sync — demo walkthrough) is at 19:00.", "Team sync — demo walkthrough is at 19:00."],
    ["You have **E1** at 7 PM.", "You have **Team sync — demo walkthrough** at 7 PM."],
    ["- **E1 Team sync — demo walkthrough** at 7 PM", "- **Team sync — demo walkthrough** at 7 PM"],
  ])("%s", (input, expected) => {
    const out = clean(input);
    expect(out).toBe(expected);
    expect(out).not.toMatch(/\*\*\*\*|____|^\(/);
  });

  it("renders without literal asterisks", () => {
    const html = renderToStaticMarkup(createElement(ReactMarkdown, null, composeReply({ modelReply: "- **E1** Team sync — demo walkthrough", timeZone: ZRH, pendingEvents: [], pendingEventChanges: [], refs, year: 2026 })));
    expect(html).not.toContain("*");
    expect(html).toContain("<li>Team sync — demo walkthrough</li>");
  });
});

describe("the inbox line when only the unread emails could not be fetched (99)", () => {
  it("says what the listed emails are, and lists the unread ones among the most recent", () => {
    const recent = [
      { from: "Ana <ana@example.com>", subject: "Budget review", snippet: "Can you check the numbers?", unread: true },
      { from: "Bank", subject: "Statement", snippet: "Your statement is ready.", unread: false },
    ];
    const { reply } = buildRuleBasedBriefing({ emails: recent, unreadCount: 0, todayEvents: [], timeZone: ZRH, reason: "", nowMs: NOW, inboxUnavailable: true });
    expect(reply).toContain("**📬 Inbox**\nYour unread emails could not all be read right now; these are the most recent:\n- **Ana \\<ana@example.com\\>** — *Budget review*");
    expect(reply).not.toContain("Your inbox could not be read right now.");
    expect(reply).not.toMatch(/inbox is clear|0 unread|Statement/);
    // With no unread email among them there is nothing to list.
    const none = buildRuleBasedBriefing({ emails: [recent[1]], unreadCount: 0, todayEvents: [], timeZone: ZRH, reason: "", nowMs: NOW, inboxUnavailable: true });
    expect(none.reply).toContain("**📬 Inbox**\nYour unread emails could not be read right now.\n\n**📅 Today**");
    // Nothing fetched at all: the inbox could not be read.
    const nothing = buildRuleBasedBriefing({ emails: [], unreadCount: 0, todayEvents: [], timeZone: ZRH, reason: "", nowMs: NOW, inboxUnavailable: true });
    expect(nothing.reply).toContain("**📬 Inbox**\nYour inbox could not be read right now.");
  });
});

describe("an attribution covers only its own part of the sentence (83)", () => {
  const answer = (modelReply: string) => composeReply({ modelReply, timeZone: ZRH, pendingEvents: [], pendingEventChanges: [], actionRequest: false, askedForAction: false, year: 2026 });

  it.each(["Sam wrote back and I have sent the reply.", "Sam said yes, and your lunch is now booked.", "Sam wrote back, I have sent the reply.", "Ana says the deck is fine; I have sent it to the team."])(
    "the model's own claim after the attribution is removed: %s",
    (sentence) => {
      expect(answer(sentence)).toBe(NOTHING_ANSWERED);
    },
  );

  it.each([
    "Ana wrote: I sent the final deck this morning.",
    "Alicia's email says the team sync has been moved, so you have time to prepare.",
    "Alicia says the team sync has been moved and the room has been changed.",
    "The team sync has been moved to 7 PM today, according to Alicia's email.",
  ])("reported speech stays: %s", (sentence) => {
    expect(answer(sentence)).toBe(sentence);
  });
});
