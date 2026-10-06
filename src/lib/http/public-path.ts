export const APP_LOCALES = ["en", "de"] as const;

export function routePathname(pathname: string): string {
  for (const locale of APP_LOCALES) {
    if (pathname === `/${locale}`) return "/";
    if (pathname.startsWith(`/${locale}/`)) {
      return pathname.slice(locale.length + 1);
    }
  }
  return pathname;
}

export function shouldHardenTransport(
  hostname: string,
  protocol: string,
): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").replace(/:\d+$/, "");
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") {
    return false;
  }
  return protocol.replace(":", "") === "https";
}
