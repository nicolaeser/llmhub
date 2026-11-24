import type { HostedTool } from "@/types/mcp";

const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
const BARE_HOST = /^(?:localhost|\[[0-9a-f:.]+\]|[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+)(?::\d{1,5})?(?:[/?#]|$)/i;
const ADDRESS_IN_TEXT =
  /\bhttps?:\/\/[^\s"'<>`)\]]+|\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:de|at|ch|li|lu|eu|com|net|org|io|dev|app|cloud|info|biz|co|uk|us|nl|be|fr|it|es|pl|cz|dk|se|no|fi|online|tech|software|support|services|systems)(?::\d{1,5})?(?:\/[^\s"'<>`)\]]*)?(?![a-z0-9-]|\.[a-z0-9])/gi;

export function normalizeBaseUrl(raw: string): string {
  const value = raw.trim();
  if (!value) return "";
  const withScheme = SCHEME.test(value) ? value : BARE_HOST.test(value) ? `https://${value}` : value;
  if (!URL.canParse(withScheme)) return value;
  const url = new URL(withScheme);
  if (url.protocol !== "https:" && url.protocol !== "http:") return value;
  return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
}

export function basePathOf(baseUrl: string): string {
  return URL.canParse(baseUrl) ? new URL(baseUrl).pathname.replace(/\/+$/, "") : "";
}

export function joinBasePath(prefix: string, path: string): string {
  if (!prefix || path === prefix || path.startsWith(`${prefix}/`)) return path;
  return `${prefix}${path}`;
}

export function toolUrl(baseUrl: string, path: string): string {
  const base = normalizeBaseUrl(baseUrl);
  if (!/^https?:\/\//.test(base) || !URL.canParse(base)) return path;
  const url = new URL(base);
  return `${url.origin}${joinBasePath(url.pathname.replace(/\/+$/, ""), path)}`;
}

export function rebaseTools<T extends Pick<HostedTool, "path">>(baseUrl: string, tools: T[]): T[] {
  const prefix = basePathOf(baseUrl);
  if (!prefix) return tools;
  return tools.map((tool) =>
    tool.path.startsWith(`${prefix}/`) ? { ...tool, path: tool.path.slice(prefix.length) } : tool,
  );
}

export function addressInText(text: string): string {
  for (const match of text.matchAll(ADDRESS_IN_TEXT)) {
    const candidate = match[0].replace(/[.,;:!?]+$/, "");
    const address = normalizeBaseUrl(candidate);
    if (/^https?:\/\//.test(address)) return address;
  }
  return "";
}
