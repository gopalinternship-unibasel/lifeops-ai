/**
 * Review of 24 Nov 2026, finding 2 (calendar part): a short answer to MONDAY's own question back
 * ("8 pm", "Dec 4", "the first one") named no event and no verb, so the change was dropped with
 * "I did not read your message as asking for that". reconcileCalendarChanges now takes the
 * previous turn (previousTurnOf(history)) and reads such an answer into the request it answers.
 */
import { describe, expect, it } from "vitest";
import {
  followsUpOnAction,
  previousTurnOf,
  reconcileCalendarChanges,
  type KnownEvent,
  type ModelChange,
  type PreviousTurn,
} from "@/server/calendar/change-request.server";

const ZRH = "Europe/Zurich";
const TODAY = "2026-11-24"; // a Tuesday
const NOW = Date.parse("2026-11-24T09:00:00Z");
const zrh = (date: string, hour: number, minute = 0) =>
  new Date(
    Date.parse(`${date}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00Z`) -
      3_600_000,
  ).toISOString();

const EVENTS: KnownEvent[] = [
  {
    id: "sync",
    title: "Team sync — demo walkthrough",
    starts_at: zrh("2026-11-24", 19),
    ends_at: zrh("2026-11-24", 20),
  },
  {
    id: "planning",
    title: "Team sync — planning",
    starts_at: zrh("2026-11-25", 15),
    ends_at: zrh("2026-11-25", 16),
  },
  {
    id: "lecture",
    title: "Lecture — Distributed Systems",
    starts_at: zrh("2026-11-25", 10),
    ends_at: zrh("2026-11-25", 12),
  },
  {
    id: "dentist",
    title: "Dentist appointment",
    starts_at: zrh("2026-11-26", 14),
    ends_at: zrh("2026-11-26", 15, 30),
  },
];
const event = (id: string) => EVENTS.find((e) => e.id === id)!;
const update = (
  id: string,
  date: string,
  from: [number, number],
  to: [number, number],
): ModelChange => ({
  kind: "update",
  event: event(id),
  starts_at: zrh(date, ...from),
  ends_at: zrh(date, ...to),
});
function reconcile(message: string, modelChanges: ModelChange[] = [], previousTurn?: PreviousTurn) {
  return reconcileCalendarChanges({
    message,
    today: TODAY,
    timeZone: ZRH,
    nowMs: NOW,
    events: EVENTS,
    modelChanges,
    modelProposals: [],
    previousTurn,
  });
}
/** MONDAY's question for `request`, as the chat stores it (the model's text, then the note). */
function asked(request: string): PreviousTurn {
  const note = reconcile(request).note;
  expect(note, request).toBeTruthy();
  return { user: request, assistant: `I can do that.\n\n${note}` };
}

describe("previousTurnOf", () => {
  it("finds MONDAY's last reply and the message it answered, with the current message already stored", () => {
    const history = [
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello" },
      { role: "user", content: "Move the team sync to 8" },
      {
        role: "assistant",
        content: "Did you mean 8:00 AM or 8:00 PM for **Team sync — demo walkthrough**?",
      },
      { role: "user", content: "8 pm" },
    ];
    expect(previousTurnOf(history)).toEqual({
      user: "Move the team sync to 8",
      assistant: "Did you mean 8:00 AM or 8:00 PM for **Team sync — demo walkthrough**?",
    });
    expect(previousTurnOf(history.slice(0, 4))).toEqual({
      user: "Move the team sync to 8",
      assistant: "Did you mean 8:00 AM or 8:00 PM for **Team sync — demo walkthrough**?",
    });
    expect(previousTurnOf([{ role: "user", content: "Hi" }])).toEqual({});
    expect(previousTurnOf(null)).toEqual({});
  });
});

