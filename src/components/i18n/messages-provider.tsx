"use client";

import { useMemo, type ReactNode } from "react";
import { NextIntlClientProvider, useLocale, useMessages } from "next-intl";
import { mergeMessages } from "@/i18n/message-tree";
import type { Messages } from "@/types/i18n";

export default function MessagesProvider({ messages, children }: { messages: Messages; children: ReactNode }) {
  const locale = useLocale();
  const inherited = useMessages();
  const merged = useMemo(() => mergeMessages(inherited, messages), [inherited, messages]);
  return (
    <NextIntlClientProvider locale={locale} messages={merged}>
      {children}
    </NextIntlClientProvider>
  );
}
