/**
 * The chat reply the user reads must agree with the cards they approve. A small local model
 * wrote "I've moved your dentist appointment to start at 4:00 PM today" next to a card that
 * moved it to 04:00 the next day, claimed "has been moved" when nothing was moved, and copied
 * internal prompt text into the reply ("[event_id:7514bd44-...]", the template line
 * "• From — Subject — short snippet") (QA round 3, 9 Nov 2026).
 *
 * So the server cleans every reply and, when there are calendar cards, writes the confirmation
 * from the validated cards itself:
 *  - internal markers (event and email ids, aliases like [E3], bare UUIDs) and prompt template
 *    lines are removed;
 *  - sentences that claim a finished action ("has been moved", "I've scheduled", "I sent")
 *    are removed: MONDAY never changes the calendar or sends anything before the user clicks;
 *  - with calendar cards, the model's sentences that name a day or a time are removed and one
 *    line per card says what the card will do, with the card's own times.
 */
import { formatTimeInZone } from "@/server/timezone.server";
import type { EmailDraftSuggestion, PendingEvent, PendingEventChange } from "@/types/panel";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const MARKERS: RegExp[] = [
  /\s*\[(?:event[_ ]?id|id|task|email[_ ]?id|message[_ ]?id)\s*[:=][^\]\n]*\]/gi,
  /\s*\((?:event[_ ]?id|id|email[_ ]?id)\s*[:=][^)\n]*\)/gi,
  /\s*\b(?:event[_ ]?id|id)\s*[:=]\s*(?:E\d{1,3}|e\d{1,2}|[0-9a-f-]{36})\b/gi,
  /\s*\[E\d{1,3}\]/g,
  /\s*\(E\d{1,3}\)/g,
  // A calendar row copied from the prompt: "E3 14:00-15:30 Dentist appointment".
  /\bE\d{1,3}\s+(?=\d{1,2}:\d{2})/g,
  new RegExp(`\\s*\\(?\\b${UUID}\\b\\)?`, "gi"),
];

/** Lines copied from the prompt's own instructions, not about the user's data. */
const TEMPLATE_LINES: RegExp[] = [
  /^[\s•*\-–]*\**\s*from\s*\**\s*[—–-]+\s*\**\s*\*?subject\*?\s*\**\s*[—–-]+\s*(?:a\s+)?(?:short\s+|one-line\s+)?(?:snippet|summary)\.?\s*$/i,
  /^[\s•*\-–]*\**\s*sender\s*\**\s*[—–-]+\s*\**\s*\*?subject\*?\s*\**\s*[—–-]+\s*.*(?:snippet|summary)\.?\s*$/i,
  /\(x unread\)/i,
];

/** "has been moved", "I've scheduled", "I sent", "is now booked": a finished calendar or mail action. */
const ACTION_VERBS =
  "moved|rescheduled|added|saved|scheduled|booked|created|updated|changed|cancell?ed|deleted|removed|sent|blocked|shifted|postponed|applied";