describe("answers to MONDAY's own questions", () => {
  it("am or pm: '8 pm', 'pm' and 'the second one'", () => {
    const previous = asked("Move the team sync demo walkthrough to 8");
    expect(previous.assistant).toMatch(
      /Did you mean 8:00 AM or 8:00 PM for \*\*Team sync — demo walkthrough\*\*\?/,
    );
    for (const answer of ["8 pm", "pm", "the second one", "8 pm please"]) {
      const result = reconcile(answer, [], previous);
      expect(result.changes, answer).toEqual([
        {
          kind: "update",
          event: event("sync"),
          next: { starts_at: zrh("2026-11-24", 20), ends_at: zrh("2026-11-24", 21) },
          byRule: true,
        },
      ]);
      expect(result.note, answer).toBeUndefined();
    }
    // The model's wrong reading of the answer is corrected by rule.
    expect(
      reconcile("8 pm", [update("sync", "2026-11-24", [8, 0], [9, 0])], previous).changes[0].next
        ?.starts_at,
    ).toBe(zrh("2026-11-24", 20));
  });

  it("which day: 'Monday', 'the first one', 'Dec 4'", () => {
    const previous = asked("Move the dentist appointment to Friday or Monday");
    expect(reconcile("Monday", [], previous).changes[0].next?.starts_at).toBe(
      zrh("2026-11-30", 14),
    );
    expect(reconcile("The first one", [], previous).changes[0].next?.starts_at).toBe(
      zrh("2026-11-27", 14),
    );
    expect(reconcile("Dec 4", [], previous).changes[0].next).toEqual({
      starts_at: zrh("2026-12-04", 14),
      ends_at: zrh("2026-12-04", 15, 30),
    });
  });

  it("which event: 'The first one', 'the planning one', 'the one on Wednesday'", () => {
    const previous = asked("Move the team sync to 8 pm");
    expect(previous.assistant).toMatch(/Which one do you mean\?/);
    expect(reconcile("The first one", [], previous).changes[0]).toMatchObject({
      event: { id: "sync" },
      next: { starts_at: zrh("2026-11-24", 20) },
    });
    expect(reconcile("the planning one", [], previous).changes[0]).toMatchObject({
      event: { id: "planning" },
      next: { starts_at: zrh("2026-11-25", 20) },
    });
    expect(reconcile("The one on Wednesday", [], previous).changes[0]).toMatchObject({
      event: { id: "planning" },
    });
  });

  it("what time: '3 pm' after 'What time on Fri, Nov 27 ...?'", () => {
    const previous = asked("Move the dentist appointment to Friday afternoon");
    expect(previous.assistant).toMatch(
      /What time on Fri, Nov 27 should \*\*Dentist appointment\*\* move to\?/,
    );
    // "Friday afternoon at 3" is 3 PM.
    for (const answer of ["3 pm", "3"]) {
      expect(reconcile(answer, [], previous).changes[0].next, answer).toEqual({
        starts_at: zrh("2026-11-27", 15),
        ends_at: zrh("2026-11-27", 16, 30),
      });
    }
  });

  it("an answer when the earlier request is not at hand", () => {
    const previous: PreviousTurn = {
      assistant: "Which day and time should **Dentist appointment** move to?",
    };
    const withModel = reconcile(
      "Dec 4",
      [update("dentist", "2026-12-04", [14, 0], [15, 30])],
      previous,
    );
    expect(withModel.changes).toHaveLength(1);
    expect(withModel.changes[0].next).toEqual({
      starts_at: zrh("2026-12-04", 14),
      ends_at: zrh("2026-12-04", 15, 30),
    });
    expect(withModel.note).toBeUndefined();
    // The day the answer names wins over another day from the model.
    const otherDay = reconcile(
      "Dec 4",
      [update("dentist", "2026-11-27", [14, 0], [15, 30])],
      previous,
    );
    expect(otherDay.changes[0].next?.starts_at).toBe(zrh("2026-12-04", 14));
    expect(reconcile("Friday at 3 pm", [], previous).changes[0].next?.starts_at).toBe(
      zrh("2026-11-27", 15),
    );
    expect(reconcile("Move it to Friday at 1 pm", [], previous).changes[0].next?.starts_at).toBe(
      zrh("2026-11-27", 13),
    );
  });

  it("an answer to the 'nothing was added' notice keeps the model's change only for the event and time it names", () => {
    const previous: PreviousTurn = {
      assistant:
        "**Dentist appointment** is on Thursday.\n\nNothing was added to your calendar in this turn. If you expected a change, please try again, naming the day and the time.",
    };
    expect(
      reconcile("Friday at 1 pm", [update("dentist", "2026-11-27", [13, 0], [14, 30])], previous)
        .changes,
    ).toHaveLength(1);
    const otherTime = reconcile(
      "Friday at 1 pm",
      [update("dentist", "2026-11-27", [15, 0], [16, 30])],
      previous,
    );
    expect(otherTime.changes).toEqual([]);
    expect(otherTime.note).toMatch(/not the time you gave/);
  });

  it("'Cancel it' after a question about an event cancels that event", () => {
    const previous: PreviousTurn = {
      assistant: "Which day and time should **Dentist appointment** move to?",
    };
    expect(reconcile("Cancel it", [], previous).changes).toEqual([
      { kind: "delete", event: event("dentist"), byRule: true },
    ]);
  });

  it("'yes' to 'Did you mean <date next year> ...?' moves to that date", () => {
    const previous = asked("Move the dentist appointment to May 30 at 2 pm");
    expect(previous.assistant).toMatch(
      /Did you mean Sun, May 30, 2027 for \*\*Dentist appointment\*\*\?/,
    );
    for (const answer of ["Yes", "yes please", "May 30, 2027"]) {
      const result = reconcile(answer, [], previous);
      expect(result.changes, answer).toEqual([
        {
          kind: "update",
          event: event("dentist"),
          next: { starts_at: "2027-05-30T12:00:00.000Z", ends_at: "2027-05-30T13:30:00.000Z" },
          byRule: true,
        },
      ]);
    }
  });

  it("an answer to MONDAY's note that the model's time was not offered", () => {
    const previous: PreviousTurn = {
      assistant:
        "The AI model proposed Thu, Nov 26, 3:00 AM for **Dentist appointment**, which does not look like what you asked for, so I did not offer it. Please say the day and time you want.",
    };
    expect(reconcile("Friday at 3 pm", [], previous).changes[0]).toMatchObject({
      event: { id: "dentist" },
      byRule: true,
      next: { starts_at: zrh("2026-11-27", 15) },
    });
  });
});

