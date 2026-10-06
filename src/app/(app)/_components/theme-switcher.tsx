"use client";

import { useSyncExternalStore } from "react";
import { useTheme } from "next-themes";
import { Button } from "@heroui/react";
import { Moon, Sun } from "lucide-react";
import { useTranslations } from "next-intl";

const emptySubscribe = () => () => {};

export default function ThemeSwitcher() {
  const t = useTranslations("Common");
  const { resolvedTheme, setTheme } = useTheme();
  const mounted = useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false,
  );
  const isDark = mounted ? resolvedTheme !== "light" : true;
  const label = t("theme.toggle", { isDark: isDark ? "true" : "false" });

  return (
    <Button
      isIconOnly
      size="sm"
      variant="ghost"
      onPress={() => setTheme(isDark ? "light" : "dark")}
      aria-label={label}
      aria-pressed={isDark}
      className="text-muted"
    >
      {mounted ? (
        isDark ? <Sun size={16} aria-hidden /> : <Moon size={16} aria-hidden />
      ) : null}
    </Button>
  );
}
