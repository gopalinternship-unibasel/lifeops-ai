import ReactMarkdown from "react-markdown";
import { motion } from "framer-motion";
import { useEffect, useRef } from "react";
import { Loader2 } from "lucide-react";

export interface ChatTurn {
  id: string;
  role: "user" | "assistant";
  content: string;
}

export function ChatThread({ messages, pending }: { messages: ChatTurn[]; pending: boolean }) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length, pending]);

  return (
    <div className="flex-1 overflow-y-auto px-6 py-6">
      <div className="max-w-3xl mx-auto space-y-5">
        {messages.length === 0 && !pending && (
          <div className="text-center py-16">
            <div className="text-3xl font-semibold tracking-tight">
              Good {greet()}.
            </div>
            <p className="mt-2 text-muted-foreground text-sm">
              MONDAY is initializing your workspace…
            </p>
          </div>
        )}
        {messages.map((m) => (
          <motion.div
            key={m.id}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.18 }}
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
              {m.role === "assistant" ? (
                <div className="prose prose-sm max-w-none prose-p:my-1.5 prose-ul:my-1.5 prose-li:my-0 prose-headings:my-2">
                  <ReactMarkdown>{m.content}</ReactMarkdown>
                </div>
              ) : (
                <div className="whitespace-pre-wrap">{m.content}</div>
              )}
            </div>
            {m.role === "user" && <Avatar role="user" />}
          </motion.div>
        ))}
        {pending && (
          <div className="flex gap-3 justify-start">
            <Avatar role="assistant" />
            <div className="bg-card border border-border rounded-lg px-4 py-3 inline-flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              <span>Thinking…</span>
            </div>
          </div>
        )}
        <div ref={endRef} />
      </div>
    </div>
  );
}

function Avatar({ role }: { role: "user" | "assistant" }) {
  if (role === "assistant") {
    return (
      <div className="shrink-0 h-8 w-8 rounded-md grid place-items-center text-primary-foreground text-xs font-semibold"
           style={{ background: "var(--gradient-brand)" }}>
        M
      </div>
    );
  }
  return (
    <div className="shrink-0 h-8 w-8 rounded-md bg-muted grid place-items-center text-foreground/70 text-xs font-semibold">
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
