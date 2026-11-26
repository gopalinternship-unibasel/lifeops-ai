import { getValidAccessToken } from "./oauth.server";

const BASE = "https://gmail.googleapis.com/gmail/v1";
const GOOGLE_API_TIMEOUT_MS = 20_000;

const DRAFT_WITHOUT_ID =
  "Gmail did not confirm the draft. Please check your Gmail drafts before saving it again.";

function googleApiSignal() {
  return AbortSignal.timeout(GOOGLE_API_TIMEOUT_MS);
}

/**
 * fetch() for the Gmail API. Its errors reach users (toasts, card errors), so a network failure or
 * a timeout becomes a sentence and the details go to the server log.
 */
async function gmailFetch(url: string, init: RequestInit, action: string): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: googleApiSignal() });
  } catch (error) {
    console.error(`[google] Gmail: could not ${action}:`, error);
    throw new Error(`Gmail could not be reached to ${action}. Please try again in a moment.`);
  }
}

/** A failed Gmail API answer as a sentence; Google's answer body goes to the server log only. */
async function gmailError(res: Response, action: string): Promise<Error> {
  const body = await res.text().catch(() => "");
  console.error(`[google] Gmail: could not ${action}: HTTP ${res.status}: ${body.slice(0, 500)}`);
  if (res.status === 401 || res.status === 403) {
    return new Error(`Gmail did not allow MONDAY to ${action}. Please connect Google again from your profile.`);
  }
  return new Error(`Gmail could not ${action} right now (HTTP ${res.status}). Please try again in a moment.`);
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  async function runWorker() {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await worker(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => runWorker()));
  return results;
}

interface GmailHeader {
  name?: string;
  value?: string;
}

interface GmailPayload {
  mimeType?: string;
  headers?: GmailHeader[];
  body?: { data?: string };
  parts?: GmailPayload[];
}

interface GmailApiMessage {
  id?: string;
  threadId?: string;
  payload?: GmailPayload;
  snippet?: string;
  labelIds?: string[];
}

interface GmailDraftApiResponse {
  id?: string;
}

export interface GmailMsg {
  id: string;
  threadId: string;
  from: string;
  to: string;
  subject: string;
  snippet: string;
  date: string;
  bodyText: string;
  unread: boolean;
}

function decodeB64Url(s: string) {
  try {
    const normalized = s.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4 || 4)) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return "";
  }
}

function header(headers: GmailHeader[], name: string) {
  const h = headers?.find((x) => x.name?.toLowerCase() === name.toLowerCase());
  return h?.value ?? "";
}

function extractBody(payload: GmailPayload | undefined): string {
  if (!payload) return "";
  if (payload.body?.data) return decodeB64Url(payload.body.data);
  if (Array.isArray(payload.parts)) {
    // Prefer text/plain
    const plain = payload.parts.find(
      (part) => part.mimeType === "text/plain" && part.body?.data,
    );
    const plainData = plain?.body?.data;
    if (plainData) return decodeB64Url(plainData);
    for (const p of payload.parts) {
      const v = extractBody(p);
      if (v) return v;
    }
  }
  return "";
}

