import { defineRouting } from "next-intl/routing";
import { createNavigation } from "next-intl/navigation";
import { LOCALE_COOKIE } from "./locale-cookie";

export const routing = defineRouting({
  locales: ["en", "de"],
  defaultLocale: "en",
  localePrefix: "never",
  localeCookie: LOCALE_COOKIE,
});

export const { Link,  usePathname, useRouter,  } =
  createNavigation(routing);
