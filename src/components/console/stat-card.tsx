import { Card } from "@heroui/react";
import type { LucideIcon } from "lucide-react";
import IconTile from "@/components/console/icon-tile";
import type { Tone } from "@/types/console";

export default function StatCard({
  label,
  value,
  icon,
  tone = "accent",
  hint,
}: {
  label: string;
  value: string;
  icon?: LucideIcon;
  tone?: Tone;
  hint?: string;
}) {
  return (
    <Card className="flex-row items-center gap-3">
      {icon ? <IconTile icon={icon} tone={tone} /> : null}
      <div className="min-w-0">
        <Card.Description>{label}</Card.Description>
        <p className="text-xl font-semibold tracking-tight">{value}</p>
        {hint ? <p className="text-xs text-muted">{hint}</p> : null}
      </div>
    </Card>
  );
}
