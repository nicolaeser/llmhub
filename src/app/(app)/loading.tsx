"use client";

import { Spinner } from "@heroui/react";
import { useTranslations } from "next-intl";

export default function AppLoading() {
  const tCommon = useTranslations("Common");
  return (
    <output
      aria-live="polite"
      aria-label={tCommon("loading")}
      className="flex min-h-[60vh] items-center justify-center text-accent"
    >
      <Spinner color="current" size="lg" />
    </output>
  );
}
