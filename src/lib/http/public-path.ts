export const APP_LOCALES = ["en", "de"] as const;

export const SUB_ADD_PATH = "/providers/sub-add";
const SUB_ADD_TOKEN = "[A-Za-z0-9_-]{43}";
export const SUB_ADD_TOKEN_PATTERN = new RegExp(`^${SUB_ADD_TOKEN}$`);
const SUB_ADD_PAGE_PATTERN = new RegExp(`^${SUB_ADD_PATH}/(?:manage/)?${SUB_ADD_TOKEN}$`);

export function isSubAddPage(routePath: string): boolean {
  return SUB_ADD_PAGE_PATTERN.test(routePath);
}

export function subAddPath(token: string): string {
  return `${SUB_ADD_PATH}/${token}`;
}

export function subAddManagePath(token: string): string {
  return `${SUB_ADD_PATH}/manage/${token}`;
}

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
