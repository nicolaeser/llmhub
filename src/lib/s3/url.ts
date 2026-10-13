import "server-only";
import type { S3AddressingSetting, S3AddressingStyle, S3Location } from "@/types/s3";

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
  addressing: S3AddressingSetting;
  bucket: string;
  endpoint: string;
}): S3AddressingStyle {
  if (input.addressing !== "auto") return input.addressing;
  const endpoint = originOf(input.endpoint);
  const host = new URL(endpoint).hostname;
  if (IPV4.test(host) || host.includes(":")) return "path";
  if (input.bucket.includes(".") && endpoint.startsWith("https:")) return "path";
  if (!isAwsHost(host)) return "path";
  return "virtual-hosted";
}

export function objectUrl(location: S3Location, key: string): URL {
  const encoded = encodeObjectKey(joinKey(location.prefix, key));
  const url = new URL(originOf(location.endpoint, defaultAwsEndpoint(location.region)));
  if (location.addressing === "path") {
    url.pathname = `/${encodeURIComponent(location.bucket)}/${encoded}`;
    return url;
  }
  if (location.addressing === "virtual-hosted" && !url.hostname.startsWith(`${location.bucket}.`)) {
    url.hostname = `${location.bucket}.${url.hostname}`;
  }
  url.pathname = `/${encoded}`;
  return url;
}

export function publicObjectUrl(location: S3Location, key: string): string {
  if (!location.publicBaseUrl) return objectUrl(location, key).toString();
  const base = location.publicBaseUrl.endsWith("/") ? location.publicBaseUrl : `${location.publicBaseUrl}/`;
  return new URL(encodeObjectKey(joinKey(location.prefix, key)), base).toString();
}
