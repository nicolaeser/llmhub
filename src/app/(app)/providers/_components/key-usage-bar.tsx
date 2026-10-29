"use client";

import { useFormatter } from "next-intl";
import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import ChartTooltip from "@/components/usage/chart-tooltip";
import type { BarSegment, SegmentKind } from "./key-usage-view";

const FULL_PERCENT = 100;
const FREE = "free";
const GAP = { stroke: "var(--surface)", strokeWidth: 2 } as const;
const RADIUS = 6;

const FILL: Record<SegmentKind, string> = {
  key: "var(--accent)",
  other: "var(--muted)",
  outside: "var(--muted)",
};

type BarRadius = [number, number, number, number];

function radiusOf(index: number, last: number): BarRadius {
  const left = index === 0 ? RADIUS : 0;
  const right = index === last ? RADIUS : 0;
  return [left, right, right, left];
}

export function SegmentDot({ kind, shade }: { kind: SegmentKind; shade: number }) {
  return (
    <svg aria-hidden viewBox="0 0 10 10" className="size-2.5 shrink-0">
      <circle cx="5" cy="5" r="5" fill={FILL[kind]} fillOpacity={shade} />
    </svg>
  );
}

export default function KeyUsageBar({
  label,
  segments,
  used,
  nameOf,
  freeLabel,
}: {
  label: string;
  segments: BarSegment[];
  used: number;
  nameOf: (segment: BarSegment) => string;
  freeLabel: string;
}) {
  const format = useFormatter();
  const free = Math.max(0, FULL_PERCENT - used);
  const parts = [
    ...segments.map((segment, index) => ({ dataKey: `s${index}`, segment })),
    ...(free > 0 ? [{ dataKey: FREE, segment: null }] : []),
  ];
  const row: Record<string, number | string> = { name: label };
  parts.forEach((part) => {
    row[part.dataKey] = part.segment ? part.segment.percent : free;
  });
  const last = parts.length - 1;

  return (
    <div className="h-4" role="img" aria-label={label}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart layout="vertical" data={[row]} margin={{ top: 0, right: 0, bottom: 0, left: 0 }} barCategoryGap={0}>
          <XAxis type="number" domain={[0, FULL_PERCENT]} hide />
          <YAxis type="category" dataKey="name" hide />
          <Tooltip
            cursor={false}
            content={(props) => (
              <ChartTooltip
                active={props.active}
                payload={props.payload}
                labelText={label}
                formatValue={(_, value) => format.number(value / FULL_PERCENT, { style: "percent", maximumFractionDigits: 1 })}
              />
            )}
          />
          {parts.map((part, index) => (
            <Bar
              key={part.dataKey}
              dataKey={part.dataKey}
              name={part.segment ? nameOf(part.segment) : freeLabel}
              stackId="window"
              fill={part.segment ? FILL[part.segment.kind] : "var(--default)"}
              fillOpacity={part.segment ? part.segment.shade : 1}
              radius={radiusOf(index, last)}
              isAnimationActive={false}
              {...GAP}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
