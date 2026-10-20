import { Card, Skeleton } from "@heroui/react";
import type { LucideIcon } from "lucide-react";
import { useTranslations } from "next-intl";
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
  value: string | null;
  icon?: LucideIcon;
  tone?: Tone;
  hint?: string;
  pending?: boolean;
}) {
  const t = useTranslations("Common");
  const loading = pending || value === null;
  return (
    <Card className="@container gap-2" aria-busy={loading || undefined}>
      <div className="flex items-start justify-between gap-3">
        <Card.Description className="min-w-0 pt-1 font-medium">{label}</Card.Description>
        {icon ? <IconTile icon={icon} tone={loading ? "neutral" : tone} /> : null}
      </div>
      {loading ? (
        <>
          <Skeleton className="my-1 h-7 w-20 rounded-lg" />
          <span className="sr-only">{t("notLoaded")}</span>
        </>
      ) : (
        <p className="text-xl font-semibold tracking-tight tabular-nums wrap-anywhere text-foreground @min-[13rem]:text-2xl">
          {value}
        </p>
      )}
      {hint && !loading ? <p className="text-xs text-muted">{hint}</p> : null}
    </Card>
  );
}
