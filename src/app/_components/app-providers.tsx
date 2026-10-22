"use client";

import type { ReactNode } from "react";
import { RouterProvider, Toast } from "@heroui/react";
import { NextIntlClientProvider, useLocale } from "next-intl";
import { useRouter } from "@/i18n/routing";
import { ThemeProvider } from "next-themes";
import { useSelectedConsoleTimeZone } from "@/lib/hooks/use-console-time-zone";
import { navigateAppHref } from "@/lib/http/app-navigation";

export default function AppProviders({
  children,
  nonce,
}: {
  children: ReactNode;
  nonce?: string;
}) {
  const router = useRouter();
  const locale = useLocale();
  const timeZone = useSelectedConsoleTimeZone();

  return (
    <ThemeProvider
      attribute="class"
      defaultTheme="dark"
      enableSystem={false}
      disableTransitionOnChange
      nonce={nonce}
    >
      <RouterProvider
        navigate={(href) =>
          navigateAppHref(href, (path) => {
            void router.push(path);
          })
        }
      >
        <NextIntlClientProvider locale={locale} timeZone={timeZone}>
          <Toast.Provider />
          {children}
        </NextIntlClientProvider>
      </RouterProvider>
    </ThemeProvider>
  );
}
