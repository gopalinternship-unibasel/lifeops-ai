/**
 * Moving or cancelling an EXISTING calendar event from a chat message ("Move my dentist
 * appointment to start at 4 pm the same day", "Cancel the team sync").
 *
 * The model is asked for an `event_changes` entry, but a small local model got these wrong in
 * every real attempt in QA round 3 (9 Nov 2026): a move to 04:00 the NEXT day while its reply
 * said "4:00 PM today", and two NEW dentist appointments instead of moving the one there.
 * So the app reads the cheap, unambiguous parts of the request itself:
 *
 *  - whether it is a change request at all: only a message that clearly asks to move,
 *    reschedule, shift, push, postpone, bring forward or cancel an event it names (see the verb
 *    lists below). In QA round 4 (10 Nov 2026) the rules were too eager: "Set a reminder for my
 *    dentist appointment at 1 pm on Thursday" was offered as a move of the appointment. Everything
 *    else (reminders, new events, questions, messages to write) takes the ordinary path: the
 *    model's own answer, checked; tests/change-request-table.test.ts lists the phrasings;
 *  - which event: the event the request names by words of its title, and by no other word
 *    ("the reminder for my dentist appointment" is not the appointment), narrowed by a day or
 *    time the request gives for it ("the dentist appointment on Wednesday"); two equally good
 *    matches are a question back to the user, never a guess;
 *  - the new day: "the same day", "today", "tomorrow", a weekday, "Nov 12", "the 13th",
 *    "2026-11-12"; a weekday that could mean two dates ("Monday" on a Monday, "next Friday") or
 *    that is not its date's ("Thursday Nov 13") is ambiguous;
 *  - the new time: "4 pm", "16:00", "4:00-5:30 pm", "noon", "start at", "end at", "for an
 *    hour", "an hour later"; "at 4" without am/pm is ambiguous (4:00 or 16:00). A time in the
 *    reason for the request ("... because I have a lecture at 4 pm") is not the new time.
 *
 * Whatever the request pins down is applied by rule; where it leaves a choice (am or pm, which
 * Monday, "Friday afternoon"), the model's proposal is used only if it is one of the allowed
 * readings, otherwise the user is asked. Nothing here writes to the calendar: the result is a
 * proposal card the user still has to save.
 */
import { addDaysISO, localDateTime, zonedDateTimeToISO } from "@/server/timezone.server";

export interface KnownEvent {
  id: string;
  title: string;
  starts_at: string;
  ends_at: string;
}

/** One or more possible local dates; more than one means the request is ambiguous. */
export interface DayRef {
  dates: string[];
  text: string;
  /** The words name a day that is over ("yesterday", "last Friday"). */
  past?: boolean;
  /** The words give the date itself ("tomorrow", "Nov 20", "the 20th"); a week word next to it changes nothing. */
  exact?: boolean;
  /** The words name a date the rules do not work out ("the last Friday of the month"). */
  unclear?: boolean;
}

/** One or more possible clock times (minutes after local midnight); two means am/pm unknown. */
export interface ClockRef {
  minutes: number[];
  text: string;
}

export interface ChangeRequest {
  kind: "move" | "cancel";
  /**
   * How sure the verb is (see the verb lists below). "clear": move, reschedule, postpone, cancel;
   * the message asks for a change, and an event the rules cannot find is reported. "exact" and
   * "weak": verbs that also start other requests; they count only when their object IS an event
   * of the calendar, otherwise the rules stay out and the model's answer is used. "model": set
   * and put; they count only when the model itself moved the event the message names.
   */
  certainty: "clear" | "exact" | "weak" | "model";
  /** The words of the request that name the event ("my dentist appointment"). */
  subject: string;
  /** Title words of the subject, for matching against event titles. */
  subjectWords: string[];
  /** A day or time the request gives for the EXISTING event ("on Wednesday", "the 3 pm meeting"). */
  sourceDay?: DayRef;
  sourceClock?: ClockRef;
  /** Move only: the new day ("same" = the event's own day). */
  day?: DayRef | "same";
  /** Move only: the new start (or the new end when endOnly). */
  start?: ClockRef;
  /** Move only: the new end of a range ("4:00-5:30 pm"), paired with start by index. */
  end?: ClockRef;
  /** "end at 5 pm", "until 5": only the end changes. */
  endOnly?: boolean;
  durationMin?: number;
  /** "an hour later", "push back 30 minutes": shift both ends. */
  shiftMin?: number;
  /** The destination has words the rules do not read ("next week", "Friday afternoon"). */
  vagueTime?: boolean;
  /**
   * A day was read, but words about the week or month next to it were not ("Friday next month",
   * "Friday two weeks later"): the date is not known, so no move is proposed from it.
   */
  dayUnclear?: boolean;
  /** A week named without a day ("to next week"): the Monday of that week. */
  weekStart?: string;
}

const WEEKDAYS: Record<string, number> = {
  sunday: 0, sun: 0, monday: 1, mon: 1, tuesday: 2, tue: 2, tues: 2, wednesday: 3, wed: 3,
  thursday: 4, thu: 4, thur: 4, thurs: 4, friday: 5, fri: 5, saturday: 6, sat: 6,
};
const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};
const WEEKDAY_RE = "(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tues|tue|wed|thurs|thur|thu|fri|sat|sun)";
/** "a week from Friday", "in two weeks", "three days ago". */
const WEEK_COUNT: Record<string, number> = { a: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };
const MONTH_RE = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";

// The verb must start a clause ("Move ...", "Please move ...", "Can you cancel ...", "..., then
// move ...", "I need to reschedule ..."): in "Block 3-5 pm for a gym push workout" the word
// "push" is not a request, and in "Remind me to reschedule the dentist", "Don't cancel the team
// sync" or "Tell Sam I need to move our lunch" the verb is not one either. The polite words
// themselves must start the clause.
const FILLER = "(?:please|pls|kindly|just|ok|okay|actually|yes|yeah|yep|sure|great|thanks|perfect|alright|right|well|so|now|hi|hey|hello|monday)";
// "Can we move ...", "Can I ...", "Is it possible to ...", "I want you to ..." ask as well (review
// of 11 Nov 2026: such a request was not read, so a wrong model date for it was shown).
const ASK = "(?:(?:can|could|would|will|shall) (?:you|we|i)|is it possible to|would it be possible to|i (?:want|need|have) to|i (?:want|need) you to|i(?:'d| would) like (?:you )?to|i must|we (?:need|have) to|let's|lets|go ahead and|help me(?: to)?)";
const CLAUSE_START = `(?:(?:^|[,;:.!?]\\s*|\\b(?:and|then|also)\\s+)(?:${FILLER},?\\s+){0,3}(?:${ASK}\\s+)?(?:${FILLER}\\s+){0,2})`;
/** A message that asks to write or tell something: "Email Sam: cancel lunch", "Draft a reply ...", "Tell Sam I need to move our lunch". */
const COMMUNICATE_VERBS = "(?:email|e-mail|mail|draft|write|reply|respond|answer|tell|message|text|send|ask|notify)";
const COMMUNICATE_RE = new RegExp(`^(?:${FILLER},?\\s+){0,3}(?:${ASK}\\s+)?(?:${FILLER}\\s+){0,2}${COMMUNICATE_VERBS}\\b`);

/**
 * QA round 4 (10 Nov 2026): "Set a reminder for my dentist appointment at 1 pm on Thursday" was
 * offered as a MOVE of the appointment, and "Set up a gym session tomorrow at 6 pm" got "I could
 * not find an event matching "up a gym session"": the rules treated set / put / change at the
 * start of a clause as move verbs. Rules that override the model must be conservative, so:
 *
 *  - CLEAR verbs only ever ask to move or cancel something: the message is a change request.
 *  - EXACT verbs also have other uses ("push workout", "shift my focus", "delete the note about
 *    the lecture", "remove the lecture task from my priorities"): they count only when their
 *    object is an event of the calendar, named by its own title words.
 *  - WEAK verbs start many ordinary requests ("Change of plans: ...", "Bring snacks to the team
 *    sync", "Drop the idea", "Pull together notes"): as EXACT, and only with a definite object
 *    ("Change my dentist appointment to 4 pm"); "change" needs a new day or time the rules can
 *    read, "bring" and "pull" a direction ("forward").
 *  - "set" and "put" never start a move by rule ("Set a reminder ...", "Set up ...", "Set aside
 *    ...", "Put a 1-hour gym session on Friday", "Put the lecture on my calendar for Friday");
 *    only "put off" does (postpone). Such messages take the ordinary path: the model's own
 *    answer, checked like every other one. MODEL verbs: with a definite object that is an event
 *    ("Put the team sync on Friday") a move of THAT event is kept if the model itself returned
 *    it, with the day and time the message names; the rules alone never make one.
 */
const CLEAR_MOVE_VERBS = ["move", "reschedule", "re-schedule", "postpone", "prepone", "put off"];
const CLEAR_CANCEL_VERBS = ["cancel", "call off"];
const EXACT_MOVE_VERBS = ["push", "shift", "delay"];
const EXACT_CANCEL_VERBS = ["delete", "remove", "scrap"];
const WEAK_MOVE_VERBS = ["change", "bring", "pull"];
const WEAK_CANCEL_VERBS = ["drop"];
const MODEL_MOVE_VERBS = ["set", "put"];
/** Verbs that are also nouns or start other requests: they need a definite object right after. */
const NEEDS_DEFINITE_OBJECT = new Set(["push", "shift", "delay", ...WEAK_MOVE_VERBS, ...WEAK_CANCEL_VERBS, ...MODEL_MOVE_VERBS]);
const DEFINITE = `(?:the|my|our|your|this|that|these|those|it|today's|tomorrow's|tonight's|${WEEKDAY_RE}'s)`;
const verbAlternatives = (verbs: string[]) => verbs.map((verb) => verb.replace("-", "\\-").replace(" ", "\\s+")).join("|");
const CANCEL_RE = new RegExp(`${CLAUSE_START}(${verbAlternatives([...CLEAR_CANCEL_VERBS, ...EXACT_CANCEL_VERBS, ...WEAK_CANCEL_VERBS])})\\b`, "g");
const MOVE_RE = new RegExp(`${CLAUSE_START}(${verbAlternatives([...CLEAR_MOVE_VERBS, ...EXACT_MOVE_VERBS, ...WEAK_MOVE_VERBS, ...MODEL_MOVE_VERBS])})\\b`, "g");
/** A definite object ("the", "my", "it", "tomorrow's"), maybe after a particle ("push back the ..."). */
const DEFINITE_OBJECT = new RegExp(`^\\s*(?:(?:back|forward|ahead)\\s+)?${DEFINITE}\\b`);
/**
 * A request for something NEW: "Set a reminder ...", "Set up a call", "Put prep time ...", "Add
 * ...", "Book ...". "set" and "put" ask for something new unless their object is definite.
 */
