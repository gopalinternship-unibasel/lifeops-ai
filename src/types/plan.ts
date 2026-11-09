export interface WeekPlanItem {
  emoji: string;
  title: string;
  starts_at: string; // ISO
  ends_at: string;   // ISO
  notes?: string | null;
}

export interface WeekPlanDay {
  date: string;        // YYYY-MM-DD
  headline: string;    // one-line theme of the day
  items: WeekPlanItem[];
}

export interface WeekPlan {
  week_start: string;  // YYYY-MM-DD (Monday)
  days: WeekPlanDay[];
}

export interface BusyEvent {
  title: string;
  starts_at: string;
  ends_at: string;
}
