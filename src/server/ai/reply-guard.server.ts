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
/** What may stand between a short id and the rest of a copied row: "E1: ", "E1. ", "E1 — ". */
const ID_SEPARATOR = "\\s*[:.)\\-–—]?\\s+";
const MARKERS: RegExp[] = [
  /\s*\[(?:event[_ ]?id|id|task|email[_ ]?id|message[_ ]?id)\s*[:=][^\]\n]*\]/gi,
  /\s*\((?:event[_ ]?id|id|email[_ ]?id)\s*[:=][^)\n]*\)/gi,
  /\s*\b(?:event[_ ]?id|id)\s*[:=]\s*(?:E\d{1,3}|e\d{1,2}|[0-9a-f-]{36})\b/gi,
  /\s*\[E\d{1,3}\]/g,
  /\s*\(E\d{1,3}\)/g,
  // A calendar row copied from the prompt: "E3 14:00-15:30 Dentist appointment", also with a
  // separator after the id ("E1: 19:00", "E1 — 19:00"). With only whitespace allowed, "E1:" was
  // kept and later replaced by the title, so the title showed twice (review of 24 Nov 2026).
  new RegExp(`\\bE\\d{1,3}${ID_SEPARATOR}(?=\\d{1,2}:\\d{2})`, "g"),
  new RegExp(`\\s*\\(?\\b${UUID}\\b\\)?`, "gi"),
  // The prompt's own annotations of the inbox: " (UNREAD)" (upper case, so a model's own
  // "(unread)" in prose stays), " (task: Lunch with Sam, importance low)" (a task title may hold
  // one pair of brackets of its own), a bare importance tag, and the prompt's note that an email
  // is about a calendar event. Two of three live briefings copied them (review of 24 Nov 2026).
  /[ \t]*\(UNREAD\)/g,
  /[ \t]*\(task\s*:(?:[^()\n]|\([^()\n]*\))*\)/gi,
  /[ \t]*\(importance\s*[:=]?\s*(?:high|medium|low)\)/gi,
  /[ \t]*\(same (?:meeting|commitment) as calendar event[^)\n]*\)/gi,
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
  // Near variants of the claims above that got through (review of 24 Nov 2026): "Your reminder
  // is all set for Thursday", "... is in the calendar", "Sam has been told", "locked in",
  // "Done — yoga is on for tomorrow", "I'll make sure you remember".
  /\b(?:is|are)\s+all\s+set\b/i,
  /\b(?:is|are)\s+(?:now\s+)?(?:in|on)\s+(?:the|your)\s+(?:calendar|schedule|agenda)\b/i,
  /\b(?:has|have)\s+been\s+(?:told|informed|let\s+know)\b/i,
  /\blocked\s+in\b/i,
  /^[^\p{L}\d]*done\b/iu,
  /\bI(?:'ll|\s+will)\s+make\s+sure\b/i,
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
 * A month word, whole: "nov", "november", "sept". Until the review of 24 Nov 2026 any word that
 * began like a month counted ("3 marketing calls" read as 3 March, "2 decks" as 2 December), so
 * a correct sentence was dropped as a wrong weekday.
 */
const MONTH_WORD =
  "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\b";

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
  const pattern = new RegExp(
    `\\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tues?|wed|thu(?:rs?)?|fri|sat)\\b,?\\s+(?:(\\d{4})-(\\d{2})-(\\d{2})|${MONTH_WORD}\\.?\\s+(\\d{1,2})|(\\d{1,2})\\s+${MONTH_WORD})\\b`,
    "g",
  );
  for (const m of text.matchAll(pattern)) {
    const weekday = WEEKDAY_INDEX[m[1]];
    const [mo, d] = m[2]
      ? [Number(m[3]), Number(m[4])]
      : m[5]
        ? [MONTH_INDEX[m[5].slice(0, 3)], Number(m[6])]
        : [MONTH_INDEX[m[8].slice(0, 3)], Number(m[7])];
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
  // A bullet that starts with a short id: "- E3 Dentist appointment" -> "- Dentist appointment",
  // also "- E1: Team sync" and "- E1 — Team sync".
  out = out.replace(new RegExp(`^(\\s*(?:[-*•]|\\d+[.)])\\s+)E\\d{1,3}${ID_SEPARATOR}`, "gm"), "$1");
  // "• item" lines are not a Markdown list: the chat showed them run together as one paragraph
  // (review of 24 Nov 2026). They become "- item" lines; the prompt also asks for "- ".
  out = out.replace(/^([ \t]*)[•●▪◦‣][ \t]+(?=\S)/gm, "$1- ");
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

/** Words the model quotes ("Sam wrote: \"I'll send the deck\"") are not its own claims. */
export function unquoted(sentence: string): string {
  return sentence.replace(/"[^"\n]*"|“[^”\n]*”/g, " ");
}

/**
 * Words that report what an email or a person said: "Alicia's email says the team sync has been
 * moved to 7 PM", "Stripe says your invoice has been sent", "according to Sam's message ...".
 */
const ATTRIBUTION =
  /\b(?:says?|said|wrote|writes|mentions?|mentioned|according\s+to|per\s+(?:the|his|her|their|your)\b[^.!?]*\b(?:e-?mail|message)|(?:e-?mail|message|subject|note|invitation|invite)\b[^.!?]*\b(?:says?|reads?|states?|mentions?))\b/i;
/** "Alicia's email: the team sync has been moved ...", "Email from Sam: ...". */
const ATTRIBUTION_COLON =
  /\b[\p{L}\p{N}.-]+(?:'s|’s)\s+(?:(?:latest|last|new|recent|earlier)\s+)?(?:e-?mail|message|note|reply|invitation|invite)\s*(?:\*\*|__)?\s*:|\b(?:e-?mail|message|note)\s+from\s+[^:.!?\n]{1,60}:/iu;
/** The user's own words ("as you said") are not an email's: they do not make a claim reported speech. */
const USER_SPEECH = /\b(?:you|i|we)\s+(?:just\s+|already\s+)?(?:say|says|said|wrote|write|mention|mentioned)\b/gi;
/**
 * A line of an inbox summary in the prompt's own format: a bullet, the sender in bold, then a
 * dash or the subject in italics ("- **Alicia** — *Team sync moved to 7 PM today* — The team
 * sync has been moved ..."). The whole line reports the email.
 */
const INBOX_BULLET = /^\s*(?:[-*•]|\d+[.)])\s+(?:\*\*[^*\n]+\*\*|__[^_\n]+__)\s*(?:[—–:-]|[*_](?=\S))/u;

/** Does the sentence report what an email or a person said, wherever the attribution stands? */
function reportsSpeech(sentence: string): boolean {
  if (INBOX_BULLET.test(sentence) || ATTRIBUTION_COLON.test(sentence)) return true;
  return ATTRIBUTION.test(sentence.replace(USER_SPEECH, " "));
}

/**
 * `actionRequest`: the user asked for something new or for a change (see ACTION_REQUEST_CLAIMS).
 * `question`: the user asked a question and asked for nothing to be done (neither actionRequest
 * nor askedForAction). Then a sentence that reports what an email or a person said is an
 * answer, not the model's claim: "Alicia's email says the team sync has been moved to 7 PM
 * today", "... has been moved to 7 PM, according to Alicia's email", "Alicia's message: ..."
 * and a line of an inbox summary ("- **Stripe** — *Invoice* — Your invoice has been sent.").
 * The review of 24 Nov 2026 saw such sentences removed, and with them the most urgent email of
 * an inbox summary, or the whole summary. Quoted words never count as a claim. The claims that
 * are never reported speech (a sentence that starts "Done", a reminder that "is set", "is all
 * set") are removed in every turn.
 */
export function removeActionClaims(
  text: string,
  actionRequest = false,
  opts: { question?: boolean } = {},
): { text: string; removed: number } {
  const patterns = actionRequest ? [...CLAIMS, ...ACTION_REQUEST_CLAIMS] : CLAIMS;
  // The claim patterns that also read reported speech: "has been moved", "I sent", "is now
  // confirmed", "is added to your calendar", "the email was sent".
  const reportable = new Set(CLAIMS.slice(0, 5));
  return removeSentences(text, (sentence) => {
    const own = unquoted(sentence);
    const reported = Boolean(opts.question) && reportsSpeech(own);
    return patterns.some((re) => re.test(own) && !(reported && reportable.has(re)));
  });
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
    // A blank line before the closing sentence: after a single line break Markdown reads it as
    // part of the last bullet ("... 8:00 AM Nothing is saved ...", review of 24 Nov 2026).
    lines.push(
      `Proposed for your calendar:\n${items.join("\n")}\n\nNothing is saved until you click **Save to Calendar** on the right.`,
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
  // An id that starts a row of a line that already names its event ("E1: 19:00–20:00 Team sync
  // — demo walkthrough", "Today: E1 Team sync ...") is dropped with the separator after it;
  // replacing it would show the title twice (review of 24 Nov 2026). Anywhere else the id
  // becomes the name ("You have E1 at 7", "... is E1."): dropping it there left a sentence cut
  // off in the middle ("Reminder: Team sync — demo walkthrough is ").
  const withSeparator = new RegExp(`${idPattern.source}(\\s*[:.)\\-–—]?\\s*)`, "g");
  const lines = result.text.split("\n").map((line) =>
    line.replace(withSeparator, (whole, id: string, separator: string, offset: number) => {
      const name = known(id);
      if (!name) return whole;
      const before = line.slice(0, offset);
      const after = line.slice(offset + whole.length);
      const rowPrefix =
        /^\s*(?:(?:[-*•]|\d+[.)])\s+)?(?:\*\*|__)?\s*$/.test(before) ||
        /^\s*\d{1,2}[:.]\d{2}/.test(after) ||
        after.toLowerCase().startsWith(name.toLowerCase());
      return rowPrefix && line.toLowerCase().includes(name.toLowerCase()) ? "" : `${name}${separator}`;
    }),
  );
  return { text: lines.join("\n"), removed: result.removed };
}

/**
 * The server's own card lines (cardConfirmations). The model copies them from its earlier replies
 * in the chat history (live, 19 Nov 2026: an empty "Proposed for your calendar:" block before the
 * real one). Only the server writes them, from the validated cards, so the model's copies go.
 */
const SERVER_CARD_BLOCK = /^[ \t]*Proposed for your calendar:.*(?:\n[ \t]*(?:[-*•]|\d+[.)])\s.*)*/gim;
const SERVER_CARD_SENTENCES: RegExp[] = [
  /\bNothing (?:is saved|changes|is cancell?ed) until you click\b/i,
  /^[^\p{L}\d]*Ready to (?:move|rename|cancel) \*\*/iu,
];
export function removeServerLines(text: string): { text: string; removed: number } {
  const withoutBlocks = (text ?? "").replace(SERVER_CARD_BLOCK, "");
  const result = removeSentences(withoutBlocks, (sentence) => SERVER_CARD_SENTENCES.some((re) => re.test(sentence)));
  return { text: result.text, removed: result.removed + (withoutBlocks === (text ?? "") ? 0 : 1) };
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
/**
 * After a request to send an email or a message: MONDAY never sends, so "try again, naming the
 * day and the time" was the wrong advice (review of 24 Nov 2026). This says where drafts go.
 */
export const NOTHING_SENT =
  "MONDAY never sends emails or messages itself. Ask it to draft a reply to an email in your inbox: the draft appears under **Insights**, where you can edit it and click **Save as draft**, and you send it yourself from your mail app.";
/**
 * The whole reply to a QUESTION when nothing the model wrote could be kept. NOTHING_PREPARED
 * speaks of a proposal and of "naming the day and the time", which does not fit a question
 * (review of 24 Nov 2026). Worded so that a short message after it is not read as an answer to
 * a question back (see followsUpOnAction).
 */
export const NOTHING_ANSWERED =
  "The AI model's answer could not be checked against your calendar and inbox, so it is not shown. Your calendar was not changed. Please try again or ask in other words.";

/**
 * A sentence that states a day or a time ("Your yoga session is on for tomorrow at 18:00."),
 * after a request to add something to the calendar in a turn with no calendar card: with no card
 * it is a claim or an echo of the request either way (review of 24 Nov 2026). Questions, bullet
 * lines (a plan in words), intro lines ending in a colon and suggestions stay.
 */
function isDatedStatement(sentence: string): boolean {
  const text = sentence.trim();
  if (!TIME_WORDS.test(text)) return false;
  if (/\?\s*["')\]]?\s*$/.test(text) || /:\s*$/.test(text)) return false;
  if (/^\s*(?:[-*•]|\d+[.)])\s/.test(text)) return false;
  return !/\b(?:could|would|might|may|can|shall|should|how about|what about|suggest\w*|options?|prefer\w*|if you)\b/i.test(text);
}

/** Lowercase letters and digits only, for comparing a reply with a draft body. */
function comparable(text: string): string {
  return (text ?? "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, " ").trim();
}

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
  /**
   * The user asked MONDAY to send an email or a message (asksToSend). It never sends, so a turn
   * without a draft card says where drafts go instead of asking for a day and a time.
   */
  sendRequest?: boolean;
}): string {
  const cleaned = stripInternalMarkers(opts.modelReply);
  const resolved = opts.refs ? resolveRefs(cleaned, opts.refs) : { text: cleaned, removed: 0 };
  // A weekday that is not its date's ("Thursday 2026-11-14") is wrong either way: drop it.
  const year = opts.year ?? new Date().getUTCFullYear();
  const serverLines = removeServerLines(resolved.text);
  const weekdays = removeSentences(serverLines.text, (sentence) => hasWrongWeekday(sentence, year));
  // A question: the user asked for nothing to be done (see removeActionClaims).
  const question = !opts.actionRequest && !opts.askedForAction;
  const claims = removeActionClaims(weekdays.text, opts.actionRequest ?? false, { question });
  claims.removed += weekdays.removed + serverLines.removed;
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
  } else if (modelText) {
    // The model repeated the draft in the chat (live, 24 Nov 2026: the reply was the draft body
    // word for word). The draft is on its card; the chat says where.
    // Also when the card's body has more (the sign-off the server adds) than the repeated text.
    const body = comparable(opts.emailDraft.body);
    const text = comparable(modelText);
    if (body && (text.includes(body) || (text.length >= 40 && body.includes(text)))) modelText = "";
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
  // A request to send something, with no draft card: MONDAY never sends (see NOTHING_SENT).
  const sendMissing = Boolean(opts.sendRequest) && allMissing;
  if (calendarMissing || allMissing) {
    modelText = removeSentences(modelText, (sentence) => NO_CARD_CLAIMS.some((re) => re.test(unquoted(sentence)))).text;
    // With no calendar card a sentence that gives a day or a time is a claim or an echo of the
    // request ("... is all set for Thursday at 13:00", "... now starts tomorrow at 18:00").
    if (calendarMissing) modelText = removeSentences(modelText, (sentence) => isDatedStatement(unquoted(sentence))).text;
    // A note about the change that was asked for already says that nothing changed.
    if (!opts.changeNote && !opts.emailNote) {
      notice = sendMissing ? NOTHING_SENT : opts.emailDraft ? NOTHING_ON_CALENDAR : NOTHING_ADDED;
    }
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
    if (lines.length === 0) return opts.hasOtherCards || sendMissing ? notice : NOTHING_PREPARED;
    lines.push(notice);
  }
  if (lines.length > 0) return lines.join("\n\n");
  if (opts.hasOtherCards) return "See the card on the right.";
  if (draftClaims > 0 && claims.removed === 0 && resolved.removed === 0) {
    return "The AI model answered without a reply draft, so nothing was prepared. Please try again and say which email you want to answer.";
  }
  // Everything the model wrote was removed. After a question nothing was asked for, so the
  // notice about a missing proposal and "naming the day and the time" do not fit.
  if (claims.removed > 0 || resolved.removed > 0) return question ? NOTHING_ANSWERED : NOTHING_PREPARED;
  return "I'm not sure how to help with that. Could you rephrase it?";
}

/** "14:00" on a 24-hour clock as "2:00 PM", as the cards and pages show times. */
function twelveHour(hour: number, minute: string): string {
  const suffix = hour >= 12 ? "PM" : "AM";
  return `${hour % 12 === 0 ? 12 : hour % 12}:${minute} ${suffix}`;
}

/** A clock time "H:MM" that can only be a 24-hour time: 13-23, 0 or 12, or a leading zero. */
function isClearly24h(hourText: string): boolean {
  const hour = Number(hourText);
  return hour >= 12 || hour === 0 || (hourText.length === 2 && hourText.startsWith("0"));
}

/** "H:MM" without am/pm, not part of an ISO date-time ("2026-11-24T14:00") or a longer number. */
const CLOCK = /(?<![\dT:.])([01]?\d|2[0-3]):([0-5]\d)(?![\d:]|\s*[ap]\.?\s?m\b)/gi;
/** Stands in for each character of quoted text while the times are read (not a digit, a letter or punctuation). */
const QUOTE_MASK = "░";
const DAY_WORD =
  "(?:today|tonight|tomorrow|mon(?:day)?|tues?(?:day)?|wed(?:nesday)?|thu(?:rs?)?(?:day)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)";
const MONTH_NAME = "(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?";
/** Text right before a clock time that makes it one: "at", "from", "until", a day or a date. */
const TIME_BEFORE = new RegExp(
  `(?:(?:\\b(?:at|from|to|until|till|til|between|by|before|after|around|starts?|starting|begins?|ends?|ending)|@)\\s*|\\b(?:${DAY_WORD}|\\d{4}-\\d{2}-\\d{2}|${MONTH_NAME}\\s+\\d{1,2}|\\d{1,2}\\s+${MONTH_NAME}),?\\s*)$`,
  "i",
);
/** Text right after a clock time that makes it one: "14:00 on Friday", "14:00 tomorrow". */
const TIME_AFTER = new RegExp(`^\\s*,?\\s*(?:on\\s+|this\\s+|next\\s+)?${DAY_WORD}\\b`, "i");
/** A line or a list item that starts with the time: "- 14:00 review the notes". */
const ROW_START = /^\s*(?:(?:[-*•]|\d+[.)])\s+)?(?:\*\*|__)?\s*$/;
/** A list item, where "Dentist appointment: 14:00" and "Team sync (19:00)" give an event's time. */
const LIST_ITEM = /^\s*(?:[-*•]|\d+[.)])\s/;

