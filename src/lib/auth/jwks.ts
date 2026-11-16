import { constants, createPublicKey, verify, type KeyObject } from "node:crypto";
import { asRecord, asString } from "@/lib/gateway/core";
import { parseJsonOrNull } from "@/lib/utils/json";
import { cancelQuietly } from "@/lib/utils/streams";
import type { JwkKeyType, JwksEntry, JwtAlgorithm, JwtClaims, JwtConfig, VerificationKey } from "@/types/auth";

const JWKS_TTL_MS = 300_000;
const JWKS_REFETCH_MS = 30_000;
const JWKS_TIMEOUT_MS = 8_000;
const JWKS_MAX_BYTES = 512 * 1024;
const JWKS_MAX_KEYS = 100;
const JWKS_CACHE_LIMIT = 16;
const JWT_MAX_LENGTH = 64 * 1024;
const CLOCK_SKEW_SECONDS = 60;
const MIN_RSA_BITS = 2048;
const BASE64URL = /^[A-Za-z0-9_-]*$/;

type PublicJwk = Extract<Parameters<typeof createPublicKey>[0], { format: "jwk" }>["key"];

const ALGORITHMS: Record<string, JwtAlgorithm> = {
  RS256: { kty: "RSA", hash: "sha256" },
  RS384: { kty: "RSA", hash: "sha384" },
  RS512: { kty: "RSA", hash: "sha512" },
  PS256: { kty: "RSA", hash: "sha256", saltLength: 32 },
  PS384: { kty: "RSA", hash: "sha384", saltLength: 48 },
  PS512: { kty: "RSA", hash: "sha512", saltLength: 64 },
  ES256: { kty: "EC", hash: "sha256", curves: ["P-256"] },
  ES384: { kty: "EC", hash: "sha384", curves: ["P-384"] },
  ES512: { kty: "EC", hash: "sha512", curves: ["P-521"] },
  EdDSA: { kty: "OKP", hash: null, curves: ["Ed25519", "Ed448"] },
};

const KEY_TYPES: Record<JwkKeyType, readonly string[]> = {
  RSA: ["rsa"],
  EC: ["ec"],
  OKP: ["ed25519", "ed448"],
};

export const JWT_ALGORITHMS = Object.keys(ALGORITHMS);

const cache = new Map<string, JwksEntry>();
const pending = new Map<string, Promise<VerificationKey[]>>();

export function resetJwksCache(): void {
  cache.clear();
  pending.clear();
}

function publicJwk(jwk: Record<string, unknown>): { kty: JwkKeyType; source: PublicJwk } | null {
  const field = (name: string) => asString(jwk[name]);
  const [kty, crv, x, y, n, e] = ["kty", "crv", "x", "y", "n", "e"].map(field);
  if (kty === "RSA" && n && e) return { kty, source: { kty, n, e } };
  if (kty === "EC" && crv && x && y) return { kty, source: { kty, crv, x, y } };
  if (kty === "OKP" && crv && x) return { kty, source: { kty, crv, x } };
  return null;
}

function signingKey(raw: unknown): VerificationKey[] {
  const jwk = asRecord(raw);
  if (!jwk) return [];
  const use = jwk.use;
  if (use !== undefined && use !== "sig") return [];
  const ops = jwk.key_ops;
  if (ops !== undefined && !(Array.isArray(ops) && ops.includes("verify"))) return [];
  const parsed = publicJwk(jwk);
  if (!parsed) return [];
  const { kty, source } = parsed;
  let key: KeyObject;
  try {
    key = createPublicKey({ key: source, format: "jwk" });
  } catch {
    return [];
  }
  if (!KEY_TYPES[kty].includes(key.asymmetricKeyType ?? "")) return [];
  if (kty === "RSA" && (key.asymmetricKeyDetails?.modulusLength ?? 0) < MIN_RSA_BITS) return [];
  return [{ kid: asString(jwk.kid), kty, crv: asString(source.crv), alg: asString(jwk.alg), key }];
}

async function readCapped(res: Response): Promise<string> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > JWKS_MAX_BYTES) {
    await cancelQuietly(res.body?.getReader());
    throw new Error("jwks too large");
  }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  let drained = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > JWKS_MAX_BYTES) throw new Error("jwks too large");
      text += decoder.decode(value, { stream: true });
    }
    drained = true;
    return text + decoder.decode();
  } finally {
    if (!drained) await cancelQuietly(reader);
  }
}

async function fetchKeys(url: string): Promise<VerificationKey[]> {
  const res = await fetch(url, {
    headers: { accept: "application/jwk-set+json, application/json" },
    signal: AbortSignal.timeout(JWKS_TIMEOUT_MS),
  });
  if (!res.ok) {
    await cancelQuietly(res.body?.getReader());
    throw new Error(`jwks ${res.status}`);
  }
  const keys = asRecord(parseJsonOrNull(await readCapped(res)))?.keys;
  if (!Array.isArray(keys)) throw new Error("jwks invalid");
  return keys.slice(0, JWKS_MAX_KEYS).flatMap(signingKey);
}

