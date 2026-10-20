import { Card, Skeleton } from "@heroui/react";
import type { LucideIcon } from "lucide-react";
import IconTile from "@/components/console/icon-tile";
import type { Tone } from "@/types/console";

export default function StatCard({
  label,
  value,
  icon,
  tone = "accent",
  hint,
  pending = false,
}: {
  label: string;
  value: string;
  icon?: LucideIcon;
  tone?: Tone;
  hint?: string;
  pending?: boolean;
}) {
  return (
    <Card className="@container">
      <div className="flex flex-col items-start gap-3 @min-[11rem]:flex-row @min-[11rem]:items-center">
        {icon ? <IconTile icon={icon} tone={tone} /> : null}
        <div className="min-w-0">
          <Card.Description>{label}</Card.Description>
          {pending ? (
            <Skeleton className="my-1 h-6 w-12 rounded-lg" />
          ) : (
            <p className="text-xl font-semibold tracking-tight wrap-anywhere">{value}</p>
          )}
          {hint && !pending ? <p className="text-xs text-muted">{hint}</p> : null}
        </div>
      </div>
    </Card>
  );
}
