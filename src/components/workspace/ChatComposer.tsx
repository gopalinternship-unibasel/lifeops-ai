import { useId, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { ArrowUp } from "lucide-react";

const DEFAULT_SUGGESTIONS = [
  "Look into my calendar and tell me priorities",
  "Make interview priority over paper",
  "Block 3–5 pm gym push workout",
  "What about my evening?",
];

/** The workspace chat accepts 4,000 characters per message (processChat). */
export const CHAT_MESSAGE_MAX = 4000;

export function ChatComposer({
  onSend, busy, showSuggestions, suggestions, placeholder, hint, maxLength = CHAT_MESSAGE_MAX, label = "Message MONDAY",
}: {
  /** Return false when the message was not taken (for example no chat session yet): the text stays in the box. */
  onSend: (text: string) => boolean | void | Promise<unknown>;
  /** While true the box keeps its focus but cannot be edited or sent. */
  busy: boolean;
  showSuggestions: boolean;
  suggestions?: string[];
  placeholder?: string;
  hint?: string;
  /** Longest message the server accepts; the box stops there and shows a counter near it. */
  maxLength?: number;
  /** The text box's accessible name (the placeholder disappears once the user types). */
  label?: string;
}) {
  const [value, setValue] = useState("");
  const taRef = useRef<HTMLTextAreaElement>(null);
  const limitId = useId();

  const tooLong = value.length > maxLength;
  const nearLimit = value.length >= maxLength * 0.9;

  const submit = (text?: string) => {
    const t = (text ?? value).trim();
    if (!t || busy || t.length > maxLength) return;
    if (onSend(t) === false) return;
    setValue("");
  };

  const fillSuggestion = (s: string) => {
    setValue(s);
    // Focus and move cursor to end
    requestAnimationFrame(() => {
      const ta = taRef.current;
      if (ta) {
        ta.focus();
        ta.setSelectionRange(s.length, s.length);
      }
    });
  };

  const handleSubmit = (e: FormEvent) => { e.preventDefault(); submit(); };
  const handleKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter that confirms an IME candidate (Japanese, Chinese, Korean input) must not send the
    // half-written message. Safari reports that Enter as keyCode 229 with isComposing false.
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
  };

  const items = suggestions ?? DEFAULT_SUGGESTIONS;

  return (
    <div className="border-t border-border bg-card/60 backdrop-blur-sm">
      {showSuggestions && items.length > 0 && (
        <div className="max-w-3xl mx-auto px-6 pt-4 flex flex-wrap gap-2">
          {items.map((s) => (
            <button
              key={s} onClick={() => fillSuggestion(s)} disabled={busy}
              type="button"
              className="text-xs px-3 py-1.5 rounded-full border border-border bg-card hover:bg-muted text-foreground/80 transition disabled:opacity-50"
            >
              {s}
            </button>
          ))}
        </div>
      )}
      <form onSubmit={handleSubmit} className="max-w-3xl mx-auto px-6 py-4">
        <div className="relative rounded-lg border border-border bg-card focus-within:ring-2 focus-within:ring-ring focus-within:border-transparent transition">
          <textarea
            ref={taRef}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={handleKey}
            // readOnly, not disabled: a disabled box loses focus on every send and the user had
            // to click it again before typing the next message.
            readOnly={busy}
            maxLength={maxLength}
            aria-label={label}
            aria-describedby={nearLimit ? limitId : undefined}
            rows={1}
            className="w-full resize-none bg-transparent px-4 py-3 pr-14 text-sm focus:outline-none max-h-40"
            placeholder={placeholder ?? "Ask MONDAY anything — schedule a block, reorder priorities, plan a meal…"}
          />
          <button
            type="submit"
            disabled={busy || !value.trim() || tooLong}
            className="absolute right-2 bottom-2 h-8 w-8 grid place-items-center rounded-md text-primary-foreground transition disabled:opacity-40"
            style={{ background: "var(--gradient-brand)" }}
            aria-label="Send"
          >
            <ArrowUp className="h-4 w-4" />
          </button>
        </div>
        <p className="mt-2 text-[11px] text-muted-foreground text-center">
          {hint ?? "MONDAY uses simulated Gmail and Calendar data in demo mode."}
          {nearLimit && (
            <span id={limitId} data-testid="composer-limit" className={`ml-2 font-mono ${tooLong ? "text-red-600" : "text-amber-700"}`}>
              {value.length.toLocaleString("en-US")}/{maxLength.toLocaleString("en-US")} characters
            </span>
          )}
        </p>
      </form>
    </div>
  );
}
