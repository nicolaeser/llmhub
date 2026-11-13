"use client";

import { useId } from "react";
import { Tooltip } from "@heroui/react";
import { useUsagePercent, type SegmentNamer } from "./key-usage-labels";
import { barParts, type BarPart, type BarSegment, type SegmentKind } from "./key-usage-view";
import { toneHue, type LimitTone } from "./limit-tone";

const GAP_WIDTH = 2;
const GAP_FILL = "var(--surface)";
const FREE_FILL = "var(--default)";
const MUTED_FILL = "var(--muted)";
const RADIUS = { sm: 4, md: 6 } as const;
const TRACK = { sm: "block h-2.5 w-full rounded-sm p-px", md: "block h-4 w-full rounded-sm p-px" } as const;

function segmentFill(kind: SegmentKind, tone: LimitTone): string {
  return kind === "key" ? toneHue(tone) : MUTED_FILL;
}

export function SegmentDot({
  kind,
  shade,
  tone = "calm",
}: {
  kind: SegmentKind | "free";
  shade: number;
  tone?: LimitTone;
}) {
  return (
    <svg aria-hidden viewBox="0 0 10 10" className="size-2.5 shrink-0">
      {kind === "free" ? (
        <circle cx="5" cy="5" r="4.25" fill="none" stroke={MUTED_FILL} strokeWidth="1.5" />
      ) : (
        <circle cx="5" cy="5" r="5" fill={segmentFill(kind, tone)} fillOpacity={shade} />
      )}
    </svg>
  );
}

export function KeyUsageLegend({
  label,
  segments,
  tone,
  nameOf,
}: {
  label: string;
  segments: BarSegment[];
  tone: LimitTone;
  nameOf: SegmentNamer;
}) {
  const percent = useUsagePercent();
  return (
    <ul aria-label={label} className="flex flex-wrap gap-x-3 gap-y-1">
      {segments.map((segment) => (
        <li key={segment.id} className="flex min-w-0 items-center gap-1.5 text-xs">
          <SegmentDot kind={segment.kind} shade={segment.shade} tone={tone} />
          <span className="min-w-0 break-words text-muted">{nameOf(segment)}</span>
          <span className="font-medium tabular-nums text-foreground">{percent(segment.percent)}</span>
        </li>
      ))}
    </ul>
  );
}

function KeyUsageTrack({ parts, tone, radius }: { parts: BarPart[]; tone: LimitTone; radius: number }) {
  const clip = useId();
  return (
    <svg aria-hidden width="100%" height="100%" className="block">
      <clipPath id={clip}>
        <rect width="100%" height="100%" rx={radius} />
      </clipPath>
      <g clipPath={`url(#${clip})`} shapeRendering="crispEdges">
        {parts.map((part) => (
          <rect
            key={part.id}
            x={`${part.start}%`}
            width={`${part.size}%`}
            height="100%"
            fill={part.segment ? segmentFill(part.segment.kind, tone) : FREE_FILL}
            fillOpacity={part.segment ? part.segment.shade : 1}
          />
        ))}
        {parts.slice(1).map((part) => (
          <rect
            key={part.id}
            x={`${part.start}%`}
            width={GAP_WIDTH}
            height="100%"
            fill={GAP_FILL}
            transform={`translate(${-GAP_WIDTH / 2} 0)`}
          />
        ))}
      </g>
    </svg>
  );
}

export default function KeyUsageBar({
  label,
  segments,
  used,
  tone,
  nameOf,
  freeLabel,
  size = "md",
}: {
  label: string;
  segments: BarSegment[];
  used: number;
  tone: LimitTone;
  nameOf: SegmentNamer;
  freeLabel: string;
  size?: "sm" | "md";
}) {
  const percent = useUsagePercent();
  const parts = barParts(segments, used);

  return (
    <Tooltip delay={0} closeDelay={0}>
      <Tooltip.Trigger role="img" aria-label={label} className={TRACK[size]}>
        <KeyUsageTrack parts={parts} tone={tone} radius={RADIUS[size]} />
      </Tooltip.Trigger>
      <Tooltip.Content className="min-w-52">
        <p className="text-muted">{label}</p>
        <ul className="mt-1.5 space-y-1 break-normal">
          {parts.map((part) => (
            <li key={part.id} className="flex items-center justify-between gap-4">
              <span className="flex min-w-0 items-center gap-1.5">
                <SegmentDot kind={part.segment?.kind ?? "free"} shade={part.segment?.shade ?? 1} tone={tone} />
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
