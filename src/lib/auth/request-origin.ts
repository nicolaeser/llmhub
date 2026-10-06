const hostOf = (value: string | null | undefined) => {
  if (!value) return null;
  try {
    return new URL(value).host.toLowerCase();
  } catch {
    return null;
  }
};

export function isSameOriginRequest(headers: Headers, appUrl: string): boolean {
  const site = headers.get("sec-fetch-site");
  if (site === "cross-site" || site === "same-site") return false;
  const origin = headers.get("origin");
  if (origin === null) return true;
  const originHost = hostOf(origin);
  if (!originHost) return false;
  const requestHost = (headers.get("x-forwarded-host") ?? headers.get("host") ?? "")
    .split(",")[0]
    .trim()
    .toLowerCase();
  return originHost === hostOf(appUrl) || (requestHost !== "" && originHost === requestHost);
}
