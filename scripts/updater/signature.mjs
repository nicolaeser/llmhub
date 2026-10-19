import { Buffer } from "node:buffer";
import { createHash, createHmac, hkdfSync, timingSafeEqual } from "node:crypto";

export const UPDATER_HEADER = "x-llmhub-updater";
export const CLOCK_SKEW_MS = 60_000;

export function updaterKey(secret) {
  return Buffer.from(hkdfSync("sha256", secret, "llmhub", "updater", 32));
}

function signedMessage(direction, timestamp, body) {
  const bodyHash = createHash("sha256").update(body, "utf8").digest("hex");
  return direction === "request" ? `${timestamp}.${bodyHash}` : `response.${timestamp}.${bodyHash}`;
}

function mac(key, direction, timestamp, body) {
  return createHmac("sha256", key).update(signedMessage(direction, timestamp, body), "utf8").digest("hex");
}

export function signBody(key, body, now, direction = "request") {
  const timestamp = String(Math.trunc(now));
  return `t=${timestamp},s=${mac(key, direction, timestamp, body)}`;
}

export function verifySignature(key, header, body, now, direction = "request") {
  if (!header) return "missing";
  const fields = new Map(
    String(header)
      .split(",")
      .map((part) => {
        const index = part.indexOf("=");
        return [part.slice(0, index).trim(), part.slice(index + 1).trim()];
      }),
  );
  const timestamp = fields.get("t") ?? "";
  const signature = fields.get("s") ?? "";
  if (!/^\d{1,16}$/.test(timestamp) || !/^[0-9a-f]{64}$/.test(signature)) return "invalid";
  if (Math.abs(now - Number(timestamp)) > CLOCK_SKEW_MS) return "expired";
  const expected = Buffer.from(mac(key, direction, timestamp, body), "hex");
  const given = Buffer.from(signature, "hex");
  return given.length === expected.length && timingSafeEqual(given, expected) ? "ok" : "invalid";
}
