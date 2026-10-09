import { clockMinute, isTimeZone, localTime, WEEKDAYS } from "@/lib/gateway/price-schedule";
import type { AccessWindow, KeyEndpoint, Weekday } from "@/types/keys";

export const KEY_ENDPOINTS = [
  "chat",
  "embeddings",
  "moderations",
  "images",
  "audio",
  "videos",
  "ocr",
  "files",
  "batches",
  "systemone",
] as const satisfies readonly KeyEndpoint[];

export const MAX_ACCESS_WINDOWS = 20;

const DAY_MINUTES = 24 * 60;

const ENDPOINT_SEGMENTS = new Map<string, KeyEndpoint>([
  ["chat", "chat"],
  ["completions", "chat"],
  ["messages", "chat"],
  ["responses", "chat"],
  ["embeddings", "embeddings"],
  ["moderations", "moderations"],
  ["images", "images"],
  ["audio", "audio"],
  ["videos", "videos"],
  ["ocr", "ocr"],
  ["files", "files"],
  ["batches", "batches"],
  ["systemone", "systemone"],
]);

const OPEN_SEGMENTS = new Set(["models"]);

function v1Segment(path: string): string | null {
  const [empty, root, segment] = path.split("/");
  return empty === "" && root === "v1" && segment ? segment : null;
}

export function endpointOf(path: string): KeyEndpoint | null {
  const segment = v1Segment(path);
  return segment ? (ENDPOINT_SEGMENTS.get(segment) ?? null) : null;
}

export function endpointAllowed(allowed: readonly KeyEndpoint[], path: string): boolean {
  if (!allowed.length) return true;
  const segment = v1Segment(path);
  if (segment && OPEN_SEGMENTS.has(segment)) return true;
  const endpoint = endpointOf(path);
  return endpoint !== null && allowed.includes(endpoint);
}

export function isKeyEndpoint(value: unknown): value is KeyEndpoint {
  return KEY_ENDPOINTS.some((endpoint) => endpoint === value);
}

export function isWeekday(value: unknown): value is Weekday {
  return WEEKDAYS.some((weekday) => weekday === value);
}

export function accessWindowValid(window: AccessWindow): boolean {
  return (
    window.days.length > 0 &&
    window.days.every(isWeekday) &&
    clockMinute(window.start) !== null &&
    clockMinute(window.end) !== null
  );
}

export function accessWindowsOf(value: unknown): AccessWindow[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const { days, start, end } = item as Record<string, unknown>;
    if (!Array.isArray(days) || typeof start !== "string" || typeof end !== "string") return [];
    const window = { days: WEEKDAYS.filter((day) => days.includes(day)), start, end };
    return accessWindowValid(window) ? [window] : [];
  });
}

export function allowedEndpointsOf(value: unknown): KeyEndpoint[] {
  return Array.isArray(value) ? KEY_ENDPOINTS.filter((endpoint) => value.includes(endpoint)) : [];
}

export function accessTimeZoneOf(value: string | null | undefined): string {
  return value && isTimeZone(value) ? value : "UTC";
}

function previousDay(day: Weekday): Weekday {
  return WEEKDAYS[(WEEKDAYS.indexOf(day) + WEEKDAYS.length - 1) % WEEKDAYS.length];
}

function windowLength(window: AccessWindow): number {
  const start = clockMinute(window.start) ?? 0;
  const end = clockMinute(window.end) ?? 0;
  return (end - start + DAY_MINUTES) % DAY_MINUTES || DAY_MINUTES;
}

function windowCovers(window: AccessWindow, day: Weekday, minute: number): boolean {
  const start = clockMinute(window.start);
  if (start === null) return false;
  const length = windowLength(window);
  if (window.days.includes(day) && minute >= start && minute - start < length) return true;
  return window.days.includes(previousDay(day)) && minute + DAY_MINUTES - start < length;
}

export function accessOpen(windows: readonly AccessWindow[], timeZone: string, at: Date): boolean {
  if (!windows.length) return true;
  const { weekday, minute } = localTime(at, accessTimeZoneOf(timeZone));
  return windows.some((window) => windowCovers(window, weekday, minute));
}