const CREATE_RE = new RegExp(
  `${CLAUSE_START}(?:(?:set|put)\\b(?!\\s+(?:off\\b|${DEFINITE}\\b))|(?:pencil in|add|book|schedule|create|block|plan|make time|make an?|remind|reserve|arrange|organi[sz]e|find (?:time|a slot))\\b)`,
);
/** "Confirm lunch with Sam for me", "Let Sam know I am late", "Forward it to Ana": something to send. */
const OTHER_ACTION_RE = new RegExp(`${CLAUSE_START}(?:confirm|decline|accept|rsvp|invite|forward|let\\s+(?!me\\b)\\w+\\s+know)\\b`);
const MESSAGE_START = `^(?:${FILLER},?\\s+){0,3}(?:${ASK}\\s+)?(?:${FILLER}\\s+){0,2}`;
/** A verb that sends something to someone, not followed by "me" ("Tell me ..." asks for an answer). */
const OUTBOUND_RE = new RegExp(`${MESSAGE_START}(?:email|e-mail|mail|reply|respond|message|text|send|notify|tell|ask|answer|follow up with|get back to)\\b(?!\\s+me\\b)`);
const WRITING_RE = new RegExp(`${MESSAGE_START}(?:draft|write|compose)\\b`);
/** "Can we move ...?", "Could you ...?", "Is it possible to ...?": a request in the form of a question. */
const POLITE_ASK_RE = new RegExp(`^(?:${FILLER},?\\s+){0,3}(?:(?:can|could|would|will|shall|may) (?:you|we|i)|is it possible to|would it be possible to)\\b`);
/** "Create a summary of my inbox", "Make a list of my unread emails": text in the chat, not an entry or an email. */
const TEXT_REQUEST_RE = new RegExp(`${MESSAGE_START}(?:create|make|write|draft|compose|give|show|prepare|put together)\\s+(?:me\\s+)?(?:an?\\s+|the\\s+)?(?:short\\s+|quick\\s+|brief\\s+)?(?:summary|summaries|list|overview|digest|recap|report|breakdown|outline)\\b`);
/** "Remind me what is on tomorrow", "Remind me when ...": a question. */
const REMIND_QUESTION_RE = new RegExp(`${MESSAGE_START}remind\\s+(?:me|us)\\s+(?:what|when|where|who|whom|which|how|if|whether|why)\\b`);
/** Verbs that are also nouns: "Email summary, please", "Mail from today", "Reply from the recruiter yet". */
const NOUN_USE_OUTBOUND_RE = new RegExp(`${MESSAGE_START}(?:email|e-mail|mail|message|reply|text|answer)s?\\s+(?:from|summary|summaries|count|list|overview|status|yet|today|about|of)\\b`);
/** "Confirm that I have no meetings on Friday": a question. */
const CHECK_THAT_RE = new RegExp(`${MESSAGE_START}(?:confirm|check|verify)\\s+(?:that|whether|if)\\b`);
/** A reminder that is asked for: "remind me to ...", "set a reminder", "a reminder for 5 pm". */
const REMINDER_RE = /\bremind\s+(?:me|us|him|her|them|[a-z]+)\s+(?:to|about|of|at|on|in|that|tomorrow|today|tonight|before|after)\b|\b(?:set|add|create|make|schedule|put)\s+(?:up\s+)?(?:an?|the|another)\s+(?:[a-z-]+\s+)?(?:reminder|alarm)\b|\breminder\s+(?:for|to|at|on|about)\b/;
/** "Extend the lecture to 1 pm", "Rename the team sync", "Update my dentist appointment". */
const EDIT_RE = new RegExp(`${CLAUSE_START}(?:extend|shorten|lengthen|prolong|rename|retitle|update|edit|swap|bump)\\b\\s+${DEFINITE}\\b`);
const MAIL_WORDS_RE = /\b(?:e-?mails?|mail|repl(?:y|ies)|responses?|messages?|texts?|invites?|invitations?|notes?\s+to)\b|\b(?:write|draft|compose)\s+(?:back\s+)?to\b/;
/** "Put the lecture on my calendar for Friday at 10 am", "Add it to my schedule": a request to add something. */
const ADD_TO_CALENDAR_RE = /\b(?:put|set|add|enter|get|place|pop)\b[^.;!?]*\b(?:in|on|into|onto|to)\s+(?:my|the|our)\s+(?:calendar|schedule|agenda|diary|planner)\b/;
/**
 * push / shift / delay / change / drop at the start of a clause without a definite object: a noun
 * or another verb ("Push workout tomorrow", "Change of plans", "Drop off the dry cleaning").
 */
const NOUN_USE_RE = new RegExp(`${CLAUSE_START}(?:push|shift|delay|change|drop)\\b(?!\\s+(?:(?:back|forward|ahead)\\s+)?${DEFINITE}\\b)`, "g");
/**
 * Where a request's clause ends: "Move the dentist to 5 pm and block 3-5 pm tomorrow for the
 * gym" names the destination "5 pm" only, and "Remove the gym session from my plan and block
 * ..." the subject "the gym session from my plan". A full stop after an abbreviation ("Nov. 13",
 * "Dr. Lee") does not end it.
 */
const NEXT_CLAUSE_RE =
  /(?:[;!?]\s+|(?<!\b(?:jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec|dr|mr|mrs|ms|prof|st|approx|ca|[a-z]))\.\s+|,\s*(?:and\s+|then\s+|also\s+|but\s+)?(?=(?:please\s+)?(?:block|schedule|add|book|create|make|plan|set|put|move|cancel|delete|remove|draft|write|reply|remind|email|reschedule|postpone|push|shift|change|bring|pull|drop|call|text|find|show|tell|check|what|when|how)\b)|\s(?:and|then|but|also|and then)\s+(?=(?:please\s+)?(?:block|schedule|add|book|create|make|plan|set|put|move|cancel|delete|remove|draft|write|reply|remind|email|reschedule|postpone|push|shift|change|bring|pull|drop|call|text|find|show|tell|check)\b))/;
/**
 * Where the reason for a request starts: in "Move the dentist appointment to Friday because I
 * have a lecture on Wednesday at 4 pm" the new time is not 4 pm, and in "... to Friday so that it
 * doesn't clash with the lecture at 10 am" it is not 10 am. The request is read up to there.
 */
const REASON_RE =
  /\s(?:because|since|so|if|unless|when|while|although|though|but|due to|in case|otherwise|or else|as (?:i|we|it|there|he|she|they|my|the))\s|,\s*(?:it|i|we|that|which|she|he|they|there)\b/;

function cutAtNextClause(text: string): string {
  const next = NEXT_CLAUSE_RE.exec(text);
  const clause = next ? text.slice(0, next.index) : text;
  const reason = REASON_RE.exec(clause);
  return reason ? clause.slice(0, reason.index) : clause;
}

interface ChangeVerb {
  index: number;
  length: number;
  verb: string;
  kind: "move" | "cancel";
  certainty: ChangeRequest["certainty"];
}

/**
 * The move and cancel verbs that start a change request, in the order they appear (see the verb
 * lists above). A verb that is the content of a new item is not one: "Add a reminder: cancel the
 * team sync", "Reminder: move the car".
 */
function findChangeVerbs(text: string): ChangeVerb[] {
  const found: ChangeVerb[] = [];
  for (const [re, kind, clear, weak] of [
    [CANCEL_RE, "cancel", CLEAR_CANCEL_VERBS, WEAK_CANCEL_VERBS],
    [MOVE_RE, "move", CLEAR_MOVE_VERBS, WEAK_MOVE_VERBS],
  ] as const) {
    re.lastIndex = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      const verb = m[1].replace(/\s+/g, " ");
      const after = text.slice(m.index + m[0].length);
      const certainty = (clear as readonly string[]).includes(verb)
        ? "clear"
        : (weak as readonly string[]).includes(verb)
          ? "weak"
          : MODEL_MOVE_VERBS.includes(verb)
            ? "model"
            : "exact";
      if (NEEDS_DEFINITE_OBJECT.has(verb) && !DEFINITE_OBJECT.test(after)) continue;
      // "Move on to the next task", "Move forward with the prep", "Postpone nothing": no object to change.
      if (/^\s*(?:nothing|none|no\b|on\b|over\b|out\b|along\b|away\b|in\b|(?:forward|ahead)\s+with\b)/.test(after)) continue;
      // "Put the lecture on my calendar for Friday": adding to the calendar, not moving.
      if (certainty === "model" && ADD_TO_CALENDAR_RE.test(`${verb} ${cutAtNextClause(after)}`)) continue;
      // "Bring my laptop to the team sync": only "bring/pull ... forward" (or back) moves an event.
      if ((verb === "bring" || verb === "pull") && !/\b(?:forward|earlier|ahead|back|later)\b/.test(cutAtNextClause(after))) continue;
      // The text of a new item or of a message to write: after a colon in a sentence that creates
      // or writes something ("Add a reminder: cancel the team sync", "Email Sam: cancel lunch").
      const lead = text.slice(0, m.index + m[0].length - m[1].length);
      const sentence = lead.slice(Math.max(lead.lastIndexOf(". "), lead.lastIndexOf("! "), lead.lastIndexOf("? "), lead.lastIndexOf("; ")) + 1).trim();
      if (
        /:\s*(?:[a-z']+,?\s+){0,4}$/.test(`${sentence} `) &&
        (COMMUNICATE_RE.test(sentence) ||
          /\b(?:reminders?|to-?dos?|tasks?|notes?)\s*:/.test(sentence) ||
          (CREATE_RE.test(sentence) && /\b(?:reminder|task|to-?do|note|event|block|meeting|call|appointment|item|entry|alarm)s?\b/.test(sentence)))
      ) {
        continue;
      }
      // What a reminder or task is about: "Remind me to call mom and cancel the team sync".
      if (/\b(?:remind\w*|tasks?|to-?dos?|notes?)\b[^.;!?]*\bto\s|\b(?:don't forget|remember) to\b/.test(sentence)) continue;
      found.push({ index: m.index, length: m[0].length, verb: verb === "put off" ? "postpone" : verb, kind, certainty });
    }
  }
  return found.sort((a, b) => a.index - b.index || (a.kind === "cancel" ? -1 : 1));
}
/** Words that make a message about the calendar even when no event title matches. */
const CALENDAR_WORDS_RE =
  /\b(event|appointment|meeting|sync|lecture|class|session|call|interview|lunch|dinner|breakfast|workout|gym|run|block|stand-?up|calendar|dentist|doctor)\b/;

/** Words that never identify an event. */
const STOP_WORDS = new Set([
  "the", "a", "an", "my", "our", "your", "this", "that", "these", "those", "it", "its", "me", "i", "we",
  "to", "at", "on", "in", "for", "from", "of", "with", "by", "and", "or", "please", "can", "could",
  "would", "will", "you", "kindly", "just", "also", "event", "calendar", "time", "slot", "start",
  "starting", "begin", "same", "day", "today", "tonight", "tomorrow", "am", "pm", "move", "moving",
  "reschedule", "push", "shift", "postpone", "delay", "bring", "pull", "change", "put", "set",
  "cancel", "delete", "remove", "call off", "scrap", "drop", "back", "forward", "later", "earlier",
  "one", "next", "coming", "s", "o'clock", "oclock", "up", "off", "is", "be", "so", "that's",
]);

/** Lowercase, plain dashes and apostrophes, "p.m." -> "pm", single spaces, no final punctuation. */
export function normalizeRequest(message: string): string {
  return (message ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[‐-―−]/g, "-")
    .replace(/[‘’ʼ]/g, "'")
    .replace(/\b([ap])\.\s?m\b\.?/g, "$1m")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.!?]+$/, "");
}

/** Title words: lowercase letters and digits, 2+ characters, simple plural "s" removed. */
export function titleWords(text: string): string[] {
  const words = (text ?? "").toLowerCase().normalize("NFKD").match(/[a-z0-9]+/g) ?? [];
  return words
    .filter((word) => word.length >= 2 && !STOP_WORDS.has(word))
    .map((word) => (word.length > 3 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word));
}

const NUMBER_WORDS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, half: 0.5 };

