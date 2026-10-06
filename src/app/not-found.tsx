"use client";

import { useTranslations } from "next-intl";
import { Link } from "@/i18n/routing";

export default function NotFound() {
  const t = useTranslations("Error.notFound");
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-3 p-10 text-center">
      <h1 className="text-2xl font-semibold">{t("title")}</h1>
      <Link href="/" className="text-accent">
        {t("goHome")}
      </Link>
    </main>
  );
}
