import type { ReactNode } from "react";
import { Skeleton } from "@heroui/react";
import { ChevronLeft, type LucideIcon } from "lucide-react";
import IconTile from "@/components/console/icon-tile";
import { Link } from "@/i18n/routing";

export type PageBackLink = { href: string; label: string };

export default function PageHeader({
  title,
  subtitle,
  actions,
  icon,
  back,
  subtitlePending = false,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  icon?: LucideIcon;
  back?: PageBackLink;
  subtitlePending?: boolean;
}) {
  return (
    <header className="mb-6 flex flex-col gap-3">
      {back ? (
        <Link
          href={back.href}
          className="-ml-1 inline-flex w-fit items-center gap-1 rounded-lg px-1 text-sm text-muted hover:text-foreground motion-safe:transition-colors"
        >
          <ChevronLeft size={14} aria-hidden className="shrink-0" />
          <span className="break-words">{back.label}</span>
        </Link>
      ) : null}
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="flex min-w-0 grow basis-80 items-start gap-3">
          {icon ? (
            <span className="pt-0.5">
              <IconTile icon={icon} />
            </span>
          ) : null}
          <div className="min-w-0">
            <h1 className="text-xl leading-8 font-semibold tracking-tight break-words text-foreground">{title}</h1>
            {subtitle ? (
              <p className="max-w-3xl text-sm text-muted">{subtitle}</p>
            ) : subtitlePending ? (
              <Skeleton className="mt-1.5 h-3.5 w-80 max-w-full rounded-lg" />
            ) : null}
          </div>
        </div>
        {actions ? (
          <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center [&>a]:w-full sm:[&>a]:w-auto [&>button]:w-full sm:[&>button]:w-auto">
            {actions}
          </div>
        ) : null}
      </div>
    </header>
  );
}