async function fetchMessagesByQuery(accessToken: string, query: string, maxResults: number): Promise<GmailMsg[]> {
  const cappedMaxResults = Math.max(1, Math.min(maxResults, 50));
  const listRes = await gmailFetch(`${BASE}/users/me/messages?maxResults=${cappedMaxResults}&q=${encodeURIComponent(query)}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  }, "load your inbox");
  if (!listRes.ok) throw await gmailError(listRes, "load your inbox");
  const list = (await listRes.json()) as { messages?: { id: string }[] };
  const ids = list.messages ?? [];
  if (ids.length === 0) return [];

  const msgs = await mapWithConcurrency(ids, 8, async ({ id }) => {
    const r = await gmailFetch(`${BASE}/users/me/messages/${id}?format=full`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    }, "load your inbox");
    if (!r.ok) return null;
    const m = (await r.json()) as GmailApiMessage;
    const headers = m.payload?.headers ?? [];
    return {
      id: m.id ?? id,
      threadId: m.threadId ?? "",
      from: header(headers, "From"),
      to: header(headers, "To"),
      subject: header(headers, "Subject") || "(no subject)",
      snippet: m.snippet ?? "",
      date: header(headers, "Date"),
      bodyText: extractBody(m.payload).slice(0, 4000),
      unread: Array.isArray(m.labelIds) && m.labelIds.includes("UNREAD"),
    } as GmailMsg;
  });
  return msgs.filter((message): message is GmailMsg => message !== null);
}

export async function listRecentMessages(userId: string, maxResults = 8): Promise<GmailMsg[]> {
  const { accessToken } = await getValidAccessToken(userId);
  return fetchMessagesByQuery(accessToken, "in:inbox", maxResults);
}

export async function listUnreadMessages(userId: string, maxResults = 50): Promise<GmailMsg[]> {
  const { accessToken } = await getValidAccessToken(userId);
  return fetchMessagesByQuery(accessToken, "in:inbox is:unread", maxResults);
}

export async function getMessage(userId: string, messageId: string): Promise<GmailMsg | null> {
  const { accessToken } = await getValidAccessToken(userId);
  const r = await gmailFetch(`${BASE}/users/me/messages/${encodeURIComponent(messageId)}?format=full`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  }, "read the email");
  if (!r.ok) return null;
  const m = (await r.json()) as GmailApiMessage;
  const headers = m.payload?.headers ?? [];
  return {
    id: m.id ?? messageId,
    threadId: m.threadId ?? "",
    from: header(headers, "From"),
    to: header(headers, "To"),
    subject: header(headers, "Subject") || "(no subject)",
    snippet: m.snippet ?? "",
    date: header(headers, "Date"),
    bodyText: extractBody(m.payload).slice(0, 4000), // the limit the privacy page states
    unread: Array.isArray(m.labelIds) && m.labelIds.includes("UNREAD"),
  };
}

function b64url(s: string) {
  const bytes = new TextEncoder().encode(s);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}


function safeHeaderValue(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

function buildRawReply(opts: { to: string; subject: string; body: string; inReplyTo?: string; references?: string; isReply?: boolean }) {
  const cleanSubject = safeHeaderValue(opts.subject);
  const subj = opts.isReply === false || cleanSubject.toLowerCase().startsWith("re:") ? cleanSubject : `Re: ${cleanSubject}`;
  // A draft may have no recipient yet (the planner keeps only addresses the user wrote, so its
  // drafts can arrive with "(recipient to fill in)"): then there is no To header at all.
  const to = safeHeaderValue(opts.to);
  const lines = [
    ...(to.includes("@") ? [`To: ${to}`] : []),
    `Subject: ${subj}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "MIME-Version: 1.0",
  ];
  if (opts.inReplyTo) lines.push(`In-Reply-To: ${safeHeaderValue(opts.inReplyTo)}`);
  if (opts.references) lines.push(`References: ${safeHeaderValue(opts.references)}`);
  lines.push("", opts.body);
  return b64url(lines.join("\r\n"));
}

export async function createDraftReply(userId: string, params: { messageId: string; replyBody: string }): Promise<{ draftId: string; subject: string; to: string }> {
  const { accessToken } = await getValidAccessToken(userId);
  // Fetch original to copy thread + headers
  const origRes = await gmailFetch(`${BASE}/users/me/messages/${encodeURIComponent(params.messageId)}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Message-ID&metadataHeaders=References`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  }, "read the email you are replying to");
  if (!origRes.ok) throw await gmailError(origRes, "read the email you are replying to");
  const orig = (await origRes.json()) as GmailApiMessage;
  const headers = orig.payload?.headers ?? [];
  const from = header(headers, "From");
  const subject = header(headers, "Subject") || "(no subject)";
  const messageIdHdr = header(headers, "Message-ID");
  const referencesHdr = header(headers, "References");
  const refs = [referencesHdr, messageIdHdr].filter(Boolean).join(" ");

  const raw = buildRawReply({
    to: from, subject, body: params.replyBody,
    inReplyTo: messageIdHdr || undefined,
    references: refs || undefined,
  });

  const draftRes = await gmailFetch(`${BASE}/users/me/drafts`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ message: { raw, threadId: orig.threadId } }),
  }, "save the draft");
  if (!draftRes.ok) throw await gmailError(draftRes, "save the draft");
  const draft = (await draftRes.json()) as GmailDraftApiResponse;
  if (!draft.id) throw new Error(DRAFT_WITHOUT_ID);
  return { draftId: draft.id, subject, to: from };
}

/**
 * Create a new Gmail DRAFT (not a reply). Only the drafts endpoint is used: MONDAY never
 * calls messages.send or drafts.send, so nothing is ever sent on the user's behalf.
 */
export async function createDraft(
  userId: string,
  params: { to: string; subject: string; body: string },
): Promise<{ draftId: string }> {
  const { accessToken } = await getValidAccessToken(userId);
  const raw = buildRawReply({ to: params.to, subject: params.subject, body: params.body, isReply: false });
  const draftRes = await gmailFetch(`${BASE}/users/me/drafts`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ message: { raw } }),
  }, "save the draft");
  if (!draftRes.ok) throw await gmailError(draftRes, "save the draft");
  const draft = (await draftRes.json()) as GmailDraftApiResponse;
  if (!draft.id) throw new Error(DRAFT_WITHOUT_ID);
  return { draftId: draft.id };
}
