/**
 * Who ranked the priorities (tasks.source): "chat" = the AI model in the workspace chat,
 * "rules" = the rule-based fallback when the model returned no ranking (a small local model
 * often does not), "planner" = the planner service. The dashboard says which, instead of always
 * "Ranked by the assistant" (QA round 3 saw that label over four rule-ranked rows).
 */
export type PrioritySource = "chat" | "rules" | "planner" | string;

export function prioritiesSubtitle(sources: PrioritySource[]): string {
  if (sources.length > 0 && sources.every((source) => source === "rules")) {
    return "Ranked by simple rules, because the AI model returned no ranking: today's remaining events by length, then the tasks in your emails by importance.";
  }
  if (sources.some((source) => source === "rules")) {
    return "Ranked by the AI assistant; rows marked “rule” were ranked by simple rules.";
  }
  return "Ranked by the AI assistant from your inbox, calendar and chat.";
}
