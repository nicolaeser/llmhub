"use client";

import type { ReactNode } from "react";
import { NextIntlClientProvider, useLocale } from "next-intl";
import { useConsoleTimeZone, useConsoleTimeZoneState } from "@/lib/hooks/use-console-time-zone";

export default function TimeZoneProvider({ children }: { children: ReactNode }) {
  const locale = useLocale();
  const timeZone = useConsoleTimeZoneState(useConsoleTimeZone());
  return (
    <NextIntlClientProvider locale={locale} timeZone={timeZone}>
      {children}
    </NextIntlClientProvider>
  );
}
