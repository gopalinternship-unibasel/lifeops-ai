/**
 * Round-2 review points on the workspace's pure helpers: the card gate (finding 56), the bullet
 * normaliser (finding 18) and the sentence for a refused sign-in (finding 92).
 */
import { describe, expect, it } from "vitest";
import type { InsightCard } from "@/types/panel";
import { gateModelCards } from "@/lib/panel-state";
import { normalizeBullets } from "@/lib/reply-state";
import {
  NETWORK_FAILURE_MESSAGE,
  SESSION_EXPIRED_MESSAGE,
  getErrorMessage,
  getVisitorErrorMessage,
} from "@/lib/errors";

describe("the card gate (finding 56, round-2 review)", () => {
  const summary: InsightCard = { kind: "summary", title: "Inbox Overview", bullets: ["4 unread emails"] };
  const alternatives = { title: "Lunch Alternatives", bullets: ["Salad"] };

  it("drops the summary placeholder when the user asks to list emails, messages or events with a word before them", () => {
    for (const message of [
      "List unread emails",
      "list unread emails",
      "List all unread emails",
      "Can you list new messages from Sam?",
      "List upcoming events this week",
      "list recent e-mails",
    ]) {
      expect(gateModelCards(message, { insight: summary }).insight, message).toBeUndefined();
    }
  });

  it("drops it for every email-check phrase the system prompt names", () => {
    for (const message of ["check emails", "check messages", "what's in my inbox", "show unread", "list unread emails"]) {
      expect(gateModelCards(message, { insight: summary }).insight, message).toBeUndefined();
    }
  });

  it("still keeps a card for lists of other things", () => {
    const card: InsightCard = { kind: "summary", title: "Ideas", bullets: ["Hike"] };
    for (const message of [
      "List restaurants in Basel for a team lunch",
      "List places for team events",
      "List ideas for emails to clients",
      "list 5 books to read this winter",
      "Make a packing list for Zurich",
    ]) {
      expect(gateModelCards(message, { insight: card }).insight, message).toEqual(card);
    }
  });

  it("keeps a card when other words than qualifiers come between 'list' and the meetings or events (second review)", () => {
    const card: InsightCard = { kind: "summary", title: "Ideas", bullets: ["Hike"] };
    for (const message of [
      "List questions for meetings",
      "List topics for meetings",
      "List icebreakers for meetings",
      "List venues for events",
      "List 5 tasks to do this weekend",
      "List the best restaurants in Basel",
      "List the pros and cons of moving to Zurich",
    ]) {
      expect(gateModelCards(message, { insight: card }).insight, message).toEqual(card);
    }
  });

  it("drops it after 'list' and 'the' with qualifiers such as a day, a time of day or 'team' (second review)", () => {
    for (const message of [
      "List the unread emails",
      "list all the meetings tomorrow",
      "List the Friday meetings",
      "list Friday's events",
      "List team meetings this week",
      "List work emails",
      "List the free slots tomorrow",
      "list free slots on Friday",
      "List my events on Friday",
      "Can you list today's meetings?",
    ]) {
      expect(gateModelCards(message, { insight: summary }).insight, message).toBeUndefined();
    }
  });

  it("drops alternatives when 'without' or 'instead of' only describes a calendar entry", () => {
    for (const message of [
      "Add lunch without onions",
      "add lunch tomorrow at 12 without onions",
      "Can you add lunch without onions?",
      "Please schedule dinner with Anna without the kids",
      "Move the sync to Friday instead of Thursday",
      "Could you book the gym instead of the run on Friday?",
      "Reschedule my 1:1 to 3 pm instead of 2 pm",
      "Add lunch and dinner without onions",
      "Move the sync to Friday, instead of Thursday",
    ]) {
      expect(gateModelCards(message, { alternatives }).alternatives, message).toBeUndefined();
    }
  });

  it("also after a short word before the command: 'Hey,', 'Okay', 'Please,' (second review)", () => {
    for (const message of [
      "Please, add lunch without onions",
      "Hey, add lunch without onions",
      "Okay add lunch without onions",
      "Ok, please add lunch without onions",
      "Hey can you please add lunch without onions",
      "Thanks! Now move the sync to Friday instead of Thursday",
    ]) {
      expect(gateModelCards(message, { alternatives }).alternatives, message).toBeUndefined();
    }
  });

  it("keeps alternatives when a calendar command goes on to ask for something (second review)", () => {
    for (const message of [
      "Cancel the gym, what else can I do without weights?",
      "Remove eggs from the list and suggest what to use instead of them",
      "Book a table, something without meat",
      "Cancel the run, how can I train without the gym?",
    ]) {
      expect(gateModelCards(message, { alternatives }).alternatives, message).toEqual(alternatives);
    }
  });

  it("keeps alternatives for 'without' and 'instead of' in other requests, and for a missing thing next to an event", () => {
    for (const message of [
      "How do I bake a cake without eggs?",
      "Pancakes without milk, what can I do?",
      "I want to make pancakes without eggs",
      "What can I use instead of butter?",
      "Add a grocery run, I ran out of eggs",
    ]) {
      expect(gateModelCards(message, { alternatives }).alternatives, message).toEqual(alternatives);
    }
  });

  it("keeps a plan card for 'Plan my evening': a plan is content the user asked for (by design)", () => {
    expect(gateModelCards("Plan my evening", { insight: summary }).insight).toEqual(summary);
  });
});

