import { Card } from "@heroui/react";
import type { TipItem } from "@/types/usage";

export default function ChartTooltip({
  active,
  payload,
  labelText,
  formatValue,
}: {
  active?: boolean;
  payload?: ReadonlyArray<TipItem>;
  labelText?: string;
  formatValue: (dataKey: string, value: number) => string;
}) {
  if (!active || !payload?.length) return null;
  const rows = payload.filter(
    (item) => item.value != null && !Array.isArray(item.value),
  );
  if (rows.length === 0) return null;
  return (
    <Card className="gap-1 px-3 py-2 text-sm">
      {labelText ? <div className="text-muted">{labelText}</div> : null}
      <ul className="space-y-1">
        {rows.map((item) => {
          const key = String(item.dataKey ?? item.name ?? "value");
          return (
            <li key={key} className="flex items-center justify-between gap-4">
              <span className="text-muted">{String(item.name ?? key)}</span>
              <span className="font-medium">
                {formatValue(key, Number(item.value))}
              </span>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
