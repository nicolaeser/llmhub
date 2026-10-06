import "server-only";
import type { S3Addressing } from "@/types/gateway";
import type { AddressingStyle, S3Location } from "@/types/s3";

const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/;

export function trimSlashes(value: string): string {
  return value.replace(/^\/+|\/+$/g, "");
}

export function joinKey(...parts: string[]): string {
  const segments: string[] = [];
  for (const part of parts) {
    if (!part) continue;
    for (const piece of part.split("/")) {
      const trimmed = piece.trim();
      if (!trimmed || trimmed === ".") continue;
      if (trimmed === "..") {
        segments.pop();
        continue;
      }
      segments.push(trimmed);
    }
  }
  return segments.join("/");
}

function encodeObjectKey(key: string): string {
  return joinKey(key)
    .split("/")
    .map((segment) => encodeURIComponent(segment).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`))
    .join("/");
}

export function originOf(url: string, fallback = "https://s3.amazonaws.com"): string {
  const raw = url.trim();
  if (!raw) return fallback;
  try {
    const parsed = new URL(raw.includes("://") ? raw : `https://${raw}`);
    return parsed.origin;
  } catch {
    return fallback;
  }
}

export function defaultAwsEndpoint(region: string): string {
  const regionName = region.trim() || "us-east-1";
  if (regionName === "us-east-1") return "https://s3.amazonaws.com";
  return `https://s3.${regionName}.amazonaws.com`;
}

function isAwsHost(host: string): boolean {
  return host === "s3.amazonaws.com" || host.endsWith(".amazonaws.com");
}

export function resolveAddressing(input: {
  addressing?: S3Addressing | string;
  forcePathStyle?: boolean;
  domainBucket?: boolean;
  bucket: string;
  endpoint: string;
}): AddressingStyle {
  if (input.forcePathStyle) return "path";
  if (input.domainBucket) return "virtual-hosted";
  const mode = (input.addressing || "auto").toLowerCase();
  if (mode === "path") return "path";
  if (mode === "virtual-hosted" || mode === "virtual_hosted" || mode === "vhost") {
    return "virtual-hosted";
  }
  let host: string;
  try {
    host = new URL(originOf(input.endpoint)).hostname;
  } catch {
    host = "";
  }
  if (IPV4.test(host) || host.includes(":")) return "path";
  if (input.bucket.includes(".") && originOf(input.endpoint).startsWith("https:")) {
    return "path";
  }
  if (host && !isAwsHost(host)) return "path";
  return "virtual-hosted";
}


export function objectUrl(location: S3Location, key: string): URL {
  const fullKey = joinKey(location.prefix, key);
  const encoded = encodeObjectKey(fullKey);
  if (location.domainBucket) {
    const base = location.publicBaseUrl || location.endpoint;
    const url = new URL(originOf(base));
    const extra = publicPath(location.publicBaseUrl);
    url.pathname = `/${joinKey(extra, encoded)}`;
    return url;
  }
  const endpoint = originOf(location.endpoint, defaultAwsEndpoint(location.region));
  if (location.addressing === "path") {
    const url = new URL(endpoint);
    url.pathname = `/${encodeURIComponent(location.bucket)}/${encoded}`;
    return url;
  }
  const root = new URL(endpoint);
  const url = new URL(endpoint);
  if (!root.hostname.startsWith(`${location.bucket}.`)) {
    url.hostname = `${location.bucket}.${root.hostname}`;
  }
  url.pathname = `/${encoded}`;
  return url;
}

export function publicObjectUrl(location: S3Location, key: string): string {
  const fullKey = joinKey(location.prefix, key);
  if (location.publicBaseUrl) {
    const base = location.publicBaseUrl.endsWith("/")
      ? location.publicBaseUrl
      : `${location.publicBaseUrl}/`;
    return new URL(encodeObjectKey(fullKey), base).toString();
  }
  return objectUrl(location, key).toString();
}

function publicPath(publicBaseUrl: string): string {
  if (!publicBaseUrl) return "";
  try {
    return trimSlashes(new URL(publicBaseUrl).pathname);
  } catch {
    return "";
  }
}