describe("bullet characters in assistant replies (finding 18, round-2 review)", () => {
  it("turns a bullet character into '- ' only when a space or tab follows it", () => {
    expect(normalizeBullets("• one\n▸ two\n\t◦\tthree")).toBe("- one\n- two\n\t- three");
    expect(normalizeBullets("▸Details\n•item")).toBe("▸Details\n•item");
  });

  it("leaves separator lines alone, also of middle dots, and still lists '· item' lines (second review)", () => {
    const separators = "· · ·\n• • •\n  ▪ ▪ ▪\n·separated";
    expect(normalizeBullets(separators)).toBe(separators);
    expect(normalizeBullets("· Standup at 9:00\n·  Lunch at 12:00")).toBe("- Standup at 9:00\n- Lunch at 12:00");
  });
});

describe("a refused sign-in in text the visitor reads (finding 92, round-2 review)", () => {
  it("is a sentence for the visitor, not the sign-in check's own text", () => {
    for (const error of [
      new Error("Unauthorized: Invalid token"),
      new Error("Unauthorized: No authorization header provided"),
      new Response("Unauthorized: Invalid token", { status: 401 }),
      { status: 403, message: "Forbidden" },
    ]) {
      expect(getVisitorErrorMessage(error, "Please try again.")).toBe(SESSION_EXPIRED_MESSAGE);
    }
    expect(SESSION_EXPIRED_MESSAGE).not.toMatch(/unauthori[sz]ed|token|header/i);
  });

  it("also fits a demo visitor, who never signed in (second review)", () => {
    expect(SESSION_EXPIRED_MESSAGE).not.toMatch(/sign(?:ed)?[- ]?in/i);
    expect(SESSION_EXPIRED_MESSAGE).toMatch(/Reload the page/);
  });

  it("is getErrorMessage for every other error", () => {
    expect(getVisitorErrorMessage(new TypeError("Failed to fetch"))).toBe(NETWORK_FAILURE_MESSAGE);
    expect(getVisitorErrorMessage(new Error("Chat session not found"))).toBe("Chat session not found");
    expect(getVisitorErrorMessage(undefined, "Please try again.")).toBe("Please try again.");
    expect(getVisitorErrorMessage(new Response("Server error", { status: 500 }), "Please try again.")).toBe(
      getErrorMessage(new Response("Server error", { status: 500 }), "Please try again."),
    );
  });
});
