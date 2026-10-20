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
    <Card className="@container" aria-busy={loading || undefined}>
      <div className="flex flex-col items-start gap-3 @min-[11rem]:flex-row @min-[11rem]:items-center">
        {icon ? <IconTile icon={icon} tone={loading ? "neutral" : tone} /> : null}
        <div className="min-w-0">
          <Card.Description>{label}</Card.Description>
          {loading ? (
            <>
              <Skeleton className="my-1 h-5 w-16 rounded-lg" />
              <span className="sr-only">{t("notLoaded")}</span>
            </>
          ) : (
            <p className="text-xl font-semibold tracking-tight wrap-anywhere">{value}</p>
          )}
          {hint && !loading ? <p className="text-xs text-muted">{hint}</p> : null}
        </div>
      </div>
    </Card>
  );
}
