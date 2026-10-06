import { defineRouting } from "next-intl/routing";
import { createNavigation } from "next-intl/navigation";

export const routing = defineRouting({
  locales: ["en", "de"],
  defaultLocale: "en",
  localePrefix: "never",
});

export const { Link,  usePathname, useRouter,  } =
  createNavigation(routing);
