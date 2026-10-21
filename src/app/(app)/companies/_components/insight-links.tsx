"use client";

import { buttonVariants } from "@heroui/react";
import { Activity, BarChart3 } from "lucide-react";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/routing";

export default function InsightLinks({ usage, logs }: { usage: string; logs?: string }) {
  const t = useTranslations("Companies.insights");

  return (
    <>
      <Link href={usage} className={buttonVariants({ size: "sm", variant: "secondary" })}>
        <BarChart3 size={14} aria-hidden />
        {t("usage")}
      </Link>
      {logs ? (
        <Link href={logs} className={buttonVariants({ size: "sm", variant: "secondary" })}>
          <Activity size={14} aria-hidden />
          {t("logs")}
        </Link>
      ) : null}
    </>
  );
}
