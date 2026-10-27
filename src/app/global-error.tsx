"use client";

import { useEffect, useSyncExternalStore } from "react";
import { Button, buttonVariants } from "@heroui/react";
import { RotateCcw } from "lucide-react";
import { createTranslator } from "next-intl";
import BrandMark from "@/components/brand/brand-mark";
import { reportClientError } from "@/lib/sentry/report-client-error";
import { errorDigest } from "@/lib/utils/error-digest";
import de from "../../lang/de/GlobalError.json";
import en from "../../lang/en/GlobalError.json";

const MESSAGES = { en, de };

type Locale = keyof typeof MESSAGES;

const LOCALE_COOKIE = "NEXT_LOCALE=";

function isLocale(value: string | undefined): value is Locale {
  return value === "en" || value === "de";
}

function readLocale(): Locale {
  const cookie = document.cookie
    .split("; ")
    .find((part) => part.startsWith(LOCALE_COOKIE))
    ?.slice(LOCALE_COOKIE.length);
  const preferred = [cookie, ...navigator.languages.map((tag) => tag.slice(0, 2).toLowerCase())];
  return preferred.find(isLocale) ?? "en";
}

function storedTheme(): string | null {
  try {
    return window.localStorage.getItem("theme");
  } catch {
    return null;
  }
}

function readTheme(): "dark" | "light" {
  return storedTheme() === "light" ? "light" : "dark";
}

function subscribeNever() {
  return () => {};
}

export default function GlobalError({ error, retry }: { error: unknown; retry: () => void }) {
  const locale = useSyncExternalStore<Locale>(subscribeNever, readLocale, () => "en");
  const theme = useSyncExternalStore(subscribeNever, readTheme, () => "dark");
  const t = createTranslator({ locale, messages: MESSAGES[locale] });
  const digest = errorDigest(error);
  useEffect(() => {
    reportClientError(error, { boundary: "global", digest });
  }, [error, digest]);

  return (
    <html lang={locale} className={`${theme} h-full antialiased`}>
      <body className="flex min-h-full flex-col bg-background text-foreground">
        <title>{t("documentTitle")}</title>
        <main className="flex flex-1 flex-col items-center justify-center gap-4 px-4 py-16 text-center">
          <BrandMark size="md" />
          <div role="alert" className="flex flex-col items-center gap-3">
            <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
            <p className="max-w-md text-sm text-muted">{t("description")}</p>
            {digest ? <p className="text-xs break-all text-muted">{t("errorId", { id: digest })}</p> : null}
          </div>
          <div className="flex flex-wrap justify-center gap-2">
            <Button onPress={retry}>
              <RotateCcw size={14} aria-hidden />
              {t("tryAgain")}
            </Button>
            <a href="/" className={buttonVariants({ variant: "secondary" })}>
              {t("goHome")}
            </a>
          </div>
        </main>
      </body>
    </html>
  );
}
