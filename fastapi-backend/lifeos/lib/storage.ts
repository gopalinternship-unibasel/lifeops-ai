"use client";

import type { CheckinRecord, WeekPlan } from "./types";

const KEY_PLAN = "lifeos:current-plan";
const KEY_CHECKINS = "lifeos:checkins";
const KEY_HISTORY = "lifeos:user-input-history";

function isBrowser() {
  return typeof window !== "undefined" && typeof localStorage !== "undefined";
}

export function savePlan(plan: WeekPlan) {
  if (!isBrowser()) return;
  localStorage.setItem(KEY_PLAN, JSON.stringify(plan));
}

export function loadPlan(): WeekPlan | null {
  if (!isBrowser()) return null;
  const raw = localStorage.getItem(KEY_PLAN);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as WeekPlan;
  } catch {
    return null;
  }
}

export function clearPlan() {
  if (!isBrowser()) return;
  localStorage.removeItem(KEY_PLAN);
}

export function saveCheckin(record: CheckinRecord) {
  if (!isBrowser()) return;
  const list = loadCheckins();
  list.push(record);
  localStorage.setItem(KEY_CHECKINS, JSON.stringify(list));
}

export function loadCheckins(): CheckinRecord[] {
  if (!isBrowser()) return [];
  const raw = localStorage.getItem(KEY_CHECKINS);
  if (!raw) return [];
  try {
    return JSON.parse(raw) as CheckinRecord[];
  } catch {
    return [];
  }
}

export function pushHistory(input: string) {
  if (!isBrowser()) return;
  const list = loadHistory();
  list.unshift(input);
  localStorage.setItem(KEY_HISTORY, JSON.stringify(list.slice(0, 20)));
}

export function loadHistory(): string[] {
  if (!isBrowser()) return [];
  const raw = localStorage.getItem(KEY_HISTORY);
  if (!raw) return [];
  try {
    return JSON.parse(raw) as string[];
  } catch {
    return [];
  }
}
