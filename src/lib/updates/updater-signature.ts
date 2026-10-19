import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const UPDATER_HEADER = "x-llmhub-updater";
export const UPDATER_CLOCK_SKEW_MS = 60_000;

export type SignedDirection = "request" | "response";

export type UpdaterSignatureCheck = "ok" | "missing" | "expired" | "invalid";

function signedMessage(direction: SignedDirection, timestamp: string, body: string): string {
  const bodyHash = createHash("sha256").update(body, "utf8").digest("hex");
  return direction === "request" ? `${timestamp}.${bodyHash}` : `response.${timestamp}.${bodyHash}`;
}

function mac(key: Buffer, direction: SignedDirection, timestamp: string, body: string): string {
  return createHmac("sha256", key).update(signedMessage(direction, timestamp, body), "utf8").digest("hex");
}

export function signUpdaterBody(
  key: Buffer,
  body: string,
  now: number,
  direction: SignedDirection = "request",
): string {
  const timestamp = String(Math.trunc(now));
  return `t=${timestamp},s=${mac(key, direction, timestamp, body)}`;
}

export function parseUpdaterHeader(header: string | null | undefined): { timestamp: string; signature: string } | null {
  if (!header || header.length > 200) return null;
  const fields = new Map(
    header.split(",").map((part) => {
      const index = part.indexOf("=");
      return [part.slice(0, index).trim(), part.slice(index + 1).trim()] as const;
    }),
  );
  const timestamp = fields.get("t");
  const signature = fields.get("s");
  if (!timestamp || !/^\d{1,16}$/.test(timestamp)) return null;
  if (!signature || !/^[0-9a-f]{64}$/.test(signature)) return null;
  return { timestamp, signature };
}

export function verifyUpdaterSignature(
  key: Buffer,
  header: string | null | undefined,
  body: string,
  now: number,
  direction: SignedDirection = "request",
): UpdaterSignatureCheck {
  if (!header) return "missing";
  const parsed = parseUpdaterHeader(header);
  if (!parsed) return "invalid";
  if (Math.abs(now - Number(parsed.timestamp)) > UPDATER_CLOCK_SKEW_MS) return "expired";
  const expected = Buffer.from(mac(key, direction, parsed.timestamp, body), "hex");
  const given = Buffer.from(parsed.signature, "hex");
  return given.length === expected.length && timingSafeEqual(given, expected) ? "ok" : "invalid";
}
