import { BlockList, isIP } from "node:net";
import type { McpUrlVerdict } from "@/types/mcp";

const ALWAYS_BLOCKED = new BlockList();
ALWAYS_BLOCKED.addSubnet("0.0.0.0", 8, "ipv4");
ALWAYS_BLOCKED.addSubnet("169.254.0.0", 16, "ipv4");
ALWAYS_BLOCKED.addSubnet("224.0.0.0", 4, "ipv4");
ALWAYS_BLOCKED.addSubnet("240.0.0.0", 4, "ipv4");
ALWAYS_BLOCKED.addAddress("100.100.100.200", "ipv4");
ALWAYS_BLOCKED.addAddress("::", "ipv6");
ALWAYS_BLOCKED.addAddress("fd00:ec2::254", "ipv6");
ALWAYS_BLOCKED.addSubnet("fe80::", 10, "ipv6");
ALWAYS_BLOCKED.addSubnet("ff00::", 8, "ipv6");

const PRIVATE = new BlockList();
PRIVATE.addSubnet("10.0.0.0", 8, "ipv4");
PRIVATE.addSubnet("100.64.0.0", 10, "ipv4");
PRIVATE.addSubnet("127.0.0.0", 8, "ipv4");
PRIVATE.addSubnet("172.16.0.0", 12, "ipv4");
PRIVATE.addSubnet("192.0.0.0", 24, "ipv4");
PRIVATE.addSubnet("192.168.0.0", 16, "ipv4");
PRIVATE.addSubnet("198.18.0.0", 15, "ipv4");
PRIVATE.addAddress("::1", "ipv6");
PRIVATE.addSubnet("fc00::", 7, "ipv6");
PRIVATE.addSubnet("64:ff9b::", 96, "ipv6");
PRIVATE.addSubnet("64:ff9b:1::", 48, "ipv6");

const MAX_URL_LENGTH = 2048;

function mappedIpv4(address: string): string | null {
  const lower = address.toLowerCase();
  const dotted = /^(?:0{0,4}:){0,5}(?:0{0,4}:)?ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(lower) ?? /^::(\d{1,3}(?:\.\d{1,3}){3})$/.exec(lower);
  if (dotted) return dotted[1]!;
  const hex = /^(?:0{0,4}:){0,5}(?:0{0,4}:)?ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (!hex) return null;
  const high = parseInt(hex[1]!, 16);
  const low = parseInt(hex[2]!, 16);
  return [high >> 8, high & 255, low >> 8, low & 255].join(".");
}

function family(address: string): "ipv4" | "ipv6" | null {
  const version = isIP(address);
  if (version === 4) return "ipv4";
  if (version === 6) return "ipv6";
  return null;
}

export function addressAllowed(raw: string, internal: boolean): boolean {
  const address = raw.replace(/^\[|\]$/g, "").split("%")[0]!;
  const kind = family(address);
  if (!kind) return false;
  const v4 = kind === "ipv6" ? mappedIpv4(address) : null;
  const target = v4 ?? address;
  const targetKind = v4 ? "ipv4" : kind;
  if (ALWAYS_BLOCKED.check(target, targetKind)) return false;
  if (PRIVATE.check(target, targetKind)) return internal;
  return true;
}

export function checkServerUrl(raw: string, internal: boolean): McpUrlVerdict {
  const text = raw.trim();
  if (!text || text.length > MAX_URL_LENGTH || !URL.canParse(text)) return { ok: false, code: "MCP_URL_INVALID" };
  const url = new URL(text);
  if (url.username || url.password || url.hash) return { ok: false, code: "MCP_URL_INVALID" };
  if (url.protocol !== "https:" && url.protocol !== "http:") return { ok: false, code: "MCP_URL_INVALID" };
  if (url.protocol === "http:" && !internal) return { ok: false, code: "MCP_URL_INSECURE" };
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!host) return { ok: false, code: "MCP_URL_INVALID" };
  if (family(host)) return addressAllowed(host, internal) ? { ok: true, url } : { ok: false, code: "MCP_URL_BLOCKED" };
  const lower = host.toLowerCase().replace(/\.$/, "");
  if (!internal && (lower === "localhost" || lower.endsWith(".localhost") || lower.endsWith(".internal") || lower.endsWith(".local"))) {
    return { ok: false, code: "MCP_URL_BLOCKED" };
  }
  if (lower === "metadata.google.internal" || lower === "metadata") return { ok: false, code: "MCP_URL_BLOCKED" };
  return { ok: true, url };
}
