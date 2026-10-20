import type { ReactNode } from "react";
import { Skeleton } from "@heroui/react";
import type { LucideIcon } from "lucide-react";
import IconTile from "@/components/console/icon-tile";

export default function PageHeader({
  title,
  subtitle,
  actions,
  icon,
  subtitlePending = false,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  icon?: LucideIcon;
  subtitlePending?: boolean;
}) {
  return (
    <header className="mb-7 flex flex-wrap items-start justify-between gap-4">
      <div className="flex min-w-0 grow basis-80 items-center gap-4">
        {icon ? <IconTile icon={icon} size="lg" /> : null}
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight break-words text-foreground sm:text-2xl">{title}</h1>
          {subtitle ? (
            <p className="mt-1 max-w-3xl text-sm text-muted">{subtitle}</p>
          ) : subtitlePending ? (
            <Skeleton className="mt-2 h-3.5 w-80 max-w-full rounded-lg" />
          ) : null}
        </div>
      </div>
      {actions ? (
        <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center [&>button]:w-full sm:[&>button]:w-auto [&>a]:w-full sm:[&>a]:w-auto">
          {actions}
        </div>
      ) : null}
    </header>
  );
}
