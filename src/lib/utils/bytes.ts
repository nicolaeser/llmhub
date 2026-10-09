import type { useFormatter } from "next-intl";

const BYTE_UNITS = ["byte", "kilobyte", "megabyte", "gigabyte", "terabyte"] as const;

export function formatBytes(format: ReturnType<typeof useFormatter>, bytes: number): string {
  let value = Math.max(0, bytes);
  let index = 0;
  while (value >= 1024 && index < BYTE_UNITS.length - 1) {
    value /= 1024;
    index += 1;
  }
  return format.number(value, {
    style: "unit",
    unit: BYTE_UNITS[index],
    unitDisplay: "short",
    maximumFractionDigits: index === 0 ? 0 : 1,
  });
}
