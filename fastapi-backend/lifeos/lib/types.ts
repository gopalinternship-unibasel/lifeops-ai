export type EventType = "task" | "habit" | "appointment" | "rest";

export interface PlanEvent {
  id: string;
  emoji: string;
  title: string;
  type: EventType;
  startTime: string; // "19:00"
  endTime: string; // "20:30"
  notes?: string;
}

export interface DayPlan {
  date: string; // "2026-05-04"
  weekday: string; // "Mon" or "周一" depending on locale
  focus: string;
  events: PlanEvent[];
}

export interface WeekPlan {
  theme: string;
  rationale: string;
  days: DayPlan[];
  createdAt: string;
}

export interface CheckinRecord {
  date: string;
  eventStatuses: { eventId: string; status: "done" | "partial" | "skip" }[];
  userNote: string;
  aiResponse: string;
}