// Reviewer of 24 Nov 2026: any bold event name in a reply that asked something else made the
// answer a by-rule change of that event.
describe("a bold event name in a reply that did not ask about it", () => {
  const generic: PreviousTurn = {
    user: "Plan a gym session this week",
    assistant:
      "Your **Dentist appointment** is on Thursday. Which day works best for the gym session?",
  };
  const nothingAdded: PreviousTurn = {
    assistant:
      "**Team sync — demo walkthrough** is at 7 pm.\n\nNothing was added to your calendar in this turn. If you expected a change, please try again, naming the day and the time.",
  };

  it("'Cancel it' or 'Move it to Friday at 6 pm' make no card of their own", () => {
    for (const previous of [generic, nothingAdded]) {
      for (const message of ["Cancel it", "Move it to Friday at 6 pm"]) {
        const result = reconcile(message, [], previous);
        expect(result.changes, message).toEqual([]);
      }
    }
  });

  it("an answer that names something else keeps no model change", () => {
    const result = reconcile(
      "Gym Friday at 6 pm",
      [update("sync", "2026-11-27", [18, 0], [19, 0])],
      nothingAdded,
    );
    expect(result.changes).toEqual([]);
    expect(result.unasked).toBe(true);
    // Not after MONDAY's own question about another event either.
    const ownQuestion: PreviousTurn = {
      assistant: "Which day and time should **Dentist appointment** move to?",
    };
    expect(reconcile("Gym Friday at 6 pm", [], ownQuestion).changes).toEqual([]);
    expect(reconcile("8 pm, after the lecture", [], ownQuestion).changes).toEqual([]);
  });

  it("'Cancel it' with the model's own cancel is read as before: the model's change, not a rule's", () => {
    const result = reconcile("Cancel it", [{ kind: "delete", event: event("dentist") }], generic);
    expect(result.changes).toEqual([{ kind: "delete", event: event("dentist"), byRule: false }]);
  });

  it("a bare day or time after free text that asks about something else keeps no model move", () => {
    // Review of 25 Nov 2026: the model's move of the bold dentist appointment was kept although
    // the question was about the gym session.
    const dentistFriday6 = update("dentist", "2026-11-27", [18, 0], [19, 30]);
    const result = reconcile("Friday at 6 pm", [dentistFriday6], generic);
    expect(result.changes).toEqual([]);
    expect(result.unasked).toBe(true);
    // A question that names the event, or names nothing else, still keeps the model's move.
    for (const assistant of [
      "Which day works best for the **Dentist appointment**?",
      "Your **Dentist appointment** is on Thursday. Which day works for you?",
    ]) {
      const kept = reconcile("Friday at 6 pm", [dentistFriday6], { assistant });
      expect(kept.changes, assistant).toEqual([
        {
          kind: "update",
          event: event("dentist"),
          next: { starts_at: zrh("2026-11-27", 18), ends_at: zrh("2026-11-27", 19, 30) },
          byRule: false,
        },
      ]);
    }
  });

  it("'yes' or a cancel after free text keeps no model change of the bold event", () => {
    const result = reconcile("Yes", [{ kind: "delete", event: event("dentist") }], generic);
    expect(result.changes).toEqual([]);
    expect(
      reconcile("Friday at 6 pm", [{ kind: "delete", event: event("dentist") }], generic).changes,
    ).toEqual([]);
  });
});

