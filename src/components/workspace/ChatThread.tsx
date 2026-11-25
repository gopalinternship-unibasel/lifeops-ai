import ReactMarkdown from "react-markdown";
import { motion } from "framer-motion";
import { useEffect, useRef, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { normalizeBullets } from "@/lib/reply-state";

export interface ChatTurn {
  id: string;
  role: "user" | "assistant";
  content: string;
}

export function ChatThread({
  messages,
  pending,
  pendingNote,
  emptyState,
}: {
  messages: ChatTurn[];
  pending: boolean;
  /** Shown under "Thinking…" (for example when a reloaded page waits for an earlier request). */
  pendingNote?: string;
  /** Shown instead of the greeting while there are no messages (for example a load error). */
  emptyState?: ReactNode;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Scroll the thread itself, not the page: on a phone the panel sits below the chat, and
    // scrollIntoView also scrolled the page, pulling a reader of the panel back up.
    const thread = scrollRef.current;
    if (thread) thread.scrollTo({ top: thread.scrollHeight, behavior: "smooth" });
  }, [messages.length, pending]);

  return (
    <div ref={scrollRef} className="flex-1 overflow-y-auto px-6 py-6">
      <div className="max-w-3xl mx-auto">
        {messages.length === 0 && !pending && (emptyState ?? (
          <div className="text-center py-16">
            <div className="text-3xl font-semibold tracking-tight">
              Good {greet()}.
            </div>
            <p className="mt-2 text-muted-foreground text-sm">
              MONDAY is initializing your workspace…
            </p>
          </div>
        ))}
        {/* A log region, so screen readers announce each new message (it must exist before the
            messages arrive). The speaker is named in hidden text; the avatars are decoration. */}
        <div role="log" aria-live="polite" aria-relevant="additions" aria-label="Conversation with MONDAY" className="space-y-5">
          {messages.map((m) => (
            <motion.div
              key={m.id}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.18 }}
              data-testid="chat-message"
              data-role={m.role}
              className={`flex gap-3 ${m.role === "user" ? "justify-end" : "justify-start"}`}
            >
              {m.role === "assistant" && <Avatar role="assistant" />}
              <div
                className={`max-w-[78%] rounded-lg px-4 py-2.5 text-sm leading-relaxed ${
                  m.role === "user"
                    ? "text-primary-foreground"
                    : "bg-card border border-border"
                }`}
                style={m.role === "user" ? { background: "var(--gradient-brand)" } : undefined}
              >
                <span className="sr-only">{m.role === "user" ? "You said:" : "MONDAY said:"}</span>
                {m.role === "assistant" ? (
                  // Markdown styles come from .chat-md in styles.css (lists, headings, links).
                  <div className="chat-md">
                    <ReactMarkdown>{normalizeBullets(m.content)}</ReactMarkdown>
                  </div>
                ) : (
                  <div className="whitespace-pre-wrap">{m.content}</div>
                )}
              </div>
              {m.role === "user" && <Avatar role="user" />}
            </motion.div>
          ))}
        </div>
        {/* A status region (always present, so "Thinking…" is announced when it appears). */}
        <div role="status">
          {pending && (
            <div className={`flex gap-3 justify-start ${messages.length > 0 ? "mt-5" : ""}`} data-testid="chat-pending">
              <Avatar role="assistant" />
              <div className="bg-card border border-border rounded-lg px-4 py-3 inline-flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                <span>Thinking…</span>
                {pendingNote && <span className="text-xs" data-testid="chat-pending-note">{pendingNote}</span>}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Avatar({ role }: { role: "user" | "assistant" }) {
  if (role === "assistant") {
    return (
      <div aria-hidden="true" className="shrink-0 h-8 w-8 rounded-md grid place-items-center text-primary-foreground text-xs font-semibold"
           style={{ background: "var(--gradient-brand)" }}>
        M
      </div>
    );
  }
  return (
    <div aria-hidden="true" className="shrink-0 h-8 w-8 rounded-md bg-muted grid place-items-center text-foreground/70 text-xs font-semibold">
      You
    </div>
  );
}

function greet() {
  const h = new Date().getHours();
  if (h < 12) return "morning";
  if (h < 18) return "afternoon";
  return "evening";
}
