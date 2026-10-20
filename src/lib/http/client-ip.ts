import "server-only";
import { randomBytes } from "node:crypto";
import { subscribe } from "node:diagnostics_channel";
import type { IncomingMessage } from "node:http";
import { isIP, type Socket } from "node:net";
import { env } from "@/lib/env";
import { logger } from "@/lib/logging/logger";
import type { IpMode } from "@/types/env";

const MAX_ADDRESS_LENGTH = 64;
const UNRESOLVED_LOG_GAP_MS = 60_000;
const UNKNOWN_CLIENT = "unknown";
const PEER_HEADER = Symbol.for("llmhub.client-ip.peer-header");
const PEER_TRACKING = Symbol.for("llmhub.client-ip.peer-tracking");

const processGlobals = globalThis as unknown as Record<symbol, unknown>;

function canonicalIpv6(value: string): string | null {
  return URL.parse(`http://[${value}]`)?.hostname.slice(1, -1) ?? null;
}

function unmappedIpv4(canonical: string): string | null {
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(canonical);
  if (!mapped) return null;
  const high = Number.parseInt(mapped[1], 16);
  const low = Number.parseInt(mapped[2], 16);
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
}

function withoutPort(value: string): string {
  const bracketed = /^\[([^\]]+)\](?::\d{1,5})?$/.exec(value);
  if (bracketed) return bracketed[1];
  if (/^[\d.]+:\d{1,5}$/.test(value)) return value.slice(0, value.lastIndexOf(":"));
  return value;
}

export function normalizeIp(raw: string | null | undefined): string | null {
  const trimmed = raw?.trim() ?? "";
  if (!trimmed || trimmed.length > MAX_ADDRESS_LENGTH) return null;
  let value = withoutPort(trimmed);
  if (value.includes(":")) value = value.replace(/%[\w.~-]+$/, "");
  const family = isIP(value);
  if (family === 4) return value;
  if (family !== 6) return null;
  const canonical = canonicalIpv6(value);
  if (!canonical) return null;
  return unmappedIpv4(canonical) ?? canonical;
}

function lastForwardedHop(forwardedFor: string | null): string | null {
  if (!forwardedFor) return null;
  return normalizeIp(forwardedFor.slice(forwardedFor.lastIndexOf(",") + 1));
}

function isPseudoIpv4(ip: string): boolean {
  return isIP(ip) === 4 && Number(ip.split(".")[0]) >= 240;
}

function cloudflareClient(headers: Headers): string | null {
  const connecting = normalizeIp(headers.get("cf-connecting-ip"));
  if (connecting && isPseudoIpv4(connecting)) {
    return normalizeIp(headers.get("cf-connecting-ipv6")) ?? connecting;
  }
  return connecting;
}

export function peerAddressHeader(): string {
  const existing = processGlobals[PEER_HEADER];
  if (typeof existing === "string") return existing;
  const header = `x-llmhub-peer-${randomBytes(12).toString("hex")}`;
  processGlobals[PEER_HEADER] = header;
  return header;
}

export function trackSocketPeers(): void {
  if (processGlobals[PEER_TRACKING]) return;
  processGlobals[PEER_TRACKING] = true;
  const header = peerAddressHeader();
  subscribe("http.server.request.start", (message) => {
    const { request, socket } = message as { request?: IncomingMessage; socket?: Socket };
    if (!request) return;
    const peer = socket?.remoteAddress ?? request.socket?.remoteAddress;
    if (peer) request.headers[header] = peer;
    else delete request.headers[header];
  });
}

export function configureClientIp(mode: IpMode): void {
  if (mode === "direct") trackSocketPeers();
}

function resolveClientIp(headers: Headers, mode: IpMode): string | null {
  if (mode === "proxy") return lastForwardedHop(headers.get("x-forwarded-for"));
  if (mode === "cloudflare") return cloudflareClient(headers);
  return normalizeIp(headers.get(peerAddressHeader()));
}

let lastUnresolvedLog = 0;

function logUnresolved(mode: IpMode): void {
  const now = Date.now();
  if (now - lastUnresolvedLog < UNRESOLVED_LOG_GAP_MS) return;
  lastUnresolvedLog = now;
  logger.warn("client_ip.unresolved", { mode });
}

export function clientIp(headers: Headers, mode: IpMode = env.IP_MODE): string | null {
  const ip = resolveClientIp(headers, mode);
  if (!ip) logUnresolved(mode);
  return ip;
}

export function ipAllowed(allowed: readonly string[], ip: string | null): boolean {
  return ip !== null && allowed.some((entry) => normalizeIp(entry) === ip);
}

function ipv6Groups(canonical: string): string[] | null {
  const [head, tail] = canonical.split("::");
  const headGroups = head ? head.split(":") : [];
  if (tail === undefined) return headGroups.length === 8 ? headGroups : null;
  const tailGroups = tail ? tail.split(":") : [];
  const missing = 8 - headGroups.length - tailGroups.length;
  return missing >= 1 ? [...headGroups, ...Array<string>(missing).fill("0"), ...tailGroups] : null;
}

export function clientBucket(ip: string | null): string {
  if (!ip) return UNKNOWN_CLIENT;
  if (isIP(ip) !== 6) return ip;
  const groups = ipv6Groups(ip);
  return groups ? `${groups.slice(0, 4).join(":")}::/64` : ip;
}
