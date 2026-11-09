/**
 * Moving or cancelling an EXISTING calendar event from a chat message ("Move my dentist
 * appointment to start at 4 pm the same day", "Cancel the team sync").
 *
 * The model is asked for an `event_changes` entry, but a small local model got these wrong in
 * every real attempt in QA round 3 (9 Nov 2026): a move to 04:00 the NEXT day while its reply
 * said "4:00 PM today", and two NEW dentist appointments instead of moving the one there.
 * So the app reads the cheap, unambiguous parts of the request itself:
 *
 *  - which event: the event whose title shares the most words with the request (narrowed by a
 *    day or time the request gives for it, "the dentist appointment on Wednesday"); two equally
 *    good matches are a question back to the user, never a guess;
 *  - the new day: "the same day", "today", "tomorrow", a weekday, "Nov 12", "2026-11-12";
 *    a weekday that could mean two dates ("Monday" on a Monday, "next Friday") is ambiguous;
 *  - the new time: "4 pm", "16:00", "4:00-5:30 pm", "noon", "start at", "end at", "for an
 *    hour", "an hour later"; "at 4" without am/pm is ambiguous (4:00 or 16:00).
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
}

/** One or more possible clock times (minutes after local midnight); two means am/pm unknown. */
export interface ClockRef {
  minutes: number[];
  text: string;
}

export interface ChangeRequest {
  kind: "move" | "cancel";
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
}

const WEEKDAYS: Record<string, number> = {
  sunday: 0, sun: 0, monday: 1, mon: 1, tuesday: 2, tue: 2, tues: 2, wednesday: 3, wed: 3,
  thursday: 4, thu: 4, thur: 4, thurs: 4, friday: 5, fri: 5, saturday: 6, sat: 6,
};
const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};
const WEEKDAY_RE = "(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tues|tue|wed|thurs|thur|thu|fri|sat|sun)";
const MONTH_RE = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";

