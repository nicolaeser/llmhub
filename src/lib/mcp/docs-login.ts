import { authNameValid } from "@/schemas/mcp";
import type { McpDocsLink, McpDocsLogin } from "@/types/mcp";

export function sameSite(start: URL, target: URL): boolean {
  if (target.origin === start.origin) return true;
  return start.protocol === "http:" && target.protocol === "https:" && target.hostname === start.hostname;
}

export function docsLoginFor(baseUrl: string, links: McpDocsLink[]): McpDocsLogin | null {
  const value = baseUrl.trim();
  if (!/^https?:\/\//i.test(value) || !URL.canParse(value)) return null;
  const base = new URL(value);
  for (const [index, link] of links.entries()) {
    if (!URL.canParse(link.url) || !sameSite(new URL(link.url), base)) continue;
    if (link.auth === "bearer") return { link: index, authType: "bearer", authHeader: "", secret: link.secret };
    if (link.auth !== "basic" && link.auth !== "header" && link.auth !== "query") continue;
    if (link.auth === "header" && link.name.toLowerCase() === "cookie") continue;
    if (!authNameValid(link.auth, link.name)) continue;
    return { link: index, authType: link.auth, authHeader: link.name.trim(), secret: link.secret };
  }
  return null;
}
