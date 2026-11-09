// Reading and writing KEY=value env files for the local scripts.
//
// Windows PowerShell 5.1 writes UTF-8 with a byte-order mark (`Set-Content -Encoding utf8`),
// and a BOM glued to the first key makes some loaders (python-dotenv with plain "utf-8")
// ignore that key. So: every read strips a BOM, and every write is UTF-8 WITHOUT a BOM and
// with LF line endings. Edit env files with these scripts or a text editor, not Set-Content.
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const BOM = "﻿";

/** File text without a leading byte-order mark ("" when the file does not exist). */
export function readEnvText(path) {
  if (!existsSync(path)) return "";
  const text = readFileSync(path, "utf8");
  return text.startsWith(BOM) ? text.slice(1) : text;
}

/** Parse KEY=value lines into a Map (comments and other lines are ignored). */
export function parseEnv(text) {
  const values = new Map();
  for (const line of text.replace(/^﻿/, "").split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    let value = match[2];
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    values.set(match[1], value);
  }
  return values;
}

/** Write env text as UTF-8 without a BOM, LF line endings, ending in a newline. */
export function writeEnvText(path, text) {
  let clean = text.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  if (!clean.endsWith("\n")) clean += "\n";
  writeFileSync(path, clean, { encoding: "utf8" });
}

/**
 * Update KEY=value lines in place and append keys that are missing. Keys listed in
 * `onlyIfMissing` keep a non-empty existing value. Every other line is preserved.
 */
export function upsertEnvFile(path, updates, { onlyIfMissing = new Set() } = {}) {
  const original = readEnvText(path);
  const lines = original ? original.split(/\r?\n/) : [];
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const existing = parseEnv(original);
  const seen = new Set();
  const out = lines.map((line) => {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (!match || !(match[1] in updates)) return line;
    const key = match[1];
    seen.add(key);
    if (onlyIfMissing.has(key) && existing.get(key)) return line;
    return `${key}=${updates[key]}`;
  });
  const appended = Object.keys(updates).filter((key) => !seen.has(key));
  if (appended.length > 0) {
    if (out.length > 0 && out[out.length - 1] !== "") out.push("");
    for (const key of appended) out.push(`${key}=${updates[key]}`);
  }
  writeEnvText(path, out.join("\n"));
  return { appended };
}
