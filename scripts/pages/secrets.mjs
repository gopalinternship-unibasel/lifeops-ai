/**
 * Checks of the "lifeops-api" function's secrets for scripts/pages/deploy-function.mjs. Pure
 * functions, so tests/p10-pages-tooling-scripts.test.mjs can run them without the Supabase CLI.
 *
 * Supabase function secrets belong to the whole project. `supabase secrets set --env-file` adds
 * and overwrites names but never removes one, and nothing used to check that the three secrets
 * settings.env does not hold were set: the Pages edition was released without them once.
 */
import { parseEnv } from "../env-file.mjs";

/**
 * The secrets the server code needs that are set by hand, never in settings.env. The same list is
 * REQUIRED_SECRETS in supabase/functions/lifeops-api/handler.ts (a test keeps the two equal).
 */
export const REQUIRED_SECRETS = ["LLM_BASE_URL", "LLM_API_KEY", "LIFEOPS_BACKEND_TOKEN"];

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;

/** Names injected or reserved by the platform, never set from this repository. */
export function isPlatformName(name) {
  return /^(SUPABASE_|SB_|DENO_)/.test(name);
}

/**
 * Collects secret names from parsed JSON. The CLI's JSON shape is not documented, so this reads
 * the likely ones: an array of names or of { name, value } rows (possibly wrapped in an object),
 * and a plain map of name to digest. Strings that are values (digests) are never taken as names.
 */
function namesFromJson(value, out) {
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === "string") {
        if (NAME.test(item)) out.add(item);
      } else {
        namesFromJson(item, out);
      }
    }
    return;
  }
  if (!value || typeof value !== "object") return;
  const name = value.name ?? value.Name ?? value.NAME;
  if (typeof name === "string") {
    if (NAME.test(name)) out.add(name);
    return;
  }
  const entries = Object.entries(value);
  // Upper-case keys only, so a wrapper such as { "status": "ok" } is not read as names.
  if (entries.length && entries.every(([key, item]) => ENV_NAME.test(key) && typeof item === "string")) {
    for (const [key] of entries) out.add(key);
    return;
  }
  for (const [, item] of entries) namesFromJson(item, out);
}

/** Parses `text` as JSON, or else the JSON document that starts on a line of its own (null if none). */
function parseJsonDocument(text) {
  try {
    return JSON.parse(text);
  } catch {
    // Notices around the document: try from its first line to its last.
  }
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => /^\s*[[{]/.test(line));
  if (start < 0) return null;
  for (let end = lines.length; end > start; end--) {
    if (!/[\]}]\s*$/.test(lines[end - 1])) continue;
    try {
      return JSON.parse(lines.slice(start, end).join("\n"));
    } catch {
      // a shorter block may still be the document (JSON lines are read further below)
    }
  }
  return null;
}

/**
 * The secret names in the output of `supabase secrets list`: JSON (an array of { name, ... },
 * possibly wrapped in an object, or a map of name to digest), JSON lines, or the CLI's text table
 * ("NAME | DIGEST"). Values and digests are never returned.
 */
export function secretNamesFromList(output) {
  const text = String(output ?? "").trim();
  const names = new Set();
  if (!text) return [];
  // One JSON document, then line by line (JSON lines, or the text table); the set drops repeats.
  const document = parseJsonDocument(text);
  if (document !== null) namesFromJson(document, names);
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        namesFromJson([JSON.parse(trimmed)], names);
        continue;
      } catch {
        // not JSON: read it as a table row below
      }
    }
    // A table row: the name is the first cell ("  LLM_MODEL | 3b2c..."); the header, the
    // separator line and any line that is not a table row (notices) are skipped.
    if (!/[|│┃]/.test(trimmed)) continue;
    // Older CLIs print the name as Markdown code (`NAME`).
    const first = trimmed.replace(/^[|│┃]+/, "").split(/[|│┃]/)[0]?.trim().replace(/^`(.*)`$/, "$1") ?? "";
    if (first === "NAME" || !NAME.test(first)) continue;
    names.add(first);
  }
  return [...names];
}

/** Required secrets that are not in the list. */
export function missingRequiredSecrets(listedNames) {
  const listed = new Set(listedNames);
  return REQUIRED_SECRETS.filter((name) => !listed.has(name));
}

/** The names settings.env sets. */
export function settingNames(envFileText) {
  return [...parseEnv(envFileText).keys()];
}

/**
 * Project secrets that are neither in settings.env nor one of the required secrets nor the
 * platform's own: settings that were removed from settings.env but keep their last value on the
 * project until they are unset.
 */
export function staleSettingNames(listedNames, envFileText) {
  const keep = new Set([...settingNames(envFileText), ...REQUIRED_SECRETS]);
  return [...new Set(listedNames)].filter((name) => !keep.has(name) && !isPlatformName(name)).sort();
}
