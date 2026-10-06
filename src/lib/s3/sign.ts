import "server-only";

import { createHash, createHmac } from "node:crypto";
import type { SignInput } from "@/types/s3";

function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac("sha256", key).update(value, "utf8").digest();
}

export function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function amzDate(date: Date): { amz: string; day: string } {
  const iso = date.toISOString().replace(/[:-]|\.\d{3}/g, "");
  return { amz: iso.slice(0, 15) + "Z", day: iso.slice(0, 8) };
}

function normalizeHeaders(
  headers: Record<string, string>,
): { canonical: string; signed: string; map: Record<string, string> } {
  const map: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    map[key.toLowerCase()] = value.trim().replace(/\s+/g, " ");
  }
  const names = Object.keys(map).sort();
  const canonical = names.map((name) => `${name}:${map[name]}\n`).join("");
  return { canonical, signed: names.join(";"), map };
}

function signingKey(
  secret: string,
  day: string,
  region: string,
  service: string,
): Buffer {
  const kDate = hmac(`AWS4${secret}`, day);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, "aws4_request");
}

function canonicalQuery(url: URL): string {
  const params = [...url.searchParams.entries()].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return params
    .map(
      ([k, v]) =>
        `${encodeURIComponent(k)}=${encodeURIComponent(v).replace(/%20/g, "%20")}`,
    )
    .join("&");
}

function canonicalRequest(input: {
  method: string;
  url: URL;
  headers: Record<string, string>;
  bodySha256: string;
}): { canonical: string; signedHeaders: string } {
  const { canonical: headerBlock, signed } = normalizeHeaders(input.headers);
  const uri = input.url.pathname || "/";
  const query = canonicalQuery(input.url);
  const canonical = [
    input.method.toUpperCase(),
    uri,
    query,
    headerBlock,
    signed,
    input.bodySha256,
  ].join("\n");
  return { canonical, signedHeaders: signed };
}

export function authorizationHeader(input: SignInput): {
  authorization: string;
  amzDate: string;
  headers: Record<string, string>;
} {
  const now = input.now ?? new Date();
  const { amz, day } = amzDate(now);
  const service = input.service ?? "s3";
  const payloadHash = input.bodySha256 ?? sha256Hex("");
  const headers: Record<string, string> = {
    host: input.url.host,
    "x-amz-date": amz,
    "x-amz-content-sha256": payloadHash,
    ...(input.headers ?? {}),
  };
  if (input.sessionToken) headers["x-amz-security-token"] = input.sessionToken;
  const { canonical, signedHeaders } = canonicalRequest({
    method: input.method,
    url: input.url,
    headers,
    bodySha256: payloadHash,
  });
  const scope = `${day}/${input.region}/${service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amz,
    scope,
    sha256Hex(canonical),
  ].join("\n");
  const signature = createHmac(
    "sha256",
    signingKey(input.secretAccessKey, day, input.region, service),
  )
    .update(stringToSign)
    .digest("hex");
  const authorization = `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { authorization, amzDate: amz, headers };
}