function amountToMinutes(amount: string, unit: string): number | undefined {
  const value = /^\d+(\.\d+)?$/.test(amount) ? Number(amount) : NUMBER_WORDS[amount.replace(/ an?$/, "")];
  if (value === undefined || !Number.isFinite(value)) return undefined;
  return Math.round(/^h/.test(unit) ? value * 60 : value);
}

function to24(hour: number, minute: number, meridiem: "am" | "pm"): number {
  return ((hour % 12) + (meridiem === "pm" ? 12 : 0)) * 60 + minute;
}

function validClock(hour: number, minute: number): boolean {
  return Number.isInteger(hour) && hour >= 0 && hour <= 24 && minute >= 0 && minute <= 59 && !(hour === 24 && minute > 0);
}

/** A clock time without am/pm: 24-hour when it can only be that ("16:00", "09:30"), else both. */
function bareClock(hourText: string, minute: number): number[] {
  const hour = Number(hourText);
  if (hour >= 13 || hour === 0 || (hourText.length === 2 && hourText.startsWith("0"))) return [hour * 60 + minute];
  if (hour === 12) return [12 * 60 + minute];
  return [hour * 60 + minute, (hour + 12) * 60 + minute];
}

/** Day words in a text, resolved against today's local date (and its weekday, 0 = Sunday). */
export function parseDay(text: string, today: string, opts: { subject?: boolean } = {}): { day?: DayRef | "same"; rest: string } {
  let rest = text;
  const take = (re: RegExp): RegExpExecArray | null => {
    const m = re.exec(rest);
    if (m) rest = `${rest.slice(0, m.index)} ${rest.slice(m.index + m[0].length)}`;
    return m;
  };
  const todayWeekday = new Date(`${today}T12:00:00Z`).getUTCDay();

  let m = take(/\b(?:on |for )?(?:the )?same day\b/);
  if (m) return { day: "same", rest };
  // "A week from tomorrow", "two weeks from today", "tomorrow week": a date, counted from today.
  m = take(/\b(?:on |for )?(a|one|two|three|four|five|six|\d) weeks? from (today|tomorrow|now)\b/);
  if (m) {
    const days = 7 * (WEEK_COUNT[m[1]] ?? Number(m[1])) + (m[2] === "tomorrow" ? 1 : 0);
    return { day: { dates: [addDaysISO(today, days)], text: m[0].trim(), exact: true }, rest };
  }
  m = take(/\b(?:on |for )?(today|tomorrow) week\b/);
  if (m) return { day: { dates: [addDaysISO(today, 7 + (m[1] === "tomorrow" ? 1 : 0))], text: m[0].trim(), exact: true }, rest };
  m = take(/\b(?:on |for )?(?:the )?day after tomorrow('s)?\b/);
  if (m) return { day: { dates: [addDaysISO(today, 2)], text: m[0].trim(), exact: true }, rest };
  m = take(/\b(?:for |on )?(today|tonight|this (?:morning|afternoon|evening))('s)?\b/);
  if (m) return { day: { dates: [today], text: m[0].trim(), exact: true }, rest };
  m = take(/\b(?:for |on )?tomorrow('s)?\b/);
  if (m) return { day: { dates: [addDaysISO(today, 1)], text: m[0].trim(), exact: true }, rest };
  // Days that are over: as a destination they get a question back, not this week's day (QA
  // round 5: "to yesterday at 3 pm" kept the event's own day).
  m = take(/\b(?:on |for )?(?:the )?day before yesterday('s)?\b/);
  if (m) return { day: { dates: [addDaysISO(today, -2)], text: m[0].trim(), past: true }, rest };
  m = take(/\b(?:for |on )?yesterday('s)?\b/);
  if (m) return { day: { dates: [addDaysISO(today, -1)], text: m[0].trim(), past: true }, rest };
  m = take(/\b(a|one|two|three|four|five|six|\d{1,2}) days? ago\b/);
  if (m) return { day: { dates: [addDaysISO(today, -(WEEK_COUNT[m[1]] ?? Number(m[1])))], text: m[0].trim(), past: true }, rest };
  // A date, maybe with its weekday ("Tuesday the 17th", "Fri, Nov 13"). A weekday that is not
  // the date's leaves two readings, so the user is asked which one is meant.
  const dated = (date: string, weekday: string | undefined, text: string): DayRef => {
    if (!weekday || new Date(`${date}T12:00:00Z`).getUTCDay() === WEEKDAYS[weekday]) return { dates: [date], text, exact: true };
    return { dates: [...new Set([date, addDaysISO(today, (WEEKDAYS[weekday] - todayWeekday + 7) % 7)])], text, exact: true };
  };
  const validDate = (date: string) => {
    const parsed = new Date(`${date}T12:00:00Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
  };
  m = take(new RegExp(`\\b(?:${WEEKDAY_RE},? )?(\\d{4})-(\\d{2})-(\\d{2})\\b`));
  if (m && validDate(`${m[2]}-${m[3]}-${m[4]}`)) return { day: dated(`${m[2]}-${m[3]}-${m[4]}`, m[1], m[0].trim()), rest };
  const dayMonth = take(new RegExp(`\\b(?:on |for )?(?:${WEEKDAY_RE},? )?(?:the )?(\\d{1,2})(?:st|nd|rd|th)?(?: of)? ${MONTH_RE}\\b`));
  const monthDay = dayMonth ? null : take(new RegExp(`\\b(?:on |for )?(?:${WEEKDAY_RE},? )?${MONTH_RE}\\.? (\\d{1,2})(?:st|nd|rd|th)?\\b`));
  m = dayMonth ?? monthDay;
  if (m) {
    const dayNumber = Number(dayMonth ? m[2] : m[3]);
    const month = MONTHS[(dayMonth ? m[3] : m[2]).slice(0, 3)];
    let year = Number(today.slice(0, 4));
    const candidate = (y: number) => `${y}-${String(month).padStart(2, "0")}-${String(dayNumber).padStart(2, "0")}`;
    if (month && dayNumber >= 1 && dayNumber <= 31) {
      // A date more than half a year back means next year ("Jan 5" asked in November).
      if (Date.parse(`${candidate(year)}T12:00:00Z`) < Date.parse(`${today}T12:00:00Z`) - 180 * 86_400_000) year += 1;
      if (validDate(candidate(year))) return { day: dated(candidate(year), m[1], m[0].trim()), rest };
    }
  }
  // "the 13th", "Tuesday the 17th": the next such day of the month (not "the 2nd lecture").
  m = take(new RegExp(`\\b(?:on |for )?(?:${WEEKDAY_RE},? (?:the )?|the )(\\d{1,2})(?:st|nd|rd|th)\\b(?=\\s*(?:$|,|at\\b|from\\b|to\\b|\\d))`));
  if (m) {
    const dayNumber = Number(m[2]);
    const [year, month, todayNumber] = today.split("-").map(Number);
    const inMonth = (y: number, mo: number) => `${mo > 12 ? y + 1 : y}-${String(mo > 12 ? 1 : mo).padStart(2, "0")}-${String(dayNumber).padStart(2, "0")}`;
    const date = dayNumber >= todayNumber ? inMonth(year, month) : inMonth(year, month + 1);
    if (dayNumber >= 1 && validDate(date)) return { day: dated(date, m[1], m[0].trim()), rest };
  }
  // A weekday with a week named next to it: "Friday next week", "next week on Friday", "Thursday
  // of next week", "a week from Friday", "Friday week", "Friday in two weeks", "Friday after
  // next", and a weekday that is over ("last Friday", "Friday last week"). Until QA round 5 the
  // week was not read and this week's day was proposed, also over a correct model answer. Weeks
  // start on Monday.
  // A week or a past day that is only compared with or given as a reason says nothing about the
  // day that is asked for: "this Friday instead of next week", "Friday, not next week", "Friday
  // as next week is full", "Saturday, same as last Saturday", "tomorrow like last week" (review
  // of 11 Nov 2026: the first three gave a card for the wrong week, the fourth "already over").
  rest = rest.replace(
    new RegExp(`,?\\s*\\b(?:instead of|rather than|not|unlike|same as|just like|like|as|because|since|than)\\s+(?:(?:in|on|during)\\s+)?(?:the\\s+)?(?:(?:next|following|coming|last|previous|this)\\s+(?:week|month)|(?:last|next|this)\\s+${WEEKDAY_RE})\\b[^,.;]*`, "g"),
    " ",
  );
  // "The last Friday of the month", "Friday in the last week of November": a date the rules do
  // not work out. It gets a question back, not "last Friday is already over".
  m = take(new RegExp(`\\b(?:on |for )?(?:the )?(?:first|second|third|fourth|last) (?:${WEEKDAY_RE}|week) (?:of|in) (?:the |this |next )?(?:month|${MONTH_RE})\\b`));
  if (m) {
    take(new RegExp(`\\b(?:on |for )?(?:the )?${WEEKDAY_RE}\\b(?: (?:of|in|during)\\b)?`));
    return { day: { dates: [today], text: m[0].trim(), unclear: true }, rest };
  }
  const weekdayAt = new RegExp(`\\b${WEEKDAY_RE}\\b`).exec(rest);
  // "This Friday" names this week's day, whatever else the message says about weeks.
  if (weekdayAt && !new RegExp(`\\bthis ${weekdayAt[1]}\\b`).test(rest)) {
    const weekday = WEEKDAYS[weekdayAt[1]];
    const inWeek = (weekday + 6) % 7; // days after Monday
    const thisMonday = addDaysISO(today, -((todayWeekday + 6) % 7));
    const delta = (weekday - todayWeekday + 7) % 7; // days to the next such weekday (0 = today)
    const weekdayWords = `(?:on |for )?(?:the )?(?:(?:this|next|coming) )?${WEEKDAY_RE}('s)?`;
    // The weekday and the week together: "Friday week", "Friday after next", "last Friday". In
    // the words that name the event to move, "the Friday week in review" is a title.
    let both = opts.subject ? null : take(new RegExp(`\\b(?:on |for )?(?:the )?${WEEKDAY_RE} week\\b`));
    if (both) {
      // Said on that weekday itself, "Friday week" can be a week or two weeks on: the user is asked.
      const dates = delta === 0 ? [addDaysISO(today, 7), addDaysISO(today, 14)] : [addDaysISO(today, delta + 7)];
      return { day: { dates, text: both[0].trim() }, rest };
    }
    both = take(new RegExp(`\\b(?:on |for )?(?:the )?${WEEKDAY_RE} after next\\b`));
    if (both) return { day: { dates: [addDaysISO(today, (delta === 0 ? 7 : delta) + 7)], text: both[0].trim() }, rest };
    both = take(new RegExp(`\\b(?:on |for )?(?:last|this past|the past|previous) ${WEEKDAY_RE}('s)?\\b`));
    if (both) return { day: { dates: [addDaysISO(today, -((todayWeekday - weekday + 7) % 7 || 7))], text: both[0].trim(), past: true }, rest };
    // The week on its own, before or after the weekday.
    let dates: string[] | undefined;
    let past = false;
    let week: RegExpExecArray | null;
    if ((week = take(/\b(?:(?:of|in|during) )?(?:the )?week after next\b/))) dates = [addDaysISO(thisMonday, 14 + inWeek)];
    else if ((week = take(/\b(?:(?:of|in|during) )?(?:the )?(?:next|following|coming) week('s)?\b/))) dates = [addDaysISO(thisMonday, 7 + inWeek)];
    else if ((week = take(/\b(?:(?:of|in|during) )?(?:the )?(?:last|previous|past) week('s)?\b/))) {
      dates = [addDaysISO(thisMonday, inWeek - 7)];
      past = true;
    } else if ((week = take(/\b(?:(?:of|in|during) )?(?:this|the current) week('s)?\b/))) {
      // "Friday this week": this week's Friday, over or not ("Monday this week" said on a Wednesday).
      dates = [addDaysISO(thisMonday, inWeek)];
      past = dates[0] < today;
    } else if ((week = take(/\b(?:in|after) (a|one|two|three|four|five|six|\d) weeks?(?: time)?\b/))) {
      // "Friday in two weeks", "in two weeks on Monday": the Friday of the week two weeks on, or
      // two weeks after the next Friday. They differ when that weekday of this week is already
      // over; then the user is asked.
      const n = WEEK_COUNT[week[1]] ?? Number(week[1]);
      dates = [...new Set([addDaysISO(thisMonday, 7 * n + inWeek), addDaysISO(today, delta + 7 * n)])];
    } else if ((week = take(/\b(a|one|two|three|four|five|six|\d) weeks? (?:from|after|on)\b/))) {
      // "A week from Friday": the next Friday, plus the weeks.
      dates = [addDaysISO(today, delta + 7 * (WEEK_COUNT[week[1]] ?? Number(week[1])))];
    }
    if (dates && week) {
      const named = take(new RegExp(`\\b${weekdayWords}\\b(?: (?:of|in|on)\\b)?`));
      return { day: { dates, text: `${named?.[0].trim() ?? weekdayAt[1]} ${week[0].trim()}`, ...(past ? { past } : {}) }, rest };
    }
  }
  m = take(new RegExp(`\\b(?:on |for )?(?:the )?(?:(this|next|coming|following) )?${WEEKDAY_RE}('s)?\\b`));
  if (m) {
    const weekday = WEEKDAYS[m[2]];
    const delta = (weekday - todayWeekday + 7) % 7;
    // "The following Friday" is read like "next Friday": this week's or next week's.
    const which = m[1] === "following" ? "next" : m[1];
    let dates: string[];
    if (which === "next") dates = delta === 0 ? [addDaysISO(today, 7)] : [addDaysISO(today, delta), addDaysISO(today, delta + 7)];
    else if (which === "this" || which === "coming") dates = [addDaysISO(today, delta === 0 && which === "coming" ? 7 : delta)];
    else dates = delta === 0 ? [today, addDaysISO(today, 7)] : [addDaysISO(today, delta)];
    return { day: { dates, text: m[0].trim() }, rest };
  }
  return { rest };
}

/** Clock words in a destination text: a range, a start, an end, a duration or a shift. */
export function parseClock(text: string): {
  start?: ClockRef;
  end?: ClockRef;
  endOnly?: boolean;
  durationMin?: number;
  shiftMin?: number;
  shiftDirectionMissing?: boolean;
  rest: string;
} {
  let rest = ` ${text} `;
  const take = (re: RegExp): RegExpExecArray | null => {
    const m = re.exec(rest);
    if (m) rest = `${rest.slice(0, m.index)} ${rest.slice(m.index + m[0].length)}`;
    return m;
  };
  const out: ReturnType<typeof parseClock> = { rest: "" };

  // Duration: "for an hour", "for 90 minutes", "for 1.5 hours", "for half an hour".
  const duration = take(/\bfor (\d+(?:\.\d+)?|an?|one|two|three|four|half an?) ?(hours?|hrs?|h|minutes?|mins?|m)\b/);
  if (duration) out.durationMin = amountToMinutes(duration[1], duration[2]);

  // Shift: "an hour later", "30 minutes earlier", "back by an hour", "forward 30 minutes".
  const shift =
    take(/\b(?:(back|forward|ahead) )?(?:by )?(\d+(?:\.\d+)?|an?|one|two|three|half an?) ?(hours?|hrs?|minutes?|mins?)(?: (later|earlier|back|forward|ahead))?\b/);
  if (shift) {
    const minutes = amountToMinutes(shift[2], shift[3]);
    const direction = shift[4] ?? shift[1];
    if (minutes !== undefined && direction) {
      out.shiftMin = /later|back/.test(direction) ? minutes : -minutes;
    } else if (minutes !== undefined) {
      out.shiftMin = minutes;
      out.shiftDirectionMissing = true;
    }
  }

  rest = rest.replace(/\bnoon\b|\bmidday\b/g, "12:00 pm").replace(/\bmidnight\b/g, "12:00 am");
  const endOnlyWords = /\b(?:end(?:s|ing)?|finish(?:es|ing)?|until|till|wrap(?:s)? up)(?: at)? $/;

  // Range: "4-5:30 pm", "4 pm to 5:30 pm", "between 2 and 4 pm", "14:00-15:30".
  const range =
    take(/\bbetween (\d{1,2})(?::(\d{2}))? ?(am|pm)? ?and ?(\d{1,2})(?::(\d{2}))? ?(am|pm)?\b(?! ?(?:hours?|hrs?|minutes?|mins?))/) ??
    take(/\b(?:from )?(\d{1,2})(?::(\d{2}))? ?(am|pm)? ?(?:-|to|until|till) ?(\d{1,2})(?::(\d{2}))? ?(am|pm)?\b(?! ?(?:hours?|hrs?|minutes?|mins?))/);
  if (range) {
    const h1 = Number(range[1]);
    const m1 = Number(range[2] ?? 0);
    const h2 = Number(range[4]);
    const m2 = Number(range[5] ?? 0);
    const ap1 = range[3] as "am" | "pm" | undefined;
    const ap2 = range[6] as "am" | "pm" | undefined;
    if (validClock(h1, m1) && validClock(h2, m2)) {
      let starts: number[];
      let ends: number[];
      if (ap1 && ap2) {
        starts = [to24(h1, m1, ap1)];
        ends = [to24(h2, m2, ap2)];
      } else if (ap2) {
        const e = to24(h2, m2, ap2);
        let s = to24(h1, m1, ap2);
        if (s >= e) s = to24(h1, m1, ap2 === "pm" ? "am" : "pm");
        starts = [s];
        ends = [e];
      } else if (ap1) {
        const s = to24(h1, m1, ap1);
        let e = to24(h2, m2, ap1);
        if (e <= s) e = to24(h2, m2, ap1 === "am" ? "pm" : "am");
        starts = [s];
        ends = [e];
      } else {
        // No am/pm at all: 24-hour when it can only be that, else both readings in pairs.
        const s = bareClock(range[1], m1);
        const e = bareClock(range[4], m2);
        if (s.length === 1 && e.length === 1) {
          starts = s;
          ends = e;
        } else if (s.length === 1) {
          starts = s;
          ends = [e.find((value) => value > s[0]) ?? e[e.length - 1]];
        } else if (e.length === 1) {
          ends = e;
          starts = [[...s].reverse().find((value) => value < e[0]) ?? s[0]];
        } else {
          starts = s;
          ends = e;
        }
      }
      out.start = { minutes: starts, text: range[0].trim() };
      out.end = { minutes: ends, text: range[0].trim() };
    }
  }

  if (!out.start) {
    // A single time with am/pm: "4 pm", "at 4:30pm", "start at 4 pm".
    let single = /\b(?:at |@ ?|by |around )?(\d{1,2})(?::(\d{2}))? ?(am|pm)\b/.exec(rest);
    let minutes: number[] | undefined;
    if (single && validClock(Number(single[1]), Number(single[2] ?? 0))) {
      minutes = [to24(Number(single[1]), Number(single[2] ?? 0), single[3] as "am" | "pm")];
    } else {
      // "16:00", "9:30" (am or pm unknown), or a bare hour after "at"/"to": "at 4".
      single = /\b(\d{1,2}):(\d{2})\b/.exec(rest) ?? /(?:^|\s)(?:at|to|for|around|@) ?(\d{1,2})(?!\d|:| ?(?:hours?|hrs?|minutes?|mins?|days?|weeks?|people|st|nd|rd|th))\b/.exec(rest) ?? /^\s*(\d{1,2})\s*$/.exec(rest);
      if (single && validClock(Number(single[1]), Number(single[2] ?? 0))) {
        minutes = bareClock(single[1], Number(single[2] ?? 0));
      }
    }
    if (single && minutes) {
      const before = rest.slice(0, single.index + (single[0].match(/^\s/) ? 1 : 0));
      if (endOnlyWords.test(before)) out.endOnly = true;
      rest = `${rest.slice(0, single.index)} ${rest.slice(single.index + single[0].length)}`;
      out.start = { minutes, text: single[0].trim() };
    }
  }
  out.rest = rest.replace(/\s+/g, " ").trim();
  return out;
}

/**
 * Read a chat message as a request to move or cancel an existing event. Returns null when it is
 * not one (no move/cancel verb), whatever else it asks for.
 */
export function parseChangeRequest(message: string, today: string): ChangeRequest | null {
  const text = normalizeRequest(message);
  // The first request that names something; "Cancel that and move the dentist appointment to
  // Friday" is about the dentist appointment.
  const requests = findChangeVerbs(text).map((verb) => readChangeRequest(text, verb, today));
  return requests.find((request) => request.subjectWords.length > 0 || request.sourceDay || request.sourceClock) ?? requests[0] ?? null;
}

function readChangeRequest(text: string, verb: ChangeVerb, today: string): ChangeRequest {

  // Where the destination starts: the first " to " (or "at" after move/change) after the verb
  // that is followed by a time, a day or "start"/"end"; or a shift phrase ("an hour later").
  // "so it starts at 4 pm" is a destination ("to start at 4 pm"), not a reason.
  let afterVerb = cutAtNextClause(
    text.slice(verb.index + verb.length).replace(/\bso (?:that )?it (start|begin|end|finish)(?:s|es)?\b/g, "to $1"),
  );
  // A particle right after the verb ("push back the team sync an hour", "bring forward the
  // lecture") gives the direction, it is not part of the event's name.
  let particle = "";
  const leading = /^\s*(back|forward|ahead)\s+/.exec(afterVerb);
  if (leading) {
    particle = leading[1];
    afterVerb = ` ${afterVerb.slice(leading[0].length)}`;
  }
  // Also the words for another week and for days that are over ("to a week from Friday", "to
  // Friday week", "to yesterday", "to last Friday"): without them the day stayed in the
  // subject and was read as the day of the event to move (QA round 5).
  // After "to" only, and only next to a day or week word: "the review for Last mile" and "the
  // Next steps meeting" are names (review of 11 Nov 2026: " for last" started a destination).
  const baseWords = `start|begin|end|finish|the same day|same day|the \\d|today|tonight|tomorrow|the day after|next|this|coming|on |noon|midday|midnight|\\d|${WEEKDAY_RE}\\b|${MONTH_RE}\\b`;
  const weekWords = `the day before|yesterday|(?:last|previous|this past) (?:${WEEKDAY_RE}|week)\\b|the week after|the following|following (?:${WEEKDAY_RE}|week)\\b|(?:a|one|two|three|four|five|six) (?:weeks?|days?)\\b|in (?:a|one|two|three|four|five|six|\\d)\\b|the ${WEEKDAY_RE}\\b|the (?:first|second|third|fourth|last) (?:${WEEKDAY_RE}|week)\\b`;
  const destinationWords = `(?=(?:${baseWords}))`;
  // "to"/"until"/"for" first; "at" only when there is none ("move the 3 pm meeting at ... to 4 pm"
  // names the old time with "at").
  const destStart = new RegExp(`\\s(?:(?:to|for|until|till)\\s${destinationWords}|to\\s(?=(?:${weekWords})))`);
  const atStart = new RegExp(`\\sat\\s${destinationWords}`);
  const shiftAnywhere = /\b(?:back|forward|ahead|later|earlier)\b|\b(?:by )?(?:\d+(?:\.\d+)?|an?|one|two|half an?) ?(?:hours?|hrs?|minutes?|mins?) (?:later|earlier|back|forward)\b/;

  let subject = afterVerb;
  let destination = "";
  // A cancel has no destination: "Delete the team sync for tomorrow" names WHICH team sync.
  // "on Friday" is the destination only when nothing else is ("Put the dentist appointment on
  // Friday"); in "Move the dentist appointment on Wednesday to 4 pm" it names the event.
  const onStart = new RegExp(`\\son\\s(?=(?:the )?(?:\\d|${WEEKDAY_RE}\\b|${MONTH_RE}\\b))`);
  const split =
    verb.kind === "cancel"
      ? null
      : destStart.exec(afterVerb) ??
        (/^(put|set|move|change)$/.test(verb.verb) ? atStart.exec(afterVerb) : null) ??
        (/^(put|set|move|reschedule|re-schedule|shift)$/.test(verb.verb) ? onStart.exec(afterVerb) : null);
  if (split) {
    subject = afterVerb.slice(0, split.index);
    // "Move the lecture until 1 pm" changes its end; "Postpone the team sync until 9 pm" its start.
    const untilIsEnd = !/^(postpone|delay|push|prepone|bring|pull)$/.test(verb.verb);
    destination = afterVerb.slice(split.index).replace(/^\s(?:to|for|until|till|at)\s/, (word) => (untilIsEnd && /until|till/.test(word) ? " until " : " "));
  } else if (verb.kind === "move") {
    // "Postpone the team sync by 30 minutes", "push back the team sync an hour": the verb gives
    // the direction, the rest the amount.
    const directional = Boolean(particle) || /^(push|delay|postpone|bring|pull|prepone)$/.test(verb.verb);
    const shift =
      shiftAnywhere.exec(afterVerb) ??
      (directional ? /\b(?:by )?(?:\d+(?:\.\d+)?|an?|one|two|half an?) ?(?:hours?|hrs?|minutes?|mins?)\b/.exec(afterVerb) : null);
    if (shift) {
      subject = afterVerb.slice(0, shift.index);
      destination = afterVerb.slice(shift.index);
    }
  }
  if (verb.kind === "move") {
    if (particle && !/\b(later|earlier|back|forward|ahead)\b/.test(destination)) destination += ` ${particle}`;
    // "push ... back" / "bring ... forward" name the direction with the verb.
    if (/^(push|delay|postpone)$/.test(verb.verb) && !/\b(later|earlier|back|forward|ahead)\b/.test(destination)) destination += " later";
    if (/^(bring|pull|prepone)$/.test(verb.verb) && !/\b(later|earlier|back|forward|ahead)\b/.test(destination)) destination += " earlier";
  }

  const kind: ChangeRequest["kind"] = verb.kind;

  // The subject may say which occurrence: "the dentist appointment on Wednesday", "the 3 pm meeting".
  const source = parseDay(subject, today, { subject: true });
  let subjectRest = source.rest;
  let sourceClock: ClockRef | undefined;
  const sourceTime = /\b(?:at |from )?(\d{1,2})(?::(\d{2}))? ?(am|pm)\b|\b(\d{1,2}):(\d{2})\b/.exec(subjectRest);
  if (sourceTime) {
    const minutes = sourceTime[3]
      ? [to24(Number(sourceTime[1]), Number(sourceTime[2] ?? 0), sourceTime[3] as "am" | "pm")]
      : bareClock(sourceTime[4], Number(sourceTime[5]));
    sourceClock = { minutes, text: sourceTime[0] };
    subjectRest = `${subjectRest.slice(0, sourceTime.index)} ${subjectRest.slice(sourceTime.index + sourceTime[0].length)}`;
  }
  subjectRest = subjectRest.replace(/\b(?:the time of|the date of|time of)\b/g, " ").replace(/\s+/g, " ").trim();

  const request: ChangeRequest = {
    kind,
    certainty: verb.certainty,
    subject: subjectRest,
    subjectWords: titleWords(subjectRest),
    sourceDay: source.day && source.day !== "same" ? source.day : undefined,
    sourceClock,
  };
  if (kind === "cancel") return request;

  const dest = parseDay(destination, today);
  const clock = parseClock(dest.rest);
  if (clock.start && clock.start.minutes.length === 2 && !clock.end) {
    // "tomorrow morning at 7" is 7 AM, "this evening at 8" is 8 PM.
    const half = /\bmorning\b/.test(destination) ? "am" : /\b(?:afternoon|evening)\b/.test(destination) ? "pm" : null;
    if (half) clock.start = { ...clock.start, minutes: clock.start.minutes.filter((minutes) => (half === "am" ? minutes < 720 : minutes >= 720)) };
  }
  request.day = dest.day;
  request.start = clock.start;
  request.end = clock.end;
  request.endOnly = clock.endOnly || (/\buntil\b/.test(destination) && !clock.end ? Boolean(clock.start) : false);
  request.durationMin = clock.durationMin;
  if (clock.shiftMin !== undefined && !clock.shiftDirectionMissing && !clock.start) request.shiftMin = clock.shiftMin;
  const leftover = clock.rest.replace(/\b(start(?:s|ing)?|begin(?:s|ning)?|at|on|the|it|instead|please|so|that|later|earlier|back|forward|ahead|o'?clock|sharp)\b/g, " ");
  request.vagueTime =
    /\b(morning|afternoon|evening|night|week|weekend|month|after|before|asap|soon|sometime|free)\b/.test(leftover) ||
    (clock.shiftDirectionMissing ?? false);
  // A day was read, but week or month words next to it were not ("Friday next month", "Friday
  // two weeks later"): the date is unknown.
  // A week named without a day: "to next week", "to the same day next week", "to the week after
  // next at 3 pm". The event keeps its weekday when a time or "same day" is given; with the week
  // alone, the model's day counts only if it lies in that week, else MONDAY asks which day (the
  // review of 11 Nov 2026 saw a model answer for THIS week accepted for "to next week").
  if (request.day === undefined || request.day === "same") {
    const weeks = /\bweek after next\b/.test(destination) ? 2 : /\b(?:next|following|coming) week\b/.test(destination) ? 1 : 0;
    if (weeks > 0) {
      const todayWeekday = new Date(`${today}T12:00:00Z`).getUTCDay();
      request.weekStart = addDaysISO(today, 7 * weeks - ((todayWeekday + 6) % 7));
      request.vagueTime = /\b(morning|afternoon|evening|night|weekend|month|before|asap|soon|sometime|free)\b/.test(leftover) || (clock.shiftDirectionMissing ?? false);
    }
  }
  // Only words that qualify the day itself count: a date ("Friday the 20th, next week",
  // "tomorrow like last week") is known whatever stands next to it, and "first thing in the
  // week" says nothing about which week (review of 11 Nov 2026).
  request.dayUnclear =
    dest.day !== undefined && dest.day !== "same" && !dest.day.exact &&
    (Boolean(dest.day.unclear) ||
      /\b(?:next|last|previous|following|coming)\s+(?:weeks?|months?|year)\b|\b(?:in|after)\s+(?:a|an|one|two|three|four|five|six|\d+)\s+(?:weeks?|months?)\b|\b(?:weeks?|months?)\s+(?:from|later|after|ago)\b|\b(?:a|an|one|two|three|four|five|six|\d+)\s+(?:weeks?|months?)\b|\bfortnight\b|\bafter next\b/.test(leftover));
  return request;
}

/**
 * Does the message ask for something new or for a change ("Set up a gym session ...", "Move
 * ...", "Cancel ..."), as opposed to a question or a request to show something? The reply guard
 * reads "Your gym session is scheduled for 6 pm" as a claim only then.
 */
export function asksForCalendarAction(message: string): boolean {
  if (asksForInformation(message)) return false;
  const text = normalizeRequest(message);
  return CREATE_RE.test(text) || findChangeVerbs(text).length > 0;
}

/**
 * A question, or a request for text in the chat: "When is my dentist appointment?", "Do I have
 * any reminders today?", "Schedule for tomorrow?", "Remind me what is on tomorrow", "Create a
 * summary of my inbox", "Email summary, please", "Confirm that I am free on Friday". It is
 * answered, not carried out, whatever verb it starts with (review of 11 Nov 2026: these got the
 * "nothing was added" note under their answer). "Can we move ...?" is a request.
 */
export function asksForInformation(message: string): boolean {
  const raw = (message ?? "").trim();
  // "When you have a moment, add ...", "If possible, move ...": the request starts after the comma.
  const text = normalizeRequest(message).replace(/^(?:when|if|once|whenever)\s+[^,]{1,40},\s*/, "");
  if (/^(?:what|when|where|which|who|whose|how|why)\b/.test(text)) return true;
  if (/\?\s*$/.test(raw) && !POLITE_ASK_RE.test(text)) return true;
  return TEXT_REQUEST_RE.test(text) || REMIND_QUESTION_RE.test(text) || NOUN_USE_OUTBOUND_RE.test(text) || CHECK_THAT_RE.test(text);
}

/**
 * Does the message ask MONDAY to do something (a calendar entry, a change, a reminder, an email
 * or a message), as opposed to asking a question? After such a message a turn without any card
 * prepared nothing, whatever the model's reply says (reply guard, QA round 5).
 */
export function asksForAction(message: string): boolean {
  // A question, or a request for text in the chat, is answered, not carried out.
  if (asksForInformation(message)) return false;
  // "When you have a moment, add ...", "If possible, move ...": the request starts after the comma.
  const text = normalizeRequest(message).replace(/^(?:when|if|once|whenever)\s+[^,]{1,40},\s*/, "");
  if (asksForCalendarAction(text)) return true;
  return (
    // "Tomorrow at 6 pm add a yoga session": the verb after a day or a time, with its object.
    /\b(?:add|schedule|book|reschedule|cancel|postpone|move|block)\s+(?:a|an|the|my|our|this|that)\b/.test(text) ||
    // "The dentist appointment needs to move to Friday", "... should be cancelled".
    /\b(?:needs?|has|have) to (?:be )?(?:moved?|rescheduled?|cancell?ed|cancel|postponed?|shifted|shift)\b|\bshould be (?:moved|rescheduled|cancell?ed|postponed|shifted)\b/.test(text) ||
    // Something to send to someone else. "Tell me ...", "Send me my schedule" ask for an answer.
    OUTBOUND_RE.test(text) ||
    // "Draft a reply to the recruiter", "Write me an email to Sam", "Write to Sam ..."; "Write a
    // summary of my week" and "Draft a plan for my day" ask for text in the chat.
    (WRITING_RE.test(text) && MAIL_WORDS_RE.test(text)) ||
    ADD_TO_CALENDAR_RE.test(text) ||
    OTHER_ACTION_RE.test(text) ||
    EDIT_RE.test(text) ||
    REMINDER_RE.test(text)
  );
}

/**
 * A short answer to MONDAY's own question back or to its "nothing was added" notice ("6 pm.",
 * "Yes, go ahead.", "Tomorrow at 6 pm for one hour.") continues the request it answers, so the
 * reply to it is held to the same rule (review of 11 Nov 2026). `previousAssistant` is the last
 * assistant message of the chat.
 */
export function followsUpOnAction(previousAssistant: string | null | undefined, message: string): boolean {
  const previous = previousAssistant ?? "";
  if (!/naming the day and the time|nothing (?:was|has been|in your calendar was) (?:added|prepared|changed)|\bwhich (?:day|date|one|event)\b|\bwhat time\b|\bdid you mean\b|should \*\*[^*]+\*\* move to/i.test(previous)) return false;
  const raw = (message ?? "").trim();
  const text = normalizeRequest(message);
  if (!text || text.split(/\s+/).length > 14) return false;
  if (/^(?:what|when|where|which|who|whose|how|why)\b/.test(text) || /\?\s*$/.test(raw)) return false;
  return !/^(?:thanks?|thank you|ok(?:ay)?|great|fine|cool|got it|never ?mind|no|nope|nah|forget it|leave it|stop|cancel that)\b[\s,.!a-z]{0,12}$/.test(text);
}

/** Does a message talk about the calendar at all (for "I could not find that event")? */
export function mentionsCalendar(message: string): boolean {
  return CALENDAR_WORDS_RE.test(normalizeRequest(message));
}

export type EventMatch =
  | { status: "one"; event: KnownEvent }
  | { status: "ambiguous"; candidates: KnownEvent[] }
  /** No event is named exactly; `similar` are the events that share a word with the request. */
  | { status: "none"; similar: KnownEvent[] };

/** Nouns people add to an event's name without meaning another thing: "the team sync meeting". */
const GENERIC_NOUNS = new Set([
  "meeting", "mtg", "appointment", "appt", "session", "class", "block", "plan", "schedule", "agenda", "booking", "entry",
  "all", "every", "everything", "anything",
]);

/**
 * The event a request names. An event is named when the request's words are words of its title
 * ("my dentist appointment", "the dentist", "the team sync meeting"), narrowed by the day or time
 * the request gives for it ("tomorrow's lecture", "the 3 pm meeting"). A request with a word that
 * is not in the title names something else: "the reminder for my dentist appointment", "the Acme
 * interview prep" and "the note about the lecture" are not the appointment, the interview or the
 * lecture, so nothing is matched and the events that share a word are returned as `similar`.
 * Several events named equally well are ambiguous (the user is asked), never guessed.
 */
export function matchEvent(request: ChangeRequest, events: KnownEvent[], timeZone: string): EventMatch {
  const subject = [...new Set(request.subjectWords)];
  // "the block for the Acme interview", "the meeting for the dentist appointment": the thing
  // before "for" is what is meant. It names the event only if a word of it is in the title
  // ("the appointment for the dentist" is the dentist appointment).
  const forAt = / for /.exec(` ${request.subject} `);
  const before = forAt ? titleWords(` ${request.subject} `.slice(0, forAt.index)) : [];
  const score = (event: KnownEvent) => {
    const words = new Set(titleWords(event.title));
    const shared = subject.filter((word) => words.has(word)).length;
    const somethingElse = before.length > 0 && !before.some((word) => words.has(word));
    const other = subject.filter((word) => !words.has(word) && !GENERIC_NOUNS.has(word)).length + (somethingElse ? 1 : 0);
    return { event, shared, other, whole: words.size > 0 && shared === words.size };
  };
  const filtered = events.filter((event) => {
    const local = localDateTime(event.starts_at, timeZone);
    if (request.sourceDay && !request.sourceDay.dates.includes(local.date)) return false;
    if (request.sourceClock && !request.sourceClock.minutes.includes(local.minutes)) return false;
    return true;
  });
  const scored = filtered.map(score);
  let named = scored.filter((s) => s.shared > 0 && s.other === 0);
  if (named.length === 0 && (request.sourceDay || request.sourceClock) && subject.every((word) => GENERIC_NOUNS.has(word))) {
    // "Move the 3 pm meeting to 4 pm", "Cancel tomorrow's event": no title word, but a time or
    // day that picks the event.
    named = scored;
  }
  if (named.length > 1) {
    const best = Math.max(...named.map((s) => s.shared));
    named = named.filter((s) => s.shared === best);
    // "Cancel lunch" with "Lunch" and "Lunch with Sam": the one whose whole title was said.
    const whole = named.filter((s) => s.whole);
    if (whole.length === 1) named = whole;
  }
  if (named.length === 1) return { status: "one", event: named[0].event };
  if (named.length > 1) return { status: "ambiguous", candidates: named.map((s) => s.event) };
  const similar = events
    .map(score)
    .filter((s) => s.shared > 0)
    .sort((a, b) => b.shared - a.shared)
    .slice(0, 3)
    .map((s) => s.event);
  return { status: "none", similar };
}

/** "the dentist appointment to after lunch" -> "the dentist appointment": the name ends at the first word that starts a destination or a time. */
function subjectHead(subject: string): string | null {
  const padded = ` ${subject} `;
  const m = /,|\s(?:to|so|that|until|till|by|from|after|before|into|onto|as|at)\s/.exec(padded);
  const head = m ? padded.slice(0, m.index).trim() : "";
  return head || null;
}

export type ResolvedMove =
  | { status: "resolved"; starts_at: string; ends_at: string; byRule: boolean }
  | { status: "unclear"; question: string };

function hhmm(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const meridiem = h % 24 >= 12 ? "PM" : "AM";
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${meridiem}`;
}

function dayName(date: string): string {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" });
}

/**
 * The new time of the target event. `suggestion` is the model's proposal for this event (from
 * its event change, or a new event it proposed with the same title); it is used only where the
 * request leaves a choice, and only if it is one of the allowed readings.
 */
export function resolveMove(
  request: ChangeRequest,
  event: KnownEvent,
  timeZone: string,
  suggestion?: { starts_at: string; ends_at: string },
): ResolvedMove {
  const startMs = Date.parse(event.starts_at);
  const endMs = Date.parse(event.ends_at);
  const durationMs = endMs - startMs;
  const original = localDateTime(event.starts_at, timeZone);

  if (request.shiftMin !== undefined) {
    const shift = request.shiftMin * 60_000;
    return { status: "resolved", starts_at: new Date(startMs + shift).toISOString(), ends_at: new Date(endMs + shift).toISOString(), byRule: true };
  }

  if (request.day !== undefined && request.day !== "same") {
    // "to yesterday", "to last Friday": not a day anything can move to.
    if (request.day.past) {
      const days = request.day.dates.map(dayName).join(" or ");
      return { status: "unclear", question: `${days} is already over. Which day should **${event.title}** move to?` };
    }
    // "Friday next month": the week or month next to the day was not read, so the date is unknown.
    if (request.dayUnclear) {
      return { status: "unclear", question: `I could not tell which date you mean. Which date should **${event.title}** move to?` };
    }
  }

  let dates = request.day === "same" || request.day === undefined ? [original.date] : request.day.dates;
  let dayGiven = request.day !== undefined;
  const timeGiven = Boolean(request.start);
  if (request.weekStart && (request.day === undefined || request.day === "same")) {
    if (request.day === "same" || timeGiven) {
      // "The same day next week", "next week at 3 pm": the event's own weekday in that week.
      const weekday = new Date(`${original.date}T12:00:00Z`).getUTCDay();
      dates = [addDaysISO(request.weekStart, (weekday + 6) % 7)];
      dayGiven = true;
    } else {
      // The week alone: the model's day, if it lies in that week; otherwise a question.
      if (suggestion) {
        const day = localDateTime(suggestion.starts_at, timeZone).date;
        if (day >= request.weekStart && day <= addDaysISO(request.weekStart, 6) && Date.parse(suggestion.ends_at) > Date.parse(suggestion.starts_at)) {
          return { status: "resolved", ...suggestion, byRule: false };
        }
      }
      return { status: "unclear", question: `Which day in the week of ${dayName(request.weekStart)} should **${event.title}** move to?` };
    }
  }
  const at = (date: string, minutes: number) =>
    zonedDateTimeToISO(addDaysISO(date, Math.floor(minutes / 1440)), { hour: Math.floor((minutes % 1440) / 60), minute: minutes % 60 }, timeZone);

  // Every reading the request allows: [start, end] pairs.
  const readings: { starts_at: string; ends_at: string }[] = [];
  if (!timeGiven && !dayGiven) {
    // Nothing the rules can read ("to next week", "to a later time"): the model's proposal, if any.
    if (suggestion) return { status: "resolved", ...suggestion, byRule: false };
    return { status: "unclear", question: `Which day and time should **${event.title}** move to?` };
  }
  for (const date of dates) {
    if (request.endOnly && request.start) {
      for (const minutes of request.start.minutes) {
        const startIso = zonedDateTimeToISO(date, { hour: Math.floor(original.minutes / 60), minute: original.minutes % 60 }, timeZone);
        readings.push({ starts_at: startIso, ends_at: at(date, minutes) });
      }
    } else if (request.start) {
      request.start.minutes.forEach((minutes, index) => {
        const startIso = at(date, minutes);
        const endMinutes = request.end?.minutes[Math.min(index, request.end.minutes.length - 1)];
        const endIso =
          endMinutes !== undefined
            ? at(date, endMinutes > minutes ? endMinutes : endMinutes + 1440)
            : new Date(Date.parse(startIso) + (request.durationMin !== undefined ? request.durationMin * 60_000 : durationMs)).toISOString();
        readings.push({ starts_at: startIso, ends_at: endIso });
      });
    } else if (!request.vagueTime) {
      // A new day only: same clock time, same length.
      const startIso = at(date, original.minutes);
      readings.push({ starts_at: startIso, ends_at: new Date(Date.parse(startIso) + durationMs).toISOString() });
    }
  }

  if (readings.length === 1) return { status: "resolved", ...readings[0], byRule: true };

  // A choice is left (am/pm, which Monday, "Friday afternoon"): the model's proposal decides
  // only if it is one of the allowed readings (or, for a vague time, on an allowed day).
  if (suggestion) {
    const suggestedStart = Date.parse(suggestion.starts_at);
    const match = readings.find((reading) => Date.parse(reading.starts_at) === suggestedStart);
    if (match) return { status: "resolved", ...match, byRule: false };
    if (readings.length === 0 && request.vagueTime) {
      const local = localDateTime(suggestion.starts_at, timeZone);
      if (dates.includes(local.date) && Date.parse(suggestion.ends_at) > suggestedStart) {
        return { status: "resolved", ...suggestion, byRule: false };
      }
    }
  }
  if (readings.length === 0) {
    return { status: "unclear", question: `What time on ${dates.map(dayName).join(" or ")} should **${event.title}** move to?` };
  }
  const startsDiffer = new Set(readings.map((r) => localDateTime(r.starts_at, timeZone).minutes)).size > 1;
  const datesDiffer = new Set(readings.map((r) => localDateTime(r.starts_at, timeZone).date)).size > 1;
  if (startsDiffer && !datesDiffer) {
    const options = [...new Set(readings.map((r) => localDateTime(r.starts_at, timeZone).minutes))].map(hhmm);
    return { status: "unclear", question: `Did you mean ${options.join(" or ")} for **${event.title}**?` };
  }
  const options = [...new Set(readings.map((r) => localDateTime(r.starts_at, timeZone).date))].map(dayName);
  return { status: "unclear", question: `Which day did you mean for **${event.title}**: ${options.join(" or ")}?` };
}

/** Same title, ignoring case, emoji and punctuation. */
export function sameTitle(a: string, b: string): boolean {
  const plain = (s: string) => (s ?? "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, " ").trim();
  return plain(a) !== "" && plain(a) === plain(b);
}

/** Every title word of `existing` appears in `proposed` ("Dentist appointment (moved)" covers "Dentist appointment"). */
export function coversTitle(proposed: string, existing: string): boolean {
  const words = new Set(titleWords(proposed));
  const wanted = titleWords(existing);
  return wanted.length > 0 && wanted.every((word) => words.has(word));
}

/** A change the model proposed, with its event id already checked and its times read as UTC ISO. */
export interface ModelChange {
  kind: "update" | "delete";
  event: KnownEvent;
  starts_at?: string;
  ends_at?: string;
  title?: string;
}

export interface ProposedBlock {
  title: string;
  starts_at: string;
  ends_at: string;
  notes?: string | null;
}

export interface ReconciledChange {
  kind: "update" | "delete";
  event: KnownEvent;
  next?: { starts_at?: string; ends_at?: string; title?: string };
  /** The new time came from the rules (true) or from the model (false). */
  byRule: boolean;
}

export interface Reconciled {
  request: ChangeRequest | null;
  /** True when the message asked to move or cancel an event (the reply is built from the result). */
  changeRequest: boolean;
  changes: ReconciledChange[];
  proposals: ProposedBlock[];
  /**
   * New-event proposals that carry the title of an event already in the calendar: they would add
   * a second one (the reply says so), they do not move the existing one.
   */
  sameTitleAs: { title: string; event: KnownEvent }[];
  /** A question back or the reason a requested change has no card. */
  note?: string;
  /**
   * The note is only about a change the model made although the message did not ask for one
   * (it was left out); the model's answer to the message itself stands.
   */
  unasked?: boolean;
  /** What the app corrected or dropped, for the server log. */
  log: string[];
}

/** A message that talks about moving an event ("the dentist appointment was moved to Friday"). */
const MOVE_WORD_ANYWHERE = /\b(move|moved|reschedule|postpone|shift|push (?:it )?back|bring (?:it )?forward)\b/;
/** Words that ask to change something that exists. */
const CHANGE_WORD_ANYWHERE =
  /\b(move[sd]?|moving|reschedul\w*|postpon\w*|shift\w*|push\w*|delay\w*|prepone|cancel\w*|delet\w*|remov\w*|call off|scrap|drop\w*|chang\w*|updat\w*|edit|modif\w*|adjust\w*|switch|replace|rearrang\w*|bump|rename|swap|skip|free up|clear|later|earlier|instead|longer|shorter|extend|lengthen|shorten|(?:start|begin|end|finish)(?:s|es|ing)? at|can't make|cannot make|won't make)\b/;
/** "Don't cancel the team sync", "I do not want to move the lecture", "never reschedule ...". */
const NEGATED_CHANGE_RE =
  /\b(?:don't|dont|do not|never|not|no need to|without)\s+(?:\w+\s+){0,3}?(?:mov\w*|reschedul\w*|cancel\w*|delet\w*|remov\w*|postpon\w*|shift\w*|push\w*|chang\w*|drop\w*|touch\w*)\b/;
/** Words that allow a time between 00:00 and 05:59. */
const EARLY_OK = /\b(\d{1,2}(?::\d{2})? ?am|morning|early|night|midnight|0[0-5]:\d{2}|[0-5]:\d{2})\b/;

function describe(event: KnownEvent, timeZone: string): string {
  return `**${event.title}** (${describeLocal(event.starts_at, timeZone)})`;
}

function describeLocal(iso: string, timeZone: string): string {
  const local = localDateTime(iso, timeZone);
  return `${dayName(local.date)}, ${hhmm(local.minutes)}`;
}

/**
 * Check the model's calendar changes and new-event proposals against what the message asked for.
 *
 * The rules decide only where the message is clear: a move or cancel verb whose object is an
 * event of the calendar, named by its own title words. Then the result has exactly that change
 * (with the day and time the request names) or a question, and never a new event that is really
 * the event to move. Everything else (reminders, new events, "set up", "set aside", "put ... on",
 * "block ...", questions) is not a change request: the model's proposals stay as they are, a
 * model change to an existing event is kept only when the message asks for a change at all, and
 * the model's own reply is kept (see reply-guard).
 */
export function reconcileCalendarChanges(opts: {
  message: string;
  today: string;
  timeZone: string;
  nowMs: number;
  events: KnownEvent[];
  modelChanges: ModelChange[];
  modelProposals: ProposedBlock[];
  /** Changes the model made for event ids that are not in the calendar (already dropped). */
  unknownChangeRefs?: number;
}): Reconciled {
  const { message, timeZone, nowMs, events } = opts;
  const text = normalizeRequest(message);
  const log: string[] = [];
  // A proposal that is an event already in the calendar (same title, same time) is not new.
  let proposals = opts.modelProposals.filter((proposal) => {
    const duplicate = events.some(
      (event) =>
        sameTitle(event.title, proposal.title) &&
        Date.parse(event.starts_at) === Date.parse(proposal.starts_at) &&
        Date.parse(event.ends_at) === Date.parse(proposal.ends_at),
    );
    if (duplicate) log.push(`dropped a proposal that repeats an existing event: ${proposal.title}`);
    return !duplicate;
  });

  const request = parseChangeRequest(message, opts.today);
  /**
   * The proposals that are left, as the user will see them: a reminder the model titled exactly
   * like the event it is about is called "Reminder: ..." (QA round 4's "Set a reminder for my
   * dentist appointment at 1 pm on Thursday" got a new "Dentist appointment" at 13:00), and any
   * other new event with the title of an existing one is reported, so the reply can say it adds
   * a second one.
   */
  const result = (base: Omit<Reconciled, "proposals" | "sameTitleAs" | "log" | "request">): Reconciled => {
    const sameTitleAs: Reconciled["sameTitleAs"] = [];
    const shown = proposals.map((proposal) => {
      const same = events.find((event) => sameTitle(event.title, proposal.title));
      if (!same) return proposal;
      if (/\bremind/.test(text) && !/^\W*reminder\b/i.test(proposal.title)) {
        log.push(`titled the model's new "${proposal.title}" as a reminder: the message asks for a reminder`);
        return { ...proposal, title: `Reminder: ${proposal.title}`.slice(0, 200) };
      }
      sameTitleAs.push({ title: proposal.title, event: same });
      return proposal;
    });
    return { request, ...base, proposals: shown, sameTitleAs, log };
  };

  const finish = (target: KnownEvent | null, changes: ReconciledChange[], note?: string): Reconciled => {
    if (target && request?.kind !== "cancel") {
      // The event the user asked to move is never proposed again as a new event. (After a cancel
      // a new one may be wanted: "Cancel the dentist appointment and book a new one for Friday".)
      proposals = proposals.filter((proposal) => {
        const same = coversTitle(proposal.title, target.title) || sameTitle(proposal.title, target.title);
        if (same) log.push(`dropped a new-event proposal that repeats the event to change: ${proposal.title}`);
        return !same;
      });
    }
    for (const change of opts.modelChanges) {
      if (!changes.some((kept) => kept.event.id === change.event.id && kept.kind === change.kind)) {
        log.push(`dropped a model ${change.kind} of "${change.event.title}" that the request did not ask for`);
      }
    }
    return result({ changeRequest: true, changes, note });
  };

  /** Checks every new time must pass, whoever chose it. */
  const checkTime = (event: KnownEvent, startsAt: string, endsAt: string, byRule: boolean): string | null => {
    const start = Date.parse(startsAt);
    const end = Date.parse(endsAt);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      return `I could not work out a valid new time for **${event.title}**.`;
    }
    if (start === Date.parse(event.starts_at) && end === Date.parse(event.ends_at)) {
      return `**${event.title}** is already at that time.`;
    }
    if (start < nowMs) return `The new time for **${event.title}** (${describeLocal(startsAt, timeZone)}) has already passed.`;
    if (!byRule && localDateTime(startsAt, timeZone).minutes < 6 * 60 && !EARLY_OK.test(text)) {
      return `The AI model proposed ${describeLocal(startsAt, timeZone)} for **${event.title}**, which does not look like what you asked for, so I did not offer it. Please say the day and time you want.`;
    }
    return null;
  };

  /**
   * Not a move or cancel request the rules can read: the model's proposals stay, and its changes
   * to existing events are checked. A change is kept only when the message asks for a change at
   * all ("The dentist appointment needs to be later", "Put the team sync on Friday") and is not
   * a request for something new ("Set a reminder for my dentist appointment at 1 pm") or a
   * refusal ("Don't cancel the team sync"); otherwise it is left out and the reply says so.
   */
  const withoutRequest = (acceptChanges = true): Reconciled => {
    // A message about a reminder asks for a reminder, whatever verb it starts with; a message to
    // write or tell something ("Email the team that the sync is cancelled") asks for that.
    const creating =
      CREATE_RE.test(text) || /\b(?:remind\w*|to-?dos?|note to self)\b/.test(text) || COMMUNICATE_RE.test(text) || ADD_TO_CALENDAR_RE.test(text);
    const negated = NEGATED_CHANGE_RE.test(text);
    const question = /^(?:what|when|where|which|who|whose|how|why)\b/.test(text) || (/\?\s*$/.test(message.trim()) && /^(?:is|are|was|were|do|does|did|am|has|have)\b/.test(text));
    // "Move on", "moving forward with ..." and "Push workout" are not about changing an event.
    const withoutIdioms = text.replace(NOUN_USE_RE, " ").replace(/\bmov(?:e|ing) (?:on|over|out|along|away|in|(?:forward|ahead) with)\b/g, " ");
    const asksChange = acceptChanges && !creating && !negated && !question && CHANGE_WORD_ANYWHERE.test(withoutIdioms);
    // A change is kept only for an event the message mentions: by a word of its title, or by its day.
    const messageWords = new Set(titleWords(text));
    const messageDay = parseDay(text, opts.today).day;
    const mentioned = (event: KnownEvent) =>
      titleWords(event.title).some((word) => messageWords.has(word)) ||
      (messageDay !== undefined && messageDay !== "same" && messageDay.dates.includes(localDateTime(event.starts_at, timeZone).date));
    // A new event with the title of an existing one, in a message that talks about moving, is
    // that event moved (QA round 3 saw a "moved" dentist appointment proposed as a second one).
    if (asksChange && MOVE_WORD_ANYWHERE.test(text)) {
      for (const proposal of proposals) {
        const same = events.filter((event) => sameTitle(event.title, proposal.title));
        if (same.length !== 1 || !mentioned(same[0])) continue;
        log.push(`turned a new-event proposal into a move of "${same[0].title}"`);
        const problem = checkTime(same[0], proposal.starts_at, proposal.ends_at, false);
        if (problem) return finish(same[0], [], problem);
        return finish(same[0], [
          { kind: "update", event: same[0], next: { starts_at: proposal.starts_at, ends_at: proposal.ends_at }, byRule: false },
        ]);
      }
    }
    // Every day the message names (the event's own day, the day it should move to). A model
    // change to another day is not what was asked: "The dentist appointment needs to move to
    // Friday next week" with a model answer for this Friday (review of 11 Nov 2026).
    const namedDates = new Set<string>();
    let unread = text;
    for (let i = 0; i < 3; i++) {
      const found = parseDay(unread, opts.today);
      if (!found.day || found.day === "same" || found.day.unclear) break;
      found.day.dates.forEach((date) => namedDates.add(date));
      unread = found.rest;
    }
    const unasked: KnownEvent[] = [];
    const changes: ReconciledChange[] = [];
    let note: string | undefined;
    for (const change of opts.modelChanges) {
      if (!asksChange || !mentioned(change.event)) {
        log.push(
          `dropped a model ${change.kind} of "${change.event.title}": the message ${creating ? "asks for something new or to write something" : negated ? "says not to change it" : question ? "is a question" : acceptChanges && asksChange ? "does not mention this event" : acceptChanges ? "does not ask for a change" : "does not name this event"}`,
        );
        if (!unasked.includes(change.event)) unasked.push(change.event);
        continue;
      }
      if (change.kind === "delete") {
        changes.push({ kind: "delete", event: change.event, byRule: false });
        continue;
      }
      const startsAt = change.starts_at ?? change.event.starts_at;
      // A new start alone keeps the event's length.
      const endsAt =
        change.ends_at ??
        (change.starts_at
          ? new Date(Date.parse(change.starts_at) + Date.parse(change.event.ends_at) - Date.parse(change.event.starts_at)).toISOString()
          : change.event.ends_at);
      const timeChanged = Date.parse(startsAt) !== Date.parse(change.event.starts_at) || Date.parse(endsAt) !== Date.parse(change.event.ends_at);
      if (timeChanged) {
        const problem = checkTime(change.event, startsAt, endsAt, false);
        if (problem) {
          note = problem;
          log.push(`dropped a model update of "${change.event.title}": ${problem}`);
          continue;
        }
        const newDay = localDateTime(startsAt, timeZone).date;
        if (namedDates.size > 0 && !namedDates.has(newDay)) {
          note = `The AI model proposed ${dayName(newDay)} for **${change.event.title}**, which is not a day your message names. Which day and time should it move to?`;
          log.push(`dropped a model update of "${change.event.title}" to ${newDay}: the message names ${[...namedDates].join(", ")}`);
          continue;
        }
      }
      if (!timeChanged && !change.title) continue;
      changes.push({
        kind: "update",
        event: change.event,
        next: { starts_at: timeChanged ? startsAt : undefined, ends_at: timeChanged ? endsAt : undefined, title: change.title },
        byRule: false,
      });
    }
    if (unasked.length > 0) {
      note = `The AI model also suggested changing ${unasked.map((e) => describe(e, timeZone)).join(", ")}. I did not read your message as asking for that, so I left it out. To move or cancel an event, name it, for example "Move ${unasked[0].title} to Friday at 3 pm".`;
    } else if (!note && changes.length === 0 && (opts.unknownChangeRefs ?? 0) > 0) {
      note = "The AI model referred to an event that is not in your calendar, so there is no change to save.";
    }
    return result({ changeRequest: false, changes, note, unasked: unasked.length > 0 });
  };
  if (!request) return withoutRequest();

  const readable = request.day !== undefined || request.start !== undefined || request.shiftMin !== undefined || request.weekStart !== undefined;

  // Which event: it must be named by its own title words. "the dentist appointment to after
  // lunch" names the dentist appointment; the words after it are not part of the name.
  let subject = request.subject;
  let match = matchEvent(request, events, timeZone);
  if (match.status === "none" && request.certainty !== "model") {
    // "Cancel the team sync and the lecture": every part names an event. One change per message.
    const parts = request.subject.split(/\s*,\s*(?:and\s+)?|\s+and\s+|\s*&\s*/).map((part) => part.trim()).filter(Boolean);
    const named = parts.map((part) => matchEvent({ ...request, subject: part, subjectWords: titleWords(part) }, events, timeZone));
    if (parts.length > 1 && named.every((m) => m.status === "one")) {
      const list = named.flatMap((m) => (m.status === "one" ? [m.event] : []));
      const example = request.kind === "cancel" ? `Cancel ${list[0].title}` : `Move ${list[0].title} to Friday at 3 pm`;
      return finish(
        null,
        [],
        `Your message names ${list.length} events: ${list.map((e) => describe(e, timeZone)).join(", ")}. I prepare one change at a time, so please send one message per event, for example "${example}".`,
      );
    }
  }
  if (match.status === "none") {
    const head = subjectHead(request.subject);
    const retry = head ? matchEvent({ ...request, subject: head, subjectWords: titleWords(head) }, events, timeZone) : null;
    if (head && retry && retry.status !== "none") {
      match = retry;
      subject = head;
    }
  }
  if (match.status !== "none" && request.kind === "move" && request.certainty === "weak" && !readable) {
    // "Change my workout to legs", "Change the lecture to online": no new day or time the rules
    // can read, so this is not a move the rules can vouch for; the model's own change is checked.
    return withoutRequest();
  }
  if (request.certainty === "model") {
    // "Put the team sync on Friday": a move only if the model itself moved that very event.
    const named = match.status === "one" ? match.event : null;
    if (!named || !opts.modelChanges.some((c) => c.kind === "update" && c.event.id === named.id && (c.starts_at || c.ends_at))) {
      log.push(`"${request.subject}": no move by rule after set/put`);
      return withoutRequest(false);
    }
  }
  if (match.status === "ambiguous") {
    return finish(
      null,
      [],
      `More than one event matches "${subject}": ${match.candidates.map((e) => describe(e, timeZone)).join(", ")}. Which one do you mean?`,
    );
  }
  let target: KnownEvent | null = null;
  if (match.status === "one") {
    target = match.event;
  } else {
    // "Move it to 5 pm" names no event: the one event the model pointed at, with the day and
    // time read by rule.
    const unnamed = request.subjectWords.length === 0 && !request.sourceDay && !request.sourceClock;
    if (request.certainty === "weak" || (request.certainty === "exact" && !unnamed)) {
      // "Shift my focus to the lecture", "Delete the note about the lecture", "Change my mind
      // about the dentist appointment": the object is not an event, so this is not a request to
      // change one, and a change the model makes to an event anyway is left out.
      log.push(`read "${request.subject}" as something else than an event to ${request.kind}`);
      return withoutRequest(false);
    }
    const referenced = new Map<string, KnownEvent>();
    const wantedKind = request.kind === "cancel" ? "delete" : "update";
    for (const change of opts.modelChanges) if (!unnamed || change.kind === wantedKind) referenced.set(change.event.id, change.event);
    if (unnamed && referenced.size === 0 && opts.modelChanges.length > 0) {
      // "Cancel that" answered with a move (or "Move it" with a delete): not what was asked.
      return withoutRequest(false);
    }
    if (unnamed && referenced.size === 0 && request.kind === "move") {
      for (const proposal of proposals) {
        const same = events.filter((event) => sameTitle(event.title, proposal.title));
        if (same.length === 1) referenced.set(same[0].id, same[0]);
      }
    }
    if (unnamed && referenced.size === 1) {
      target = [...referenced.values()][0];
    } else if (unnamed && referenced.size > 1) {
      return finish(null, [], `I am not sure which event you mean: ${[...referenced.values()].map((e) => describe(e, timeZone)).join(", ")}. Please name it.`);
    } else if (!unnamed && (match.similar.length > 0 || mentionsCalendar(request.subject) || opts.modelChanges.length > 0 || (opts.unknownChangeRefs ?? 0) > 0)) {
      // A move or cancel of something that is not in the calendar under that name: no card. A NEW
      // event with that name is not what was asked for either ("Move my yoga class to 6 pm" must
      // not offer a new yoga class at 6 pm as if it were the move), and neither is a change of an
      // event that only shares a word with it ("Cancel the reminder for my dentist appointment"
      // must not cancel the appointment); those are named so the user can say which one is meant.
      const wanted = new Set(request.subjectWords);
      proposals = proposals.filter((proposal) => {
        const about = titleWords(proposal.title).some((word) => wanted.has(word));
        if (about) log.push(`dropped a new-event proposal for "${proposal.title}": the request asked to ${request.kind} an event that is not in the calendar`);
        return !about;
      });
      const closest = match.similar.length > 0 ? match.similar : [...referenced.values()].slice(0, 3);
      const hint =
        closest.length > 0
          ? ` The closest ${closest.length === 1 ? "is" : "are"} ${closest.map((e) => describe(e, timeZone)).join(", ")}. To ${request.kind} ${closest.length === 1 ? "it" : "one of them"}, name it as it is in the calendar.`
          : "";
      // As the message named it, with the day or time it gave ("the dentist appointment on friday").
      const dayText = request.sourceDay?.text ?? "";
      const clockText = request.sourceClock?.text ?? "";
      const label = [
        dayText.endsWith("'s") ? dayText : "",
        request.subject,
        dayText.endsWith("'s") ? "" : dayText,
        clockText && !/^(?:at|from)\b/.test(clockText) ? `at ${clockText}` : clockText,
      ].filter(Boolean).join(" ");
      return finish(null, [], `I could not find an event matching "${label}" in your calendar for the next 3 weeks.${hint}`);
    } else {
      // Not about the calendar after all ("Cancel my subscription", "Move on to the next task").
      return withoutRequest();
    }
  }

  if (request.kind === "cancel") {
    return finish(target, [{ kind: "delete", event: target, byRule: match.status === "one" }]);
  }

  // The model's own proposal for this event, used only where the request leaves a choice.
  const chosen = target;
  const modelUpdate = opts.modelChanges.find((c) => c.kind === "update" && c.event.id === chosen.id && (c.starts_at || c.ends_at));
  const modelProposal = proposals.find((p) => coversTitle(p.title, chosen.title) || sameTitle(p.title, chosen.title));
  if (!readable && !request.vagueTime && !modelUpdate && !modelProposal) {
    // "Move the dentist appointment": no new day or time, and the model did not move this event
    // either, so there is no change to offer (a change it made to ANOTHER event is left out).
    return withoutRequest(false);
  }
  const lengthMs = Date.parse(chosen.ends_at) - Date.parse(chosen.starts_at);
  const suggestion = modelUpdate
    ? {
        starts_at: modelUpdate.starts_at ?? chosen.starts_at,
        ends_at:
          modelUpdate.ends_at ??
          (modelUpdate.starts_at ? new Date(Date.parse(modelUpdate.starts_at) + lengthMs).toISOString() : chosen.ends_at),
      }
    : modelProposal
      ? { starts_at: modelProposal.starts_at, ends_at: modelProposal.ends_at }
      : undefined;
  if (!modelUpdate && modelProposal) {
    log.push(`the model proposed "${modelProposal.title}" as a new event; treated as a move of the existing event`);
  }
  const resolved = resolveMove(request, chosen, timeZone, suggestion);
  if (resolved.status === "unclear") return finish(chosen, [], resolved.question);
  if (
    suggestion &&
    resolved.byRule &&
    (Date.parse(suggestion.starts_at) !== Date.parse(resolved.starts_at) || Date.parse(suggestion.ends_at) !== Date.parse(resolved.ends_at))
  ) {
    log.push(`corrected the model's time for "${chosen.title}" from ${suggestion.starts_at}/${suggestion.ends_at} to ${resolved.starts_at}/${resolved.ends_at}`);
  }
  const problem = checkTime(chosen, resolved.starts_at, resolved.ends_at, resolved.byRule);
  if (problem) return finish(chosen, [], problem);
  return finish(chosen, [
    { kind: "update", event: chosen, next: { starts_at: resolved.starts_at, ends_at: resolved.ends_at }, byRule: resolved.byRule },
  ]);
}