function remember(url: string, keys: VerificationKey[]): void {
  cache.delete(url);
  cache.set(url, { keys, fetched: Date.now() });
  while (cache.size > JWKS_CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

async function loadKeys(url: string, force: boolean): Promise<VerificationKey[]> {
  const entry = cache.get(url);
  const age = entry ? Date.now() - entry.fetched : Infinity;
  if (entry && age < (force ? JWKS_REFETCH_MS : JWKS_TTL_MS)) return entry.keys;
  const running = pending.get(url);
  if (running) return running;
  const load = fetchKeys(url)
    .then((keys) => {
      remember(url, keys);
      return keys;
    })
    .finally(() => pending.delete(url));
  pending.set(url, load);
  return load;
}

function fits(key: VerificationKey, alg: string, spec: JwtAlgorithm, kid: string): boolean {
  if (kid && key.kid !== kid) return false;
  if (key.kty !== spec.kty) return false;
  if (key.alg && key.alg !== alg) return false;
  return !spec.curves || spec.curves.includes(key.crv);
}

export function verifySignature(spec: JwtAlgorithm, key: VerificationKey, data: Buffer, signature: Buffer): boolean {
  try {
    if (spec.kty === "OKP") return verify(null, data, key.key, signature);
    if (spec.kty === "EC") return verify(spec.hash, data, { key: key.key, dsaEncoding: "ieee-p1363" }, signature);
    if (spec.saltLength) {
      return verify(
        spec.hash,
        data,
        { key: key.key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: spec.saltLength },
        signature,
      );
    }
    return verify(spec.hash, data, key.key, signature);
  } catch {
    return false;
  }
}

async function candidates(url: string, alg: string, spec: JwtAlgorithm, kid: string) {
  const matching = (await loadKeys(url, false)).filter((key) => fits(key, alg, spec, kid));
  if (matching.length) return matching;
  return (await loadKeys(url, true)).filter((key) => fits(key, alg, spec, kid));
}

function claimStrings(value: unknown): string[] {
  if (typeof value === "string" && value) return [value];
  if (Array.isArray(value)) return value.filter((x): x is string => typeof x === "string");
  return [];
}

function segment(value: string): Record<string, unknown> {
  const decoded = asRecord(parseJsonOrNull(Buffer.from(value, "base64url").toString("utf8")));
  if (!decoded) throw new Error("invalid jwt");
  return decoded;
}

function numericDate(claims: JwtClaims, name: string): number {
  const value = claims[name];
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`jwt ${name}`);
  return value;
}

function checkClaims(claims: JwtClaims, issuer: string, audience: string, now: number): void {
  if (claims.iss !== issuer) throw new Error("jwt issuer mismatch");
  const aud = claimStrings(claims.aud);
  if (!aud.includes(audience)) throw new Error("jwt audience mismatch");
  const azp = claims.azp;
  if (azp !== undefined && azp !== audience) throw new Error("jwt azp mismatch");
  if (aud.length > 1 && azp === undefined) throw new Error("jwt azp mismatch");
  if (numericDate(claims, "exp") <= now) throw new Error("jwt expired");
  if (claims.nbf !== undefined && numericDate(claims, "nbf") > now + CLOCK_SKEW_SECONDS) throw new Error("jwt nbf");
  if (numericDate(claims, "iat") > now + CLOCK_SKEW_SECONDS) throw new Error("jwt iat");
}

export async function verifyJwt(
  token: string,
  cfg: JwtConfig,
  now = Math.floor(Date.now() / 1000),
): Promise<JwtClaims> {
  if (!cfg.jwks_url) throw new Error("jwks_url missing");
  if (!cfg.issuer) throw new Error("jwt issuer missing");
  if (!cfg.audience) throw new Error("jwt audience missing");
  if (token.length > JWT_MAX_LENGTH) throw new Error("invalid jwt");
  const parts = token.split(".");
  if (parts.length !== 3 || !parts.every((part) => BASE64URL.test(part))) throw new Error("invalid jwt");
  const [encodedHeader, encodedClaims, encodedSignature] = parts as [string, string, string];
  if (!encodedHeader || !encodedClaims) throw new Error("invalid jwt");
  const header = segment(encodedHeader);
  const alg = asString(header.alg);
  const spec = Object.hasOwn(ALGORITHMS, alg) ? ALGORITHMS[alg] : undefined;
  if (!spec) throw new Error("jwt alg");
  if (Object.hasOwn(header, "crit")) throw new Error("jwt crit");
  if (header.kid !== undefined && typeof header.kid !== "string") throw new Error("invalid jwt");
  if (!encodedSignature) throw new Error("jwt signature");
  const kid = asString(header.kid);
  const keys = await candidates(cfg.jwks_url, alg, spec, kid);
  if (!keys.length) throw new Error("jwt kid unknown");
  const data = Buffer.from(`${encodedHeader}.${encodedClaims}`);
  const signature = Buffer.from(encodedSignature, "base64url");
  if (!keys.some((key) => verifySignature(spec, key, data, signature))) throw new Error("jwt signature");
  const claims = segment(encodedClaims);
  checkClaims(claims, cfg.issuer, cfg.audience, now);
  return claims;
}
