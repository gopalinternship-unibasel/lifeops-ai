import { describe, expect, it } from "vitest";
import {
  computeFreeSlots,
  describeConflicts,
  findConflicts,
  fitsInFreeSlot,
  localTimeToISO,
  parseUserDateTime,
} from "@/server/calendar/time-ranges.server";

const ZRH = "Europe/Zurich";

describe("findConflicts", () => {
  const events = [
    { id: "a", title: "Lecture", starts_at: "2026-11-10T09:00:00+00:00", ends_at: "2026-11-10T11:00:00+00:00" },
    // Google style: same instant written with an offset.
    { id: "b", title: "Dentist", starts_at: "2026-11-10T15:00:00+01:00", ends_at: "2026-11-10T16:00:00+01:00" },
    { id: "c", title: "Holiday", starts_at: "2026-11-10T00:00:00.000Z", ends_at: "2026-11-11T00:00:00.000Z", busy: false },
  ];

  it("detects overlaps across ISO formats (Postgres, Google, JavaScript)", () => {
    const hit = findConflicts({ starts_at: "2026-11-10T10:30:00.000Z", ends_at: "2026-11-10T12:00:00.000Z" }, events);
    expect(hit.map((e) => e.id)).toEqual(["a"]);
    const dentist = findConflicts({ starts_at: "2026-11-10T13:30:00.000Z", ends_at: "2026-11-10T14:30:00.000Z" }, events);
    expect(dentist.map((e) => e.id)).toEqual(["b"]);
  });

  it("treats back-to-back events as free and ignores non-blocking events", () => {
    // Ends exactly when the lecture starts; "Holiday" is all-day / show-as-free.
    const touching = findConflicts({ starts_at: "2026-11-10T08:00:00.000Z", ends_at: "2026-11-10T09:00:00.000Z" }, events);
    expect(touching).toEqual([]);
    // The text comparison the old code used got this one wrong ("+" sorts before ".").
    const afterLecture = findConflicts({ starts_at: "2026-11-10T11:00:00.000Z", ends_at: "2026-11-10T12:00:00.000Z" }, events);
    expect(afterLecture).toEqual([]);
  });

  it("can ignore the event being moved", () => {
    const moved = findConflicts(
      { starts_at: "2026-11-10T09:30:00.000Z", ends_at: "2026-11-10T11:30:00.000Z" },
      events,
      { ignoreId: "a" },
    );
    expect(moved).toEqual([]);
  });

  it("describes conflicts in the user's time zone", () => {
    const message = describeConflicts([events[0]], ZRH);
    expect(message).toContain('"Lecture" (10:00 AM–12:00 PM)');
    expect(message).toContain("Pick a free slot");
  });
});

describe("free-slot scheduling", () => {
  it("finds the free time between 07:00 and 22:00 local time", () => {
    const busy = [
      { title: "Lecture", starts_at: "2026-11-10T09:00:00Z", ends_at: "2026-11-10T11:00:00Z" }, // 10-12 local
      { title: "Overlapping", starts_at: "2026-11-10T10:30:00Z", ends_at: "2026-11-10T11:30:00Z" }, // 11:30-12:30
      { title: "Too short gap", starts_at: "2026-11-10T11:45:00Z", ends_at: "2026-11-10T13:00:00Z" }, // 12:45-14:00
    ];
    const free = computeFreeSlots("2026-11-10", busy, ZRH);
    expect(free).toEqual([
      { start: "2026-11-10T06:00:00.000Z", end: "2026-11-10T09:00:00.000Z" }, // 07:00-10:00
      { start: "2026-11-10T13:00:00.000Z", end: "2026-11-10T21:00:00.000Z" }, // 14:00-22:00
    ]);
    expect(fitsInFreeSlot("2026-11-10T13:00:00.000Z", "2026-11-10T14:00:00.000Z", free)).toBe(true);
    expect(fitsInFreeSlot("2026-11-10T08:30:00.000Z", "2026-11-10T09:30:00.000Z", free)).toBe(false);
  });

  it("never offers time that is already over (plan made at 15:08 local)", () => {
    const busy = [{ title: "Team sync", starts_at: "2026-11-09T18:00:00Z", ends_at: "2026-11-09T19:00:00Z" }]; // 19-20 local
    const now = Date.parse("2026-11-09T14:08:00Z"); // Monday 15:08 in Zurich
    const free = computeFreeSlots("2026-11-09", busy, ZRH, { notBeforeMs: now });
    expect(free).toEqual([
      { start: "2026-11-09T14:15:00.000Z", end: "2026-11-09T18:00:00.000Z" }, // 15:15-19:00 (next quarter hour)
      { start: "2026-11-09T19:00:00.000Z", end: "2026-11-09T21:00:00.000Z" }, // 20:00-22:00
    ]);
    // The QA case: a 07:00-08:00 item on that Monday no longer fits.
    expect(fitsInFreeSlot("2026-11-09T06:00:00.000Z", "2026-11-09T07:00:00.000Z", free)).toBe(false);
  });

  it("gives a past day no free slots and leaves future days untouched", () => {
    const now = Date.parse("2026-11-11T10:00:00Z"); // Wednesday
    expect(computeFreeSlots("2026-11-09", [], ZRH, { notBeforeMs: now })).toEqual([]);
    expect(computeFreeSlots("2026-11-12", [], ZRH, { notBeforeMs: now })).toEqual([
      { start: "2026-11-12T06:00:00.000Z", end: "2026-11-12T21:00:00.000Z" },
    ]);
    // After 21:45 local nothing of 30 minutes is left today.
    expect(computeFreeSlots("2026-11-11", [], ZRH, { notBeforeMs: Date.parse("2026-11-11T20:40:00Z") })).toEqual([]);
  });

  it("respects daylight-saving changes", () => {
    // 29 Mar 2026: Zurich switches from UTC+1 to UTC+2.
    expect(localTimeToISO("2026-03-28", "09:00", ZRH)).toBe("2026-03-28T08:00:00.000Z");
    expect(localTimeToISO("2026-03-30", "09:00", ZRH)).toBe("2026-03-30T07:00:00.000Z");
    expect(localTimeToISO("2026-03-30", "25:00", ZRH)).toBeNull();
  });
});

describe("parseUserDateTime", () => {
  it("reads timestamps without an offset as the user's local time", () => {
    expect(parseUserDateTime("2026-11-10T15:00:00", ZRH)).toBe("2026-11-10T14:00:00.000Z");
    expect(parseUserDateTime("2026-11-10 15:00", ZRH)).toBe("2026-11-10T14:00:00.000Z");
  });

  it("keeps explicit offsets and rejects garbage", () => {
    expect(parseUserDateTime("2026-11-10T15:00:00Z", ZRH)).toBe("2026-11-10T15:00:00.000Z");
    expect(parseUserDateTime("2026-11-10T15:00:00+05:30", ZRH)).toBe("2026-11-10T09:30:00.000Z");
    expect(parseUserDateTime("next tuesday", ZRH)).toBeNull();
  });
});
