// Real Gmail text cut to a length can end in half an emoji (a lone UTF-16 surrogate). Cloudflare
// Workers AI answers such a request with HTTP 400 (measured 26 Nov 2026), so every string of the
// request body is made well formed before it is sent.
import { describe, expect, it } from "vitest";
import { wellFormedDeep } from "@/server/ai/llm.server";

const LONE_HIGH = String.fromCharCode(0xd83d);
const LONE_LOW = String.fromCharCode(0xdea8);
const SIREN = String.fromCodePoint(0x1f6a8);

describe("wellFormedDeep", () => {
  it("replaces lone surrogates anywhere in the body", () => {
    const body = {
      model: "m",
      messages: [{ role: "user", content: `Subject: ${LONE_HIGH} BLACK FRIDAY` }],
      tools: [{ function: { arguments: `{"text":"${LONE_LOW}x"}` } }],
      max_tokens: 10,
    };
    const out = wellFormedDeep(body);
    expect(out.messages[0].content).toBe("Subject: \uFFFD BLACK FRIDAY");
    expect(out.tools[0].function.arguments).toBe('{"text":"\uFFFDx"}');
    expect(out.max_tokens).toBe(10);
    expect(JSON.stringify(out)).not.toMatch(/\\ud[89ab][0-9a-f]{2}/i);
  });

  it("keeps whole emoji and ordinary text unchanged", () => {
    const text = `Alarm ${SIREN} um 7 Uhr, Gruesse`;
    expect(wellFormedDeep(text)).toBe(text);
    expect(wellFormedDeep({ a: [text, 1, null, true] })).toEqual({ a: [text, 1, null, true] });
  });

  it("does not change the input object", () => {
    const body = { content: `x${LONE_HIGH}` };
    wellFormedDeep(body);
    expect(body.content).toBe(`x${LONE_HIGH}`);
  });
});