/**
 * The reply's 24-hour clock times ("14:00", "14:00–15:30") written the way the cards and pages
 * show them ("2:00 PM", "2:00 PM – 3:30 PM"). The prompt gives the model every time on a 24-hour
 * clock (the fields it returns need that form), and it wrote them into the chat as well, next
 * to cards with 12-hour times (review of 24 Nov 2026).
 *
 * Only numbers that stand as a time are changed: after "at", "from", "to", "until", "between"
 * and the like, in a range ("14:00–15:30", "between 9:00 and 17:00"), next to a day or a date,
 * at the start of a line or list item, or after "title:" or "title (" in a list item ("- Dentist
 * appointment: 14:00"). A price ("12:50 CHF"), a ratio ("16:10") or a score
 * stays as it is. A time that can only be 24-hour (13-23, 0, 12, or a leading zero) is changed;
 * one that could be either ("9:00") is changed when its sentence or range also has a clearly
 * 24-hour time, so "From 9:00 to 17:00" becomes "From 9:00 AM to 5:00 PM", not half of it.
 * Times with am/pm, ISO date-times and quoted text (an email's own words) stay as they are.
 */
export function toTwelveHourClock(text: string): string {
  return (text ?? "").split("\n").map(lineToTwelveHourClock).join("\n");
}

