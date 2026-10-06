"use client";

import { useTransition } from "react";
import { Button, Dropdown, Label } from "@heroui/react";
import { Check, ChevronDown, Globe } from "lucide-react";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { usePathname, useRouter } from "@/i18n/routing";
import { routing } from "@/i18n/routing";

const LOCALES = routing.locales;

export default function LanguageSwitcher() {
  const locale = useLocale();
  const router = useRouter();
  const pathname = usePathname();
  const t = useTranslations("LanguageSwitcher");
  const format = useFormatter();
  const [, startTransition] = useTransition();

  function localeName(code: string) {
    return format.displayName(code, { type: "language" }) ?? code.toUpperCase();
  }

  return (
    <Dropdown>
      <Dropdown.Trigger>
        <Button
          fullWidth
          size="sm"
          variant="secondary"
          aria-label={t("selector")}
          className="justify-between"
        >
          <span className="inline-flex items-center gap-1.5">
            <Globe size={14} aria-hidden />
            {localeName(locale)}
          </span>
          <ChevronDown size={14} aria-hidden />
        </Button>
      </Dropdown.Trigger>
      <Dropdown.Popover>
        <Dropdown.Menu
          aria-label={t("selector")}
          onAction={(key) => {
            const next = String(key);
            if (next === locale) return;
            startTransition(() => {
              router.replace(pathname, {
                locale: next as (typeof routing.locales)[number],
              });
            });
          }}
        >
          {LOCALES.map((code) => (
            <Dropdown.Item
              key={code}
              id={code}
              textValue={localeName(code)}
            >
              <div className="flex items-center justify-between gap-3">
                <Label>{localeName(code)}</Label>
                {code === locale ? (
                  <Check size={14} className="text-accent" aria-hidden />
                ) : null}
              </div>
            </Dropdown.Item>
          ))}
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  );
}
