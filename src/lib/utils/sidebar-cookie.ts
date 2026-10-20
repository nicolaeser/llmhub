export const SIDEBAR_COOKIE = "llmhub_sidebar";

const COLLAPSED = "collapsed";
const MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

export function sidebarCollapsed(value: string | undefined): boolean {
  return value === COLLAPSED;
}

export function writeSidebarCookie(collapsed: boolean) {
  const secure = window.location.protocol === "https:" ? "; secure" : "";
  document.cookie = `${SIDEBAR_COOKIE}=${collapsed ? COLLAPSED : "expanded"}; path=/; max-age=${MAX_AGE_SECONDS}; samesite=lax${secure}`;
}