function lineToTwelveHourClock(line: string): string {
  // Quoted text is masked (same length, so the offsets hold): its times are neither changed nor
  // counted.
  const masked = line.replace(/"[^"\n]*"|“[^”\n]*”/g, (quote) => QUOTE_MASK.repeat(quote.length));
  const found = [...masked.matchAll(CLOCK)].map((m) => ({
    start: m.index ?? 0,
    end: (m.index ?? 0) + m[0].length,
    hour: m[1],
    minute: m[2],
    range: -1,
    inContext: false,
    sentence: 0,
  }));
  if (found.length === 0) return line;
  // Ranges: "14:00–15:30", "14:00 - 15:30", "between 9:00 and 17:00".
  for (let i = 0; i + 1 < found.length; i++) {
    if (found[i].range >= 0) continue;
    const between = masked.slice(found[i].end, found[i + 1].start);
    const dashed = /^\s*[–—-]\s*$/.test(between);
    const betweenAnd = /^\s+and\s+$/i.test(between) && /\bbetween\s*$/i.test(masked.slice(0, found[i].start));
    if (dashed || betweenAnd) {
      found[i].range = i;
      found[i + 1].range = i;
    }
  }
  // Sentences, to know which times share one clock.
  const boundaries = [...masked.matchAll(/[.!?;](?=\s)/g)].map((m) => m.index ?? 0);
  const listItem = LIST_ITEM.test(masked);
  for (const time of found) {
    time.sentence = boundaries.filter((at) => at < time.start).length;
    const before = masked.slice(0, time.start);
    time.inContext =
      time.range >= 0 ||
      TIME_BEFORE.test(before) ||
      TIME_AFTER.test(masked.slice(time.end)) ||
      ROW_START.test(before) ||
      (listItem && /[:(]\s*$/.test(before));
  }
  const clear = (time: (typeof found)[number]) => time.inContext && isClearly24h(time.hour);
  const sentenceIs24h = new Set(found.filter(clear).map((time) => time.sentence));
  const rangeIs24h = new Set(found.filter((time) => time.range >= 0 && clear(time)).map((time) => time.range));
  const converts = found.map(
    (time) => time.inContext && (isClearly24h(time.hour) || sentenceIs24h.has(time.sentence) || rangeIs24h.has(time.range)),
  );

  let out = "";
  let at = 0;
  for (let i = 0; i < found.length; i++) {
    const time = found[i];
    if (!converts[i]) continue;
    const pair = time.range === i && i + 1 < found.length && found[i + 1].range === i ? found[i + 1] : null;
    if (pair) {
      // A dashed range is written as the cards write one ("2:00 PM – 3:30 PM"); "between ...
      // and ..." keeps its words.
      const between = line.slice(time.end, pair.start);
      const separator = /^\s*[–—-]\s*$/.test(between) ? " – " : between;
      out += `${line.slice(at, time.start)}${twelveHour(Number(time.hour), time.minute)}${separator}${twelveHour(Number(pair.hour), pair.minute)}`;
      at = pair.end;
      i++;
      continue;
    }
    out += `${line.slice(at, time.start)}${twelveHour(Number(time.hour), time.minute)}`;
    at = time.end;
  }
  return out + line.slice(at);
}
