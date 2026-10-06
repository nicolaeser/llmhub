import type { AppRouterInstance } from "next/dist/shared/lib/app-router-context.shared-runtime";

export function navigateAppHref(
  href: string,
  push: AppRouterInstance["push"],
) {
  if (href.startsWith("http://") || href.startsWith("https://")) {
    window.location.assign(href);
    return;
  }
  push(href);
}