// The verb must start a clause ("Move ...", "Please move ...", "Can you cancel ...", "..., then
// move ..."): in "Block 3-5 pm for a gym push workout" the word "push" is not a request.
const CLAUSE_START = "(?:^|[,;:]\\s*|\\b(?:please|pls|can you|could you|would you|will you|kindly|i want to|i'd like to|i would like to|i need to|i have to|i must|let's|lets|and|then|also|ok|okay|actually)\\s+)";
const CANCEL_RE = new RegExp(`${CLAUSE_START}(cancel|delete|remove|call off|scrap|drop)\\b`);
const MOVE_RE = new RegExp(`${CLAUSE_START}(move|reschedule|re-schedule|push|shift|postpone|delay|bring|pull|change|put|set|prepone)\\b`);
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
export function parseDay(text: string, today: string): { day?: DayRef | "same"; rest: string } {
  let rest = text;
  const take = (re: RegExp): RegExpExecArray | null => {
    const m = re.exec(rest);
    if (m) rest = `${rest.slice(0, m.index)} ${rest.slice(m.index + m[0].length)}`;
    return m;
  };
  const todayWeekday = new Date(`${today}T12:00:00Z`).getUTCDay();

  let m = take(/\b(?:on |for )?(?:the )?same day\b/);
  if (m) return { day: "same", rest };
  m = take(/\b(?:on |for )?(?:the )?day after tomorrow('s)?\b/);
  if (m) return { day: { dates: [addDaysISO(today, 2)], text: m[0].trim() }, rest };
  m = take(/\b(?:for |on )?(today|tonight|this (?:morning|afternoon|evening))('s)?\b/);
  if (m) return { day: { dates: [today], text: m[0].trim() }, rest };
  m = take(/\b(?:for |on )?tomorrow('s)?\b/);
  if (m) return { day: { dates: [addDaysISO(today, 1)], text: m[0].trim() }, rest };
  m = take(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (m) return { day: { dates: [`${m[1]}-${m[2]}-${m[3]}`], text: m[0] }, rest };
  m = take(new RegExp(`\\b(?:on |for )?(?:the )?(\\d{1,2})(?:st|nd|rd|th)?(?: of)? ${MONTH_RE}\\b`)) ??
    take(new RegExp(`\\b(?:on |for )?${MONTH_RE}\\.? (\\d{1,2})(?:st|nd|rd|th)?\\b`));
  if (m) {
    const dayFirst = /^\d/.test(m[1]);
    const dayNumber = Number(dayFirst ? m[1] : m[2]);
    const month = MONTHS[(dayFirst ? m[2] : m[1]).slice(0, 3)];
    let year = Number(today.slice(0, 4));
    const candidate = (y: number) => `${y}-${String(month).padStart(2, "0")}-${String(dayNumber).padStart(2, "0")}`;
    if (month && dayNumber >= 1 && dayNumber <= 31) {
      // A date more than half a year back means next year ("Jan 5" asked in November).
      if (Date.parse(`${candidate(year)}T12:00:00Z`) < Date.parse(`${today}T12:00:00Z`) - 180 * 86_400_000) year += 1;
      return { day: { dates: [candidate(year)], text: m[0].trim() }, rest };
    }
  }
  m = take(new RegExp(`\\b(?:on |for )?(?:(this|next|coming) )?${WEEKDAY_RE}('s)?\\b`));
  if (m) {
    const weekday = WEEKDAYS[m[2]];
    const delta = (weekday - todayWeekday + 7) % 7;
    const which = m[1];
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
  const cancel = CANCEL_RE.exec(text);
  const move = MOVE_RE.exec(text);
  if (!cancel && !move) return null;

  // Where the destination starts: the first " to " (or "at" after put/set) after the verb that
  // is followed by a time, a day or "start"/"end"; or a shift phrase ("an hour later").
  const verb = cancel && (!move || cancel.index <= move.index) ? cancel : move!;
  const afterVerb = text.slice(verb.index + verb[0].length);
  const destinationWords = `(?=(?:start|begin|end|finish|the same day|same day|today|tonight|tomorrow|the day after|next|this|coming|on |noon|midday|midnight|\\d|${WEEKDAY_RE}\\b|${MONTH_RE}\\b))`;
  // "to"/"until"/"for" first; "at" only when there is none ("move the 3 pm meeting at ... to 4 pm"
  // names the old time with "at").
  const destStart = new RegExp(`\\s(?:to|for|until|till)\\s${destinationWords}`);
  const atStart = new RegExp(`\\sat\\s${destinationWords}`);
  const shiftAnywhere = /\b(?:back|forward|ahead|later|earlier)\b|\b(?:by )?(?:\d+(?:\.\d+)?|an?|one|two|half an?) ?(?:hours?|hrs?|minutes?|mins?) (?:later|earlier|back|forward)\b/;

  let subject = afterVerb;
  let destination = "";
  const split = destStart.exec(afterVerb) ?? (/^(put|set|move|change)$/.test(verb[1]) ? atStart.exec(afterVerb) : null);
  if (split) {
    subject = afterVerb.slice(0, split.index);
    destination = afterVerb.slice(split.index).replace(/^\s(?:to|for|until|till|at)\s/, (word) => (/until|till/.test(word) ? " until " : " "));
  } else {
    const shift = shiftAnywhere.exec(afterVerb);
    if (shift) {
      subject = afterVerb.slice(0, shift.index);
      destination = afterVerb.slice(shift.index);
    }
  }
  // "push ... back" / "bring ... forward" name the direction with the verb.
  if (/^(push|delay|postpone)$/.test(verb[1]) && !/\b(later|earlier|back|forward|ahead)\b/.test(destination)) destination += " later";
  if (/^(bring|pull|prepone)$/.test(verb[1]) && !/\b(later|earlier|back|forward|ahead)\b/.test(destination)) destination += " earlier";

  const kind: ChangeRequest["kind"] = verb === cancel && !destination.trim() ? "cancel" : move ? "move" : "cancel";

  // The subject may say which occurrence: "the dentist appointment on Wednesday", "the 3 pm meeting".
  const source = parseDay(subject, today);
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
    subject: subjectRest,
    subjectWords: titleWords(subjectRest),
    sourceDay: source.day && source.day !== "same" ? source.day : undefined,
    sourceClock,
  };
  if (kind === "cancel") return request;

  const dest = parseDay(destination, today);
  const clock = parseClock(dest.rest);
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
  return request;
}

/** Does a message talk about the calendar at all (for "I could not find that event")? */
export function mentionsCalendar(message: string): boolean {
  return CALENDAR_WORDS_RE.test(normalizeRequest(message));
}

export type EventMatch =
  | { status: "one"; event: KnownEvent }
  | { status: "ambiguous"; candidates: KnownEvent[] }
  | { status: "none" };

/**
 * The event a request names: most shared title words, narrowed by the day or time the request
 * gives for it. Ties are reported as ambiguous (the user is asked), never guessed.
 */
export function matchEvent(request: ChangeRequest, events: KnownEvent[], timeZone: string): EventMatch {
  const filtered = events.filter((event) => {
    const local = localDateTime(event.starts_at, timeZone);
    if (request.sourceDay && !request.sourceDay.dates.includes(local.date)) return false;
    if (request.sourceClock && !request.sourceClock.minutes.includes(local.minutes)) return false;
    return true;
  });
  const wanted = new Set(request.subjectWords);
  const scored = filtered.map((event) => {
    const words = titleWords(event.title);
    const shared = new Set(words.filter((word) => wanted.has(word))).size;
    return { event, shared, coverage: words.length > 0 ? shared / new Set(words).size : 0 };
  });
  const best = Math.max(0, ...scored.map((s) => s.shared));
  let top = best > 0 ? scored.filter((s) => s.shared === best) : [];
  if (top.length === 0 && (request.sourceDay || request.sourceClock) && wanted.size === 0) {
    // "Move the 3 pm one to 4 pm": no title words, but a time or day that picks the event.
    top = scored;
  }
  if (top.length > 1) {
    const bestCoverage = Math.max(...top.map((s) => s.coverage));
    top = top.filter((s) => s.coverage === bestCoverage);
  }
  if (top.length === 1) return { status: "one", event: top[0].event };
  if (top.length > 1) return { status: "ambiguous", candidates: top.map((s) => s.event) };
  return { status: "none" };
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

  const dates = request.day === "same" || request.day === undefined ? [original.date] : request.day.dates;
  const dayGiven = request.day !== undefined;
  const timeGiven = Boolean(request.start);
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
  /** A question back or the reason a requested change has no card. */
  note?: string;
  /** What the app corrected or dropped, for the server log. */
  log: string[];
}

const MOVE_WORD_ANYWHERE = /\b(move|moved|reschedule|postpone|shift|push (?:it )?back|bring (?:it )?forward)\b/;
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
 * The result has at most one change for a move/cancel request, and never a new event that is
 * really the event the user asked to move.
 */
export function reconcileCalendarChanges(opts: {
  message: string;
  today: string;
  timeZone: string;
  nowMs: number;
  events: KnownEvent[];
  modelChanges: ModelChange[];
  modelProposals: ProposedBlock[];
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
  const finish = (target: KnownEvent | null, changes: ReconciledChange[], note?: string): Reconciled => {
    if (target) {
      // The event the user asked to move or cancel is never proposed again as a new event.
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
    return { request, changeRequest: true, changes, proposals, note, log };
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

  /** No move/cancel request the rules can use: check the model's own changes and proposals. */
  const withoutRequest = (): Reconciled => {
    // A new event with the title of an existing one,
    // in a message that talks about moving, is that event moved (QA saw a "moved" dentist
    // appointment proposed as a second appointment).
    if (MOVE_WORD_ANYWHERE.test(text)) {
      for (const proposal of proposals) {
        const same = events.filter((event) => sameTitle(event.title, proposal.title));
        if (same.length !== 1) continue;
        log.push(`turned a new-event proposal into a move of "${same[0].title}"`);
        const problem = checkTime(same[0], proposal.starts_at, proposal.ends_at, false);
        if (problem) return finish(same[0], [], problem);
        return finish(same[0], [
          { kind: "update", event: same[0], next: { starts_at: proposal.starts_at, ends_at: proposal.ends_at }, byRule: false },
        ]);
      }
    }
    const changes: ReconciledChange[] = [];
    let note: string | undefined;
    for (const change of opts.modelChanges) {
      if (change.kind === "delete") {
        changes.push({ kind: "delete", event: change.event, byRule: false });
        continue;
      }
      const startsAt = change.starts_at ?? change.event.starts_at;
      const endsAt = change.ends_at ?? change.event.ends_at;
      const timeChanged = Date.parse(startsAt) !== Date.parse(change.event.starts_at) || Date.parse(endsAt) !== Date.parse(change.event.ends_at);
      if (timeChanged) {
        const problem = checkTime(change.event, startsAt, endsAt, false);
        if (problem) {
          note = problem;
          log.push(`dropped a model update of "${change.event.title}": ${problem}`);
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
    return { request, changeRequest: false, changes, proposals, note, log };
  };
  if (!request) return withoutRequest();

  // Which event: the rules first, then the one event the model pointed at.
  const match = matchEvent(request, events, timeZone);
  let target: KnownEvent | null = null;
  if (match.status === "ambiguous") {
    return finish(
      null,
      [],
      `More than one event matches "${request.subject}": ${match.candidates.map((e) => describe(e, timeZone)).join(", ")}. Which one do you mean?`,
    );
  }
  if (match.status === "one") {
    target = match.event;
  } else {
    const referenced = new Map<string, KnownEvent>();
    for (const change of opts.modelChanges) referenced.set(change.event.id, change.event);
    if (referenced.size === 0) {
      for (const proposal of proposals) {
        const same = events.filter((event) => sameTitle(event.title, proposal.title));
        if (same.length === 1) referenced.set(same[0].id, same[0]);
      }
    }
    if (referenced.size === 1) {
      target = [...referenced.values()][0];
    } else if (referenced.size > 1) {
      return finish(null, [], `I am not sure which event you mean: ${[...referenced.values()].map((e) => describe(e, timeZone)).join(", ")}. Please name it.`);
    } else if (mentionsCalendar(message) || opts.modelChanges.length > 0) {
      return finish(null, [], `I could not find an event matching "${request.subject || message.trim()}" in your calendar for the next 7 days.`);
    } else {
      // Not about the calendar after all ("Set a reminder ...", "Change my goals").
      return { request, changeRequest: false, changes: [], proposals, log };
    }
  }

  if (request.kind === "cancel") {
    return finish(target, [{ kind: "delete", event: target, byRule: match.status === "one" }]);
  }

  // The model's own proposal for this event, used only where the request leaves a choice.
  const chosen = target;
  const modelUpdate = opts.modelChanges.find((c) => c.kind === "update" && c.event.id === chosen.id && (c.starts_at || c.ends_at));
  const modelProposal = proposals.find((p) => coversTitle(p.title, chosen.title) || sameTitle(p.title, chosen.title));
  if (!request.day && !request.start && request.shiftMin === undefined && !request.vagueTime && !modelUpdate && !modelProposal) {
    // "Change my workout to legs": no new day or time, and the model did not move the event
    // either, so this is not a calendar change after all.
    return withoutRequest();
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
