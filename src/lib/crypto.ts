import "server-only";
import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes } from "node:crypto";
import { env } from "@/lib/env";
import type { DigestPurpose } from "@/types/auth";

const SEALED_PREFIX = "enc1:";

const subkey = (purpose: "data" | "signing") =>
  Buffer.from(hkdfSync("sha256", env.APP_SECRET, "llmhub", purpose, 32));

const dataKey = () => subkey("data");

export const signingSecret = () => subkey("signing").toString("hex");

export const digest = (value: string) => createHash("sha256").update(value).digest("hex");

export const randomToken = () => randomBytes(32).toString("hex");

export function keyedDigest(purpose: DigestPurpose, value: string): string {
  return createHmac("sha256", dataKey()).update(`${purpose}:${value}`).digest("hex");
}

export function seal(plain: string): string {
  if (!plain || plain.startsWith(SEALED_PREFIX)) return plain;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", dataKey(), iv);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return SEALED_PREFIX + Buffer.concat([iv, body, cipher.getAuthTag()]).toString("base64");
}

export function open(value: string): string {
  if (!value.startsWith(SEALED_PREFIX)) return value;
  const raw = Buffer.from(value.slice(SEALED_PREFIX.length), "base64");
  if (raw.length < 29) return "";
  try {
    const decipher = createDecipheriv("aes-256-gcm", dataKey(), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(raw.length - 16));
    return Buffer.concat([decipher.update(raw.subarray(12, raw.length - 16)), decipher.final()]).toString("utf8");
  } catch {
    return "";
  }
}
