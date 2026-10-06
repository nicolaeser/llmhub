import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { signingSecret } from "@/lib/crypto";

const TRY_BEARER_PREFIX = "sk-hub-try.";
export const TRY_BEARER_TTL_SEC = 90;

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret)
    .update(`try-bearer:${payload}`)
    .digest("base64url");
}

export function isTryBearer(token: string): boolean {
  return token.startsWith(TRY_BEARER_PREFIX);
}

export function mintTryBearer(
  userId: string,
  nowSec = Math.floor(Date.now() / 1000),
): string {
  const payload = `${userId}.${nowSec + TRY_BEARER_TTL_SEC}`;
  return `${TRY_BEARER_PREFIX}${payload}.${sign(payload, signingSecret())}`;
}

export function verifyTryBearer(
  token: string,
  nowSec = Math.floor(Date.now() / 1000),
): { userId: string } | null {
  if (!isTryBearer(token)) return null;
  const rest = token.slice(TRY_BEARER_PREFIX.length);
  const lastDot = rest.lastIndexOf(".");
  if (lastDot <= 0) return null;
  const payload = rest.slice(0, lastDot);
  const sig = rest.slice(lastDot + 1);
  const sep = payload.lastIndexOf(".");
  if (sep <= 0) return null;
  const userId = payload.slice(0, sep);
  const exp = Number(payload.slice(sep + 1));
  if (!userId || !Number.isFinite(exp) || exp < nowSec) return null;
  const actual = Buffer.from(sig);
  const expected = Buffer.from(sign(payload, signingSecret()));
  return expected.length === actual.length && timingSafeEqual(expected, actual)
    ? { userId }
    : null;
}
