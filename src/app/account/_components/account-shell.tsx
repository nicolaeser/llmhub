"use client";

import type { ReactNode } from "react";
import { Card, Skeleton } from "@heroui/react";
import { useTranslations } from "next-intl";
import BrandMark from "@/components/brand/brand-mark";
import { Link } from "@/i18n/routing";

export default function AccountShell({
  title,
  subtitle,
  children,
  footer,
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const t = useTranslations("Common");
  return (
    <main className="flex flex-1 flex-col items-center justify-center bg-background px-4 py-16 text-foreground">
      <div className="w-full max-w-md">
        <div className="mb-8 flex flex-col items-center text-center">
          <Link href="/" aria-label={t("goHome")} className="mb-10 inline-flex flex-col items-center gap-3">
            <BrandMark size="lg" />
            <span className="text-sm font-semibold tracking-tight text-muted">{t("appName")}</span>
          </Link>
          {title ? (
            <h1 className="text-3xl font-semibold tracking-tight text-balance sm:text-4xl">{title}</h1>
          ) : (
            <Skeleton className="h-9 w-56 max-w-full rounded-xl sm:h-10" />
          )}
          {subtitle ? (
            <p className="mt-3 max-w-sm text-sm text-muted">{subtitle}</p>
          ) : title ? null : (
            <Skeleton className="mt-4 h-3.5 w-64 max-w-full rounded-lg" />
          )}
        </div>
        <Card className="p-5 shadow-overlay sm:p-8">{children}</Card>
        {footer ? <div className="mt-6 text-center text-sm text-muted">{footer}</div> : null}
      </div>
    </main>
  );
}
