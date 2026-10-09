import type { Prisma } from "@/generated/prisma/client";
import { money } from "@/lib/utils/money";
import type { CostRates, PriceSchedule, PriceWindowRates } from "@/types/gateway";
import type { Weekday } from "@/types/keys";
import type { PriceWindow } from "@/types/models";

export const MAX_PRICE_WINDOWS = 24;

export const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const satisfies readonly Weekday[];

const UTC_WEEKDAYS: readonly Weekday[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

export const priceWindowQuery = {
  select: { startMinute: true, endMinute: true, priceInput: true, priceOutput: true },
  orderBy: { startMinute: "asc" },
} as const;

const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/;
const clockFormatters = new Map<string, Intl.DateTimeFormat>();

export function clockMinute(value: string): number | null {
  const match = CLOCK.exec(value.trim());
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

export function minuteClock(minute: number): string {
  return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}

export function priceWindowRates(row: {
  startMinute: number;
  endMinute: number;
  priceInput: Prisma.Decimal | number;
  priceOutput: Prisma.Decimal | number;
}): PriceWindowRates {
  return {
    start_minute: row.startMinute,
    end_minute: row.endMinute,
    cost_input_per_1k: money(row.priceInput),
    cost_output_per_1k: money(row.priceOutput),
  };
}

export function validPrice(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

export function windowValid(window: PriceWindow): boolean {
  const start = clockMinute(window.start);
  const end = clockMinute(window.end);
  return (
    start !== null &&
    end !== null &&
    start !== end &&
    validPrice(window.priceInput) &&
    validPrice(window.priceOutput)
  );
}

export function scheduleOverlaps(windows: PriceWindow[]): boolean {
  return windowsOverlap(
    windows.flatMap((window) => {
      const start = clockMinute(window.start);
      const end = clockMinute(window.end);
      return start === null || end === null || start === end ? [] : [{ start, end }];
    }),
  );
}

function covers(window: { start: number; end: number }, minute: number): boolean {
  return window.start < window.end
    ? minute >= window.start && minute < window.end
    : minute >= window.start || minute < window.end;
}

export function windowsOverlap(windows: { start: number; end: number }[]): boolean {
  return windows.some((a, i) =>
    windows.slice(i + 1).some((b) => covers(a, b.start) || covers(b, a.start)),
  );
}

export function scheduledPrice(
  price: CostRates,
  windows: PriceWindowRates[],
  minute: number,
): CostRates {
  const hit = windows.find((window) =>
    covers({ start: window.start_minute, end: window.end_minute }, minute),
  );
  if (!hit) return price;
  return { cost_input_per_1k: hit.cost_input_per_1k, cost_output_per_1k: hit.cost_output_per_1k };
}

function clockFormatter(timeZone: string): Intl.DateTimeFormat | null {
  const cached = clockFormatters.get(timeZone);
  if (cached) return cached;
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    clockFormatters.set(timeZone, formatter);
    return formatter;
  } catch {
    return null;
  }
}

export function isTimeZone(value: string): boolean {
  return Boolean(value) && clockFormatter(value) !== null;
}

function weekdayOf(value: string | undefined): Weekday | null {
  const day = value?.toLowerCase();
  return WEEKDAYS.find((weekday) => weekday === day) ?? null;
}

export function localTime(at: Date, timeZone: string): { weekday: Weekday; minute: number } {
  const formatter = clockFormatter(timeZone) ?? clockFormatter("UTC");
  const parts = formatter?.formatToParts(at) ?? [];
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? at.getUTCHours());
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? at.getUTCMinutes());
  const weekday = weekdayOf(parts.find((part) => part.type === "weekday")?.value) ?? UTC_WEEKDAYS[at.getUTCDay()];
  return { weekday, minute: (hour % 24) * 60 + minute };
}

export function localMinute(at: Date, timeZone: string): number {
  return localTime(at, timeZone).minute;
}

export function priceAt(schedule: PriceSchedule, at: Date): CostRates {
  if (!schedule.windows.length) return schedule.price;
  return scheduledPrice(schedule.price, schedule.windows, localMinute(at, schedule.time_zone));
}