const CLAIMS: RegExp[] = [
  new RegExp(`\\b(?:has|have|had)\\s+(?:now\\s+|already\\s+|successfully\\s+)?been\\s+(?:successfully\\s+)?(?:${ACTION_VERBS}|set)\\b`, "i"),
  new RegExp(`\\bI(?:'ve|\\s+have|\\s+just|\\s+already)?\\s+(?:successfully\\s+|now\\s+)?(?:${ACTION_VERBS})\\b`, "i"),
  /\b(?:is|are)\s+now\s+(?:scheduled|booked|moved|set|saved|added|in your calendar|on your calendar|cancell?ed|confirmed)\b/i,
  /\b(?:is|are)\s+(?:saved|added)\s+(?:to|in|on)\s+your\s+calendar\b/i,
  /\b(?:email|reply|message)\s+(?:is|was)\s+sent\b/i,
  // A sentence that starts with the finished action: "Moved E99.", "Done!", "Scheduled your gym
  // session." (QA round 4). A heading such as "Scheduled for Friday:" is not a claim, and neither
  // is a description ("Scheduled events today are the lecture and the team sync.").
  /^[^\p{L}\d]*(?:moved|rescheduled|added|saved|scheduled|booked|created|cancell?ed|deleted|removed|sent|blocked|shifted|postponed|drafted|done|all set)\b(?![^.!?]*:)(?!\s+(?:events?|meetings?|items?|tasks?|blocks?|emails?|drafts?|time|slots?|appointments?|sessions?|calls?)\b)/iu,
  // "Reminder set for Thursday ...": the real default model wrote this with no card at all
  // (10 Nov 2026), and "I set a reminder". MONDAY has no reminders or alarms of its own, so one
  // that "is set" is always a claim.
  /\b(?:reminders?|alarms?)\s+(?:is\s+|are\s+|was\s+|were\s+)?(?:now\s+)?(?:set|created|added|scheduled|saved)\b(?!\s+to\b)/i,
  /\bI(?:'ve|\s+have|\s+just|\s+already)?\s+set\s+(?:up\s+)?(?:a|an|the|your)\s+(?:[\w-]+\s+){0,3}?(?:reminders?|alarms?|events?|meetings?|appointments?|blocks?|sessions?|workouts?|calls?|time)\b/i,
  /\b(?:is|are)\s+(?:all\s+)?set(?:\s+up)?\s*(?:[.!]|$|for you\b)/i,
];

/**
 * After a request to DO something, in a turn that produced no card at all: these say it was
 * done. (After a question the same words can describe the calendar: "Your lecture was moved to
 * room 5", "It is on your calendar on Friday".)
 */
const NO_CARD_CLAIMS: RegExp[] = [
  // "Your appointment was moved to Friday at 4 pm.", "The session is booked."
  new RegExp(`\\b(?:is|are|was|were|got|has\\s+been|have\\s+been)\\s+(?:now\\s+|already\\s+|successfully\\s+|just\\s+)?(?:${ACTION_VERBS}|set|confirmed|dispatched|emailed|notified|drafted)\\b`, "i"),
  // "It's on your calendar now."
  /\b(?:it|this|that|your\s+[\w' -]{1,40}?|the\s+[\w' -]{1,40}?)(?:'s|\s+is|\s+are)\s+(?:now\s+|already\s+)?(?:on|in)\s+your\s+(?:calendar|schedule|agenda)\b/i,
  // The request echoed as if carried out: "Set a reminder for the dentist appointment at 13:00
  // on Thursday." (the real default model, 11 Nov 2026).
  /^[^\p{L}\d]*(?:set|added?|put|created?|scheduled?|booked?|blocked?|moved?|rescheduled?|cancell?(?:ed)?|sent|send|emailed?|drafted?|reminded?|reminder)\b\s+(?:up\s+)?(?:(?:a|an|the|your|you|for|set)\b|:)/iu,
  // Claims in the first person, promises and notifications. They count only after a request to do
  // something: after a question the same words can quote an email ("I'll send the deck tomorrow").
  // "You're all set!", "Consider it done."
  /\b(?:you(?:'re|\s+are)|we(?:'re|\s+are)|that(?:'s|\s+is)|it(?:'s|\s+is)|everything(?:'s|\s+is))\s+all\s+set\b|\bconsider\s+it\s+done\b|\b(?:it(?:'s|\s+is)|that(?:'s|\s+is))\s+(?:been\s+)?taken\s+care\s+of\b/i,
  // "I emailed Sam", "I've put it on your calendar", "I notified the team".
  /\bI(?:'ve|\s+have|\s+just|\s+already)?\s+(?:successfully\s+|now\s+|just\s+)?(?:emailed|e-mailed|mailed|messaged|texted|notified|informed|replied\s+to|responded\s+to|confirmed|invited|reminded|put(?!\s+together)|placed|pencill?ed|dispatched|forwarded|noted)\b/i,
  // "I'll remind you at 5 pm", "I will send it": MONDAY does nothing later on its own.
  /\bI(?:'ll|\s+will|\s+am\s+going\s+to|'m\s+going\s+to)\s+(?:remind|notify|alert|email|e-mail|send|message|text|let\s+\w+\s+know|add|move|schedule|book|cancel|put|set|create|block|reschedule|forward|confirm)\b/i,
  // "This reminder will appear in your notifications", "You'll get a reminder": there are none.
  /\b(?:will|'ll)\s+(?:appear|show\s+up|pop\s+up)\b|\byou(?:'ll|\s+will)\s+(?:be\s+(?:reminded|notified|alerted)|(?:get|receive|see)\s+an?\s+(?:reminder|notification|alert))\b/i,
  // "The email was dispatched to Sam.", "Your calendar is updated."
  /\b(?:e-?mail|reply|message|invite|invitation)\s+(?:has\s+been|was|is|got)\s+(?:successfully\s+)?(?:sent|dispatched|delivered|forwarded)\b/i,
  /\byour\s+(?:calendar|schedule)\s+(?:is|was|has\s+been)\s+(?:now\s+)?(?:updated|changed)\b/i,
];

/**
 * In the answer to a request for something new or for a change ("Set up a gym session ...",
 * "Move ..."): "Your gym session is scheduled for 6 pm" says it is done. In the answer to a
 * question ("When is my dentist appointment?") the same words describe the calendar ("Your
 * dentist appointment is scheduled for Wednesday at 2 pm") and must stay.
 */
const ACTION_REQUEST_CLAIMS: RegExp[] = [
  /\b(?:events?|meetings?|appointments?|blocks?|sessions?|workouts?|calls?)\s+(?:is\s+|are\s+)?(?:now\s+)?(?:set|created|added|scheduled|booked|saved)\b(?!\s+to\b)/i,
];

const WEEKDAY_INDEX: Record<string, number> = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
  sun: 0, mon: 1, tue: 2, tues: 2, wed: 3, thu: 4, thur: 4, thurs: 4, fri: 5, sat: 6,
};
const MONTH_INDEX: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

/**
 * A weekday next to a date it is not ("Thursday 2026-11-14", "Thu, Nov 14" when Nov 14 is a
 * Saturday): the real default model wrote that on 10 Nov 2026. `year` is used for dates without one.
 */
export function hasWrongWeekday(sentence: string, year: number): boolean {
  // A date without a year is this year's or (in December, about January) next year's.
  const weekdayOf = (y: number, mo: number, d: number): number | null => {
    const date = new Date(Date.UTC(y, mo - 1, d, 12));
    return Number.isFinite(date.getTime()) && date.getUTCDate() === d ? date.getUTCDay() : null;
  };
  const text = sentence.toLowerCase();
  const pattern =
    /\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tues?|wed|thu(?:rs?)?|fri|sat)\b,?\s+(?:(\d{4})-(\d{2})-(\d{2})|(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})|(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*)\b/g;
  for (const m of text.matchAll(pattern)) {
    const weekday = WEEKDAY_INDEX[m[1]];
    const [mo, d] = m[2] ? [Number(m[3]), Number(m[4])] : m[5] ? [MONTH_INDEX[m[5]], Number(m[6])] : [MONTH_INDEX[m[8]], Number(m[7])];
    const readings = (m[2] ? [Number(m[2])] : [year, year + 1]).map((y) => weekdayOf(y, mo, d)).filter((value) => value !== null);
    if (readings.length > 0 && !readings.includes(weekday)) return true;
  }
  return false;
}

/** "Draft ready.", "Here's a draft", "I've drafted a reply": a draft that must be on a card. */
const DRAFT_CLAIMS: RegExp[] = [
  /\b(?:draft|reply|response)\b[^.!?\n]{0,40}?\b(?:ready|prepared|done|created|written|below|attached|saved|on the right|under insights)\b/i,
  /\bI(?:'ve|\s+have)?\s+(?:drafted|written|prepared|composed)\b/i,
  /\bhere(?:'s|\s+is)\s+(?:a|the|your)\s+(?:draft|reply|response)\b/i,
];

/** Talk about moving or cancelling an event, for a turn that has no change card. */
const CHANGE_TALK = /\b(?:mov(?:e|ed|ing)|reschedul\w*|postpon\w*|cancel\w*|push(?:ed|ing)?\s+back|shift(?:ed|ing)?)\b/i;

/**
 * The short ids of the prompt: events "E1", "E2", ... (upper case) and emails "e1", "e2", ...
 * (lower case), each with the name the user knows it by.
 */
export interface ReplyRefs {
  events?: Record<string, string>;
  emails?: Record<string, string>;
}

/** A day or a clock time in a sentence. */
const TIME_WORDS =
  /\b\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.)|\b\d{1,2}[:.]\d{2}\b|\b(?:today|tonight|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|noon|midnight)\b|\b\d{4}-\d{2}-\d{2}\b/i;

/** "Wed, Nov 11, 4:00 PM – 5:30 PM" in the user's time zone (the end date only when it differs). */
export function describeRange(startsAt: string, endsAt: string, timeZone = "UTC"): string {
  const day = (iso: string) =>
    new Date(iso).toLocaleDateString("en-US", { timeZone, weekday: "short", month: "short", day: "numeric" });
  const startDay = day(startsAt);
  const endDay = day(endsAt);
  return `${startDay}, ${formatTimeInZone(startsAt, timeZone)} – ${endDay === startDay ? "" : `${endDay}, `}${formatTimeInZone(endsAt, timeZone)}`;
}

/** Remove internal ids and prompt template lines; tidy the spaces and empty lines left behind. */
export function stripInternalMarkers(text: string): string {
  let out = text ?? "";
  for (const re of MARKERS) out = out.replace(re, "");
  // A bullet that starts with a short id: "- E3 Dentist appointment" -> "- Dentist appointment".
  out = out.replace(/^(\s*(?:[-*•]|\d+[.)])\s+)E\d{1,3}\s+/gm, "$1");
  const lines = out
    .split("\n")
    .filter((line) => !TEMPLATE_LINES.some((re) => re.test(line)))
    .map((line) => line.replace(/[ \t]{2,}/g, " ").replace(/\s+([,.;:])/g, "$1").replace(/[ \t]+$/, ""));
  return collapseBlankLines(lines).join("\n").trim();
}

function collapseBlankLines(lines: string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    if (line.trim() === "" && (out.length === 0 || out[out.length - 1].trim() === "")) continue;
    out.push(line);
  }
  while (out.length > 0 && out[out.length - 1].trim() === "") out.pop();
  return out;
}

/** Split a line into sentences; a bullet line counts as one sentence. */
function sentencesOf(line: string): string[] {
  if (/^\s*(?:[-*•]|\d+[.)])\s/.test(line)) return [line];
  return line.split(/(?<=[.!?])\s+(?=[A-Z*_"'(\u{1F300}-\u{1FAFF}])/u);
}

/** Remove the sentences that match; returns the text and how many were removed. */
export function removeSentences(text: string, matches: (sentence: string) => boolean): { text: string; removed: number } {
  let removed = 0;
  const lines = (text ?? "").split("\n").map((line) => {
    const kept = sentencesOf(line).filter((sentence) => {
      if (matches(sentence)) {
        removed++;
        return false;
      }
      return true;
    });
    return kept.join(" ");
  });
  // A heading or an intro line ("**📅 Today**", "Here is your schedule:") left without content.
  const cleaned: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isHeading = /^\s*(?:\*\*[^*]+\*\*|#{1,6}\s.+|[^\w\s]{0,4}\s*\*?[A-Z][\w ]{0,30}\*?:?)\s*$/u.test(line) || /:\s*$/.test(line);
    if (isHeading && removed > 0) {
      const next = lines.slice(i + 1).find((l) => l.trim() !== "");
      const nextIsHeading = next === undefined || /^\s*(?:\*\*[^*]+\*\*|#{1,6}\s)/.test(next);
      if (nextIsHeading) continue;
    }
    cleaned.push(line);
  }
  return { text: collapseBlankLines(cleaned).join("\n").trim(), removed };
}

/** `actionRequest`: the user asked for something new or for a change (see ACTION_REQUEST_CLAIMS). */
export function removeActionClaims(text: string, actionRequest = false): { text: string; removed: number } {
  const patterns = actionRequest ? [...CLAIMS, ...ACTION_REQUEST_CLAIMS] : CLAIMS;
  return removeSentences(text, (sentence) => patterns.some((re) => re.test(sentence)));
}

export function removeTimeStatements(text: string): { text: string; removed: number } {
  return removeSentences(text, (sentence) => TIME_WORDS.test(sentence));
}

/** One line per card, with the card's own times. */
export function cardConfirmations(opts: {
  pendingEvents: PendingEvent[];
  pendingEventChanges: PendingEventChange[];
  timeZone: string;
  /** Notes per card id, for example a conflict that will make Save refuse. */
  notes?: Record<string, string>;
}): string[] {
  const { timeZone } = opts;
  const lines: string[] = [];
  for (const change of opts.pendingEventChanges) {
    const original = describeRange(change.original.starts_at, change.original.ends_at, timeZone);
    let line: string;
    if (change.kind === "delete") {
      line = `Ready to cancel **${change.original.title}** (${original}). Nothing is cancelled until you click **Cancel event** on the right.`;
    } else {
      const next = change.next ?? {};
      const moved = next.starts_at && next.ends_at ? describeRange(next.starts_at, next.ends_at, timeZone) : null;
      const renamed = next.title ? ` and rename it to **${next.title}**` : "";
      line = moved
        ? `Ready to move **${change.original.title}** from ${original} to **${moved}**${renamed}. Nothing changes until you click **Save changes** on the right.`
        : `Ready to rename **${change.original.title}** (${original}) to **${next.title}**. Nothing changes until you click **Save changes** on the right.`;
    }
    const note = opts.notes?.[change.id];
    lines.push(note ? `${line} ${note}` : line);
  }
  if (opts.pendingEvents.length > 0) {
    const items = opts.pendingEvents.map((event) => {
      const note = opts.notes?.[event.id];
      return `- **${event.title}**: ${describeRange(event.starts_at, event.ends_at, timeZone)}${note ? ` (${note})` : ""}`;
    });
    lines.push(
      `Proposed for your calendar:\n${items.join("\n")}\nNothing is saved until you click **Save to Calendar** on the right.`,
    );
  }
  return lines;
}

/**
 * Short ids left in the text after stripInternalMarkers: a known one becomes the event's title
 * or the email's name; a sentence that names an id the prompt never had ("Moved E99.") is about
 * something that does not exist and is removed.
 */
export function resolveRefs(text: string, refs: ReplyRefs): { text: string; removed: number } {
  const known = (id: string) => (/^E/.test(id) ? refs.events?.[id] : refs.emails?.[id]);
  // Only the kinds of id the prompt used: Gmail message ids are long, not "e3".
  const idPattern = new RegExp(`\\b(${[refs.events ? "E\\d{1,3}" : "", refs.emails ? "e\\d{1,2}" : ""].filter(Boolean).join("|") || "(?!)"})\\b`, "g");
  const result = removeSentences(text ?? "", (sentence) => [...sentence.matchAll(idPattern)].some((m) => !known(m[1])));
  return { text: result.text.replace(idPattern, (id) => known(id) ?? id), removed: result.removed };
}

/** The whole reply when the model's text said only that something was done, and nothing was. */
export const NOTHING_PREPARED =
  "The AI model answered without a valid proposal, so nothing was prepared or changed. Please try again, naming the day and the time.";
/** Added under the model's text when an action was asked for and the turn has no card. */
export const NOTHING_ADDED =
  "Nothing was added to your calendar, saved or sent in this turn: the AI model gave no proposal to approve. If you expected one, please try again, naming the day and the time.";
/** The same when the turn has a reply draft but no calendar card for the calendar part of the request. */
export const NOTHING_ON_CALENDAR =
  "Nothing was added to or changed in your calendar in this turn: the AI model proposed no calendar entry. If you expected one, please try again, naming the day and the time.";

export function composeReply(opts: {
  modelReply: string;
  timeZone: string;
  pendingEvents: PendingEvent[];
  pendingEventChanges: PendingEventChange[];
  emailDraft?: EmailDraftSuggestion;
  /** The request asked to move or cancel an event: the reply is built from the result only. */
  changeRequest?: boolean;
  /** Why a requested change has no card (a question back, or the reason it was refused). */
  changeNote?: string;
  notes?: Record<string, string>;
  /** Other cards the turn produced (insight, alternatives), for an otherwise empty reply. */
  hasOtherCards?: boolean;
  /** The prompt's short ids and what they stand for (see resolveRefs). */
  refs?: ReplyRefs;
  /** Why a requested reply draft has no card (the model named an email that is not in the inbox). */
  emailNote?: string;
  /** The year for dates the model wrote without one (default: this year). */
  year?: number;
  /** The user asked for something new or for a change, not a question (see ACTION_REQUEST_CLAIMS). */
  actionRequest?: boolean;
  /**
   * The user asked MONDAY to do something: a calendar entry or change, a reminder, an email or
   * a message (asksForAction). When such a turn ends without any card, nothing was prepared:
   * the reply says so, whatever the model wrote (QA round 5).
   */
  askedForAction?: boolean;
  /**
   * The change note is only about a change the model made unasked (it was left out). After a
   * question ("When is my dentist appointment?") the model's answer, with its times, stands.
   */
  changeNoteIsAside?: boolean;
}): string {
  const cleaned = stripInternalMarkers(opts.modelReply);
  const resolved = opts.refs ? resolveRefs(cleaned, opts.refs) : { text: cleaned, removed: 0 };
  // A weekday that is not its date's ("Thursday 2026-11-14") is wrong either way: drop it.
  const year = opts.year ?? new Date().getUTCFullYear();
  const weekdays = removeSentences(resolved.text, (sentence) => hasWrongWeekday(sentence, year));
  const claims = removeActionClaims(weekdays.text, opts.actionRequest ?? false);
  claims.removed += weekdays.removed;
  const calendarTurn = opts.pendingEvents.length > 0 || opts.pendingEventChanges.length > 0 || Boolean(opts.changeNote);

  let modelText = claims.text;
  if (opts.changeRequest) modelText = "";
  else if (calendarTurn) {
    const answerStands = opts.changeNoteIsAside && !opts.actionRequest && opts.pendingEvents.length === 0 && opts.pendingEventChanges.length === 0;
    if (!answerStands) modelText = removeTimeStatements(modelText).text;
    // "Ready to move your dentist appointment." next to a NEW event card (QA round 4): with no
    // change card, nothing is being moved or cancelled.
    if (opts.pendingEventChanges.length === 0) modelText = removeSentences(modelText, (sentence) => CHANGE_TALK.test(sentence)).text;
  }
  // "Draft ready." with no draft card (QA round 4: an email id the inbox does not have).
  let draftClaims = 0;
  if (!opts.emailDraft) {
    const withoutDraftClaims = removeSentences(modelText, (sentence) => DRAFT_CLAIMS.some((re) => re.test(sentence)));
    modelText = withoutDraftClaims.text;
    draftClaims = withoutDraftClaims.removed;
  }

  // An action was asked for and the turn has no card and no note: nothing was prepared. The
  // real default model answered "Set a reminder for the dentist appointment at 13:00 on
  // Thursday. This reminder will appear in your notifications" with no card (QA round 5); a
  // phrase list alone always misses some wording. So the sentences that say it was done are
  // removed, and whatever is left (a question back, a plan in words) is followed by a plain
  // statement that nothing was added, saved or sent.
  //
  // What counts is a card of the kind that was asked for (review of 11 Nov 2026): an insight or
  // a priorities card next to "Add a yoga session ..." prepared no calendar entry either, and a
  // reply draft next to "Add a yoga session and draft a reply" covers only the draft.
  const noCalendarCard = opts.pendingEvents.length === 0 && opts.pendingEventChanges.length === 0;
  const calendarMissing = Boolean(opts.actionRequest) && noCalendarCard;
  const allMissing = Boolean(opts.askedForAction) && noCalendarCard && !opts.emailDraft;
  let notice: string | null = null;
  if (calendarMissing || allMissing) {
    // Words the model quotes ("Sam wrote: \"I'll send the deck\"") are not its own claims.
    const unquoted = (sentence: string) => sentence.replace(/"[^"\n]*"|“[^”\n]*”/g, " ");
    modelText = removeSentences(modelText, (sentence) => NO_CARD_CLAIMS.some((re) => re.test(unquoted(sentence)))).text;
    // A note about the change that was asked for already says that nothing changed.
    if (!opts.changeNote && !opts.emailNote) notice = opts.emailDraft ? NOTHING_ON_CALENDAR : NOTHING_ADDED;
  }

  const lines: string[] = [];
  if (modelText) lines.push(modelText);
  if (opts.changeNote) lines.push(`${opts.changeNote} Nothing in your calendar was changed.`);
  if (opts.emailNote) lines.push(opts.emailNote);
  lines.push(...cardConfirmations(opts));
  if (opts.emailDraft && (claims.removed > 0 || !modelText)) {
    lines.push(`The reply to ${opts.emailDraft.to} is under **Insights** as a draft suggestion. Edit it and click **Save as draft**; nothing is sent.`);
  }
  if (notice) {
    // Nothing else to show: the short notice. Another card on the right is not what was asked for.
    if (lines.length === 0) return opts.hasOtherCards ? notice : NOTHING_PREPARED;
    lines.push(notice);
  }
  if (lines.length > 0) return lines.join("\n\n");
  if (opts.hasOtherCards) return "See the card on the right.";
  if (draftClaims > 0 && claims.removed === 0 && resolved.removed === 0) {
    return "The AI model answered without a reply draft, so nothing was prepared. Please try again and say which email you want to answer.";
  }
  if (claims.removed > 0 || resolved.removed > 0) return NOTHING_PREPARED;
  return "I'm not sure how to help with that. Could you rephrase it?";
}