describe("an answer and another request in one message", () => {
  it("prepares the other request and asks about the answer again, so 'yes' then moves it", () => {
    // Review of 25 Nov 2026: the answer about the dentist appointment was dropped without a note.
    const previous = asked("Move the dentist appointment to 4");
    expect(previous.assistant).toMatch(
      /Did you mean 4:00 AM or 4:00 PM for \*\*Dentist appointment\*\*\?/,
    );
    const mixed = reconcile("4 pm please, and cancel the lecture", [], previous);
    expect(mixed.changes).toEqual([{ kind: "delete", event: event("lecture"), byRule: true }]);
    expect(mixed.note).toBe(
      "Your message also answers my question about **Dentist appointment**, but I prepare one change per message, so I did not prepare that one. Did you mean Thu, Nov 26, 4:00 PM for **Dentist appointment**?",
    );
    const next = reconcile("Yes", [], {
      user: "4 pm please, and cancel the lecture",
      assistant: `Done.\n\n${mixed.note}`,
    });
    expect(next.changes).toEqual([
      {
        kind: "update",
        event: event("dentist"),
        next: { starts_at: zrh("2026-11-26", 16), ends_at: zrh("2026-11-26", 17, 30) },
        byRule: true,
      },
    ]);
  });

  it("prepares the answer when the other request prepares nothing, and says nothing untrue", () => {
    // Review of 25 Nov 2026 (second pass): the note said "I did not prepare that one" although no
    // change was prepared at all.
    const previous = asked("Move the dentist appointment to 4");
    const dentistAt4pm = {
      kind: "update",
      event: event("dentist"),
      next: { starts_at: zrh("2026-11-26", 16), ends_at: zrh("2026-11-26", 17, 30) },
      byRule: true,
    };
    // Not a calendar request.
    const subscription = reconcile("4 pm please, and cancel my subscription", [], previous);
    expect(subscription.changes).toEqual([dentistAt4pm]);
    expect(subscription.note).toBeUndefined();
    // An event that is not in the calendar: what was said about it stays.
    const yoga = reconcile("4 pm please, and cancel the yoga class", [], previous);
    expect(yoga.changes).toEqual([dentistAt4pm]);
    expect(yoga.note).toMatch(/^I could not find an event matching "the yoga class"/);
    expect(yoga.note).not.toMatch(/also answers my question/);
    // A question back about the other event: it is asked, and the answer is prepared.
    const lecture = reconcile("4 pm please, and move the lecture to 8", [], previous);
    expect(lecture.changes).toEqual([dentistAt4pm]);
    expect(lecture.note).toBe(
      "Did you mean 8:00 AM or 8:00 PM for **Lecture — Distributed Systems**?",
    );
  });

  it("adds no such note when the request is about the event asked about, or nothing came before it", () => {
    const previous = asked("Move the dentist appointment to 4");
    expect(reconcile("Cancel the lecture", [], previous).note).toBeUndefined();
    // A day right before the request is the request's own ("tomorrow's lecture").
    expect(reconcile("Tomorrow, cancel the lecture", [], previous).note).toBeUndefined();
    expect(reconcile("4 pm. Cancel the lecture", [], previous).note).toMatch(
      /also answers my question about \*\*Dentist appointment\*\*/,
    );
    expect(
      reconcile("Move the dentist appointment to Friday at 4 pm", [], previous).note,
    ).toBeUndefined();
  });
});

describe("what is still not read as an answer", () => {
  it("without the previous turn, or after a reply that asked nothing, '8 pm' asks for nothing", () => {
    const model = [update("sync", "2026-11-24", [20, 0], [21, 0])];
    expect(reconcile("8 pm", model).changes).toEqual([]);
    expect(reconcile("8 pm", model).unasked).toBe(true);
    const noQuestion: PreviousTurn = {
      user: "Move the team sync to 8 pm",
      assistant: "Ready to move **Team sync — demo walkthrough** to 8:00 PM.",
    };
    expect(reconcile("8 pm", model, noQuestion).changes).toEqual([]);
  });

  it("thanks, a refusal or a new question are not answers", () => {
    const previous = asked("Move the team sync demo walkthrough to 8");
    for (const message of ["Thanks", "No, leave it", "Never mind", "What else is on today?"]) {
      expect(reconcile(message, [], previous).changes, message).toEqual([]);
    }
  });

  it("a new request about another event is read on its own", () => {
    const previous = asked("Move the team sync demo walkthrough to 8");
    expect(reconcile("Move the lecture to 3 pm", [], previous).changes[0]).toMatchObject({
      event: { id: "lecture" },
      next: { starts_at: zrh("2026-11-25", 15) },
    });
  });

  it("followsUpOnAction also knows 'Please say the day and time you want'", () => {
    expect(
      followsUpOnAction(
        "The AI model proposed Thu, Nov 26, 3:00 AM for **Dentist appointment**, which does not look like what you asked for, so I did not offer it. Please say the day and time you want.",
        "3 pm",
      ),
    ).toBe(true);
    expect(followsUpOnAction("Your week looks calm.", "3 pm")).toBe(false);
  });
});
