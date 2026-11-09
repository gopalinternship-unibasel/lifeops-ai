// The local scripts read and write .env.local and fastapi-backend/.env. Windows PowerShell 5.1
// adds a UTF-8 byte-order mark when it edits a file; that must never break or come back.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseEnv, readEnvText, upsertEnvFile } from "../scripts/env-file.mjs";

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

function tempFile(content) {
  const path = join(mkdtempSync(join(tmpdir(), "lifeops-env-")), ".env.local");
  writeFileSync(path, content);
  return path;
}

describe("env files", () => {
  it("reads the first key of a file that starts with a BOM", () => {
    const path = tempFile(Buffer.concat([BOM, Buffer.from("LLM_MODEL=qwen2.5:3b\r\nLLM_BASE_URL=http://localhost:11434/v1\r\n")]));
    const values = parseEnv(readEnvText(path));
    expect(values.get("LLM_MODEL")).toBe("qwen2.5:3b");
    expect([...values.keys()].every((key) => !key.startsWith("﻿"))).toBe(true);
  });

  it("rewrites a BOM file as UTF-8 without BOM and LF endings, keeping other lines", () => {
    const path = tempFile(Buffer.concat([BOM, Buffer.from("# comment first\r\nLLM_MODEL=llama3.1:8b\r\nKEEP=me\r\n")]));
    upsertEnvFile(path, { LLM_MODEL: "qwen2.5:3b", NEW_KEY: "x" });
    const bytes = readFileSync(path);
    expect(bytes.subarray(0, 3).equals(BOM)).toBe(false);
    expect(bytes.toString("utf8")).toBe("# comment first\nLLM_MODEL=qwen2.5:3b\nKEEP=me\n\nNEW_KEY=x\n");
  });

  it("keeps a value the user set when the key is only filled in if missing", () => {
    const path = tempFile("LLM_MODEL=my-model\nLLM_API_KEY=\n");
    upsertEnvFile(path, { LLM_MODEL: "llama3.1:8b", LLM_API_KEY: "ollama" }, { onlyIfMissing: new Set(["LLM_MODEL", "LLM_API_KEY"]) });
    expect(readFileSync(path, "utf8")).toBe("LLM_MODEL=my-model\nLLM_API_KEY=ollama\n");
  });
});
