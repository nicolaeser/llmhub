"use client";

import { Tooltip } from "@heroui/react";
import { Bar, BarChart, ResponsiveContainer, XAxis, YAxis } from "recharts";
import { useUsagePercent, type SegmentNamer } from "./key-usage-labels";
import type { BarSegment, SegmentKind } from "./key-usage-view";

const FULL_PERCENT = 100;
const FREE = "free";
const GAP = { stroke: "var(--surface)", strokeWidth: 2 } as const;
const RADIUS = { sm: 4, md: 6 } as const;

const FILL: Record<SegmentKind, string> = {
  key: "var(--accent)",
  other: "var(--muted)",
  outside: "var(--muted)",
};

type BarRadius = [number, number, number, number];

type BarPart = { dataKey: string; segment: BarSegment | null; percent: number };

function radiusOf(index: number, last: number, radius: number): BarRadius {
  const left = index === 0 ? radius : 0;
  const right = index === last ? radius : 0;
  return [left, right, right, left];
}

export function SegmentDot({ kind, shade }: { kind: SegmentKind | "free"; shade: number }) {
  return (
    <svg aria-hidden viewBox="0 0 10 10" className="size-2.5 shrink-0">
      {kind === "free" ? (
        <circle cx="5" cy="5" r="4.25" fill="none" stroke="var(--muted)" strokeWidth="1.5" />
      ) : (
        <circle cx="5" cy="5" r="5" fill={FILL[kind]} fillOpacity={shade} />
      )}
    </svg>
  );
}

export function KeyUsageLegend({
  label,
  segments,
  nameOf,
}: {
  label: string;
  segments: BarSegment[];
  nameOf: SegmentNamer;
}) {
  const percent = useUsagePercent();
  return (
    <ul aria-label={label} className="flex flex-wrap gap-x-3 gap-y-1">
      {segments.map((segment) => (
        <li key={segment.id} className="flex min-w-0 items-center gap-1.5 text-xs">
          <SegmentDot kind={segment.kind} shade={segment.shade} />
          <span className="min-w-0 break-words text-muted">{nameOf(segment)}</span>
          <span className="font-medium tabular-nums text-foreground">{percent(segment.percent)}</span>
        </li>
      ))}
    </ul>
  );
}

export default function KeyUsageBar({
  label,
  segments,
  used,
  nameOf,
  freeLabel,
  size = "md",
}: {
  label: string;
  segments: BarSegment[];
  used: number;
  nameOf: SegmentNamer;
  freeLabel: string;
  size?: "sm" | "md";
}) {
  const percent = useUsagePercent();
  const free = Math.max(0, FULL_PERCENT - used);
  const parts: BarPart[] = [
    ...segments.map((segment, index) => ({ dataKey: `s${index}`, segment, percent: segment.percent })),
    ...(free > 0 ? [{ dataKey: FREE, segment: null, percent: free }] : []),
  ];
  const row: Record<string, number | string> = { name: label };
  parts.forEach((part) => {
    row[part.dataKey] = part.percent;
  });
  const last = parts.length - 1;

  return (
    <Tooltip delay={0} closeDelay={0}>
      <Tooltip.Trigger
        role="img"
        aria-label={label}
        className={size === "sm" ? "block h-2.5 w-full rounded-sm" : "block h-4 w-full rounded-sm"}
      >
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            layout="vertical"
            data={[row]}
            margin={{ top: 0, right: 0, bottom: 0, left: 0 }}
            barCategoryGap={0}
            accessibilityLayer={false}
          >
            <XAxis type="number" domain={[0, FULL_PERCENT]} hide />
            <YAxis type="category" dataKey="name" hide />
            {parts.map((part, index) => (
              <Bar
                key={part.dataKey}
                dataKey={part.dataKey}
                stackId="window"
                fill={part.segment ? FILL[part.segment.kind] : "var(--default)"}
                fillOpacity={part.segment ? part.segment.shade : 1}
                radius={radiusOf(index, last, RADIUS[size])}
                isAnimationActive={false}
                {...GAP}
              />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </Tooltip.Trigger>
      <Tooltip.Content className="min-w-52">
        <p className="text-muted">{label}</p>
        <ul className="mt-1.5 space-y-1 break-normal">
          {parts.map((part) => (
            <li key={part.dataKey} className="flex items-center justify-between gap-4">
              <span className="flex min-w-0 items-center gap-1.5">
                <SegmentDot kind={part.segment?.kind ?? "free"} shade={part.segment?.shade ?? 1} />
                <span className="min-w-0 break-words text-foreground">
                  {part.segment ? nameOf(part.segment) : freeLabel}
                </span>
              </span>
              <span className="font-medium tabular-nums text-foreground">{percent(part.percent)}</span>
            </li>
          ))}
        </ul>
      </Tooltip.Content>
    </Tooltip>
  );
}
