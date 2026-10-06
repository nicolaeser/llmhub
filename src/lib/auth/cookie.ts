import "server-only";
import { signingSecret } from "@/lib/crypto";

const encoder = new TextEncoder();
const TOKEN_PATTERN = /^[0-9a-f]{64}$/;
const SIGNATURE_PATTERN = /^[0-9a-f]{64}$/;
const keyCache = new Map<string, Promise<CryptoKey>>();
const isProduction = process.env.NODE_ENV === "production";

export const SESSION_COOKIE = isProduction ? "__Host-llmhub-session" : "llmhub_session";
export const CHALLENGE_COOKIE = isProduction ? "__Host-llmhub-challenge" : "llmhub_challenge";
export const PASSKEY_COOKIE = isProduction ? "__Host-llmhub-passkey" : "llmhub_passkey";

export const SESSION_IDLE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const SESSION_ABSOLUTE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function importKey(secret: string): Promise<CryptoKey> {
  let cached = keyCache.get(secret);
  if (!cached) {
    cached = crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    keyCache.set(secret, cached);
  }
  return cached;
}

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function sign(secret: string, token: string): Promise<string> {
  const signature = await crypto.subtle.sign(
    "HMAC",
    await importKey(secret),
    encoder.encode(`session:${token}`),
  );
  return toHex(new Uint8Array(signature));
}

export async function signSessionToken(token: string): Promise<string> {
  return `${token}.${await sign(signingSecret(), token)}`;
}

export async function verifySessionCookie(value: string): Promise<string | null> {
  const [token, signature, extra] = value.split(".");
  if (extra !== undefined || !token || !signature) return null;
  if (!TOKEN_PATTERN.test(token) || !SIGNATURE_PATTERN.test(signature)) return null;
  return constantTimeEqual(signature, await sign(signingSecret(), token)) ? token : null;
}

export function sessionCookieOptions(expires: Date) {
  return {
    name: SESSION_COOKIE,
    expires,
    path: "/",
    httpOnly: true,
    secure: isProduction,
    sameSite: "lax" as const,
  };
}

export function clearedSessionCookieOptions() {
  return {
    name: SESSION_COOKIE,
    maxAge: 0,
    path: "/",
    httpOnly: true,
    secure: isProduction,
    sameSite: "lax" as const,
  };
}

export function ceremonyCookieOptions(name: string, expires: Date) {
  return {
    name,
    expires,
    path: "/",
    httpOnly: true,
    secure: isProduction,
    sameSite: "strict" as const,
  };
}
