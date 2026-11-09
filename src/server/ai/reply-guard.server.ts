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
  new RegExp(`\\b(?:has|have|had)\\s+(?:now\\s+|already\\s+|successfully\\s+)?been\\s+(?:successfully\\s+)?(?:${ACTION_VERBS})\\b`, "i"),
  new RegExp(`\\bI(?:'ve|\\s+have|\\s+just|\\s+already)?\\s+(?:successfully\\s+|now\\s+)?(?:${ACTION_VERBS})\\b`, "i"),
  /\b(?:is|are)\s+now\s+(?:scheduled|booked|moved|set|saved|added|in your calendar|on your calendar|cancell?ed|confirmed)\b/i,
  /\b(?:is|are)\s+(?:saved|added)\s+(?:to|in|on)\s+your\s+calendar\b/i,
  /\b(?:email|reply|message)\s+(?:is|was)\s+sent\b/i,
];

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

export function removeActionClaims(text: string): { text: string; removed: number } {
  return removeSentences(text, (sentence) => CLAIMS.some((re) => re.test(sentence)));
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
}): string {
  const cleaned = stripInternalMarkers(opts.modelReply);
  const claims = removeActionClaims(cleaned);
  const calendarTurn = opts.pendingEvents.length > 0 || opts.pendingEventChanges.length > 0 || Boolean(opts.changeNote);

  let modelText = claims.text;
  if (opts.changeRequest) modelText = "";
  else if (calendarTurn) modelText = removeTimeStatements(modelText).text;

  const lines: string[] = [];
  if (modelText) lines.push(modelText);
  if (opts.changeNote) lines.push(`${opts.changeNote} Nothing in your calendar was changed.`);
  lines.push(...cardConfirmations(opts));
  if (opts.emailDraft && (claims.removed > 0 || !modelText)) {
    lines.push(`The reply to ${opts.emailDraft.to} is under **Insights** as a draft suggestion. Edit it and click **Save as draft**; nothing is sent.`);
  }
  if (lines.length > 0) return lines.join("\n\n");
  if (opts.hasOtherCards) return "See the card on the right.";
  if (claims.removed > 0) {
    return "I could not prepare that as a valid proposal, so nothing was changed. Please try again with a day and a time.";
  }
  return "I'm not sure how to help with that. Could you rephrase it?";
}
