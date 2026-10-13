import { parseTime, type Time } from "@internationalized/date";
import { clockMinute } from "@/lib/gateway/billing/price-schedule";

export function clockTime(value: string): Time | null {
  return clockMinute(value) === null ? null : parseTime(value);
}
