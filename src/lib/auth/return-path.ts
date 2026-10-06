const AUTH_SEGMENTS = new Set([
  "login",
  "register",
  "forgot-password",
  "reset-password",
  "awaiting-verification",
  "verify",
]);
const LOCALES = new Set(["en", "de"]);

function collapsePathname(pathOnly: string): string | null {
  const keepTrailing = pathOnly.endsWith("/") && pathOnly !== "/";
  const parts: string[] = [];
  for (const segment of pathOnly.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") return null;
    parts.push(segment);
  }
  if (parts.length === 0) return "/";
  return `/${parts.join("/")}${keepTrailing ? "/" : ""}`;
}

function stripLocalePrefix(pathname: string): string {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length === 0) return pathname;
  if (!LOCALES.has(parts[0])) return pathname;
  const rest = parts.slice(1);
  if (rest.length === 0) return "/";
  const keepTrailing = pathname.endsWith("/") && pathname !== "/";
  return `/${rest.join("/")}${keepTrailing ? "/" : ""}`;
}

function isAuthLoopPath(pathname: string): boolean {
  const parts = pathname.split("/").filter(Boolean);
  return parts[0] === "account" && AUTH_SEGMENTS.has(parts[1] ?? "");
}

export function sanitizeReturnPath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (value.length === 0 || value.length > 512) return null;
  if (!value.startsWith("/")) return null;
  if (value.startsWith("//") || value.startsWith("/\\")) return null;
  if (value.includes("\\")) return null;
  if (/[\r\n\t]/.test(value)) return null;
  if (/^\/[a-z][a-z0-9+.-]*:/i.test(value)) return null;

  const [rawPath, query] = value.split(/[?#]/);
  if (!rawPath.startsWith("/") || rawPath.startsWith("//")) return null;

  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return null;
  }
  if (decoded.startsWith("//") || decoded.startsWith("/\\")) return null;
  if (decoded.includes("\\")) return null;

  const collapsed = collapsePathname(decoded);
  if (!collapsed) return null;
  const normalized = stripLocalePrefix(collapsed);
  if (isAuthLoopPath(normalized)) return null;

  return query ? `${normalized}?${query}` : normalized;
}

export function postLoginDestination(
  returnValue: unknown,
  serverRedirect?: unknown,
): string {
  return (
    sanitizeReturnPath(returnValue) ??
    sanitizeReturnPath(serverRedirect) ??
    "/"
  );
}

export function withReturnQuery(path: string, returnValue: unknown): string {
  const safe = sanitizeReturnPath(returnValue);
  if (!safe) return path;
  const [pathname, existing = ""] = path.split("?");
  const params = new URLSearchParams(existing);
  params.set("return", safe);
  const query = params.toString();
  return query ? `${pathname}?${query}` : pathname;
}
