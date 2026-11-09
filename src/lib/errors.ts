import { readableErrorMessage } from "@/lib/validation";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function getErrorMessage(error: unknown, fallback = "Unexpected error"): string {
  if (error instanceof Error && error.message) return readableErrorMessage(error.message);
  if (typeof error === "string" && error.trim()) return readableErrorMessage(error);

  if (isRecord(error) && typeof error.message === "string" && error.message.trim()) {
    return readableErrorMessage(error.message);
  }

  return fallback;
}
