"use client";

import type { ReactNode } from "react";
import { Card } from "@heroui/react";
import { useTranslations } from "next-intl";
import BrandMark from "@/components/brand/brand-mark";
import { Link } from "@/i18n/routing";

export default function AccountShell({
  title,
  subtitle,
  children,
  footer,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const t = useTranslations("Common");
  return (
    <main className="flex flex-1 flex-col items-center justify-center bg-background px-4 py-16 text-foreground">
      <div className="w-full max-w-md">
        <div className="mb-8 flex flex-col items-center text-center">
          <Link href="/" aria-label={t("goHome")} className="mb-8 inline-flex items-center gap-2.5">
            <BrandMark size="md" />
            <span className="text-lg font-semibold tracking-tight">{t("appName")}</span>
          </Link>
          <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">{title}</h1>
          {subtitle ? <p className="mt-3 max-w-sm text-sm text-muted">{subtitle}</p> : null}
        </div>
        <Card className="p-5 sm:p-7">{children}</Card>
        {footer ? <div className="mt-6 text-center text-sm text-muted">{footer}</div> : null}
      </div>
    </main>
  );
}
