import { constants, createPublicKey, verify, type JsonWebKey } from "node:crypto";
import type { Jwk, JwksCache, JwtAlgorithm, JwtClaims, JwtConfig, VerificationKey } from "@/types/auth";

const JWKS_TTL_MS = 300_000;
const JWKS_REFETCH_MS = 30_000;

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

export const JWT_ALGORITHMS = Object.keys(ALGORITHMS);

let cache: JwksCache | null = null;

function b64urlToBuf(value: string): Buffer {
  return Buffer.from(value, "base64url");
}

function verificationKey(jwk: Jwk & JsonWebKey): VerificationKey[] {
  if (jwk.use && jwk.use !== "sig") return [];
  if (jwk.kty !== "RSA" && jwk.kty !== "EC" && jwk.kty !== "OKP") return [];
  try {
    return [
      {
        kid: jwk.kid ?? "",
        kty: jwk.kty,
        crv: jwk.crv ?? "",
        alg: jwk.alg ?? "",
        key: createPublicKey({ key: jwk, format: "jwk" }),
      },
    ];
  } catch {
    return [];
  }
}

async function loadKeys(url: string, force: boolean): Promise<VerificationKey[]> {
  const age = cache && cache.url === url ? Date.now() - cache.fetched : Infinity;
  if (cache && age < (force ? JWKS_REFETCH_MS : JWKS_TTL_MS)) return cache.keys;
  const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
  if (!res.ok) throw new Error(`jwks ${res.status}`);
  const json = (await res.json()) as { keys?: (Jwk & JsonWebKey)[] };
  const keys = (Array.isArray(json.keys) ? json.keys : []).flatMap(verificationKey);
  cache = { url, keys, fetched: Date.now() };
  return keys;
}

function fits(key: VerificationKey, alg: string, spec: JwtAlgorithm, kid: string): boolean {
  if (kid && key.kid !== kid) return false;
  if (key.kty !== spec.kty) return false;
  if (key.alg && key.alg !== alg) return false;
  return !spec.curves || spec.curves.includes(key.crv);
}

export function verifySignature(spec: JwtAlgorithm, key: VerificationKey, data: Buffer, signature: Buffer): boolean {
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

export async function verifyJwt(token: string, cfg: JwtConfig): Promise<JwtClaims> {
  if (!cfg.jwks_url) throw new Error("jwks_url missing");
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("invalid jwt");
  const header = JSON.parse(b64urlToBuf(parts[0]!).toString("utf8")) as { alg?: unknown; kid?: unknown };
  const alg = typeof header.alg === "string" ? header.alg : "";
  const spec = Object.hasOwn(ALGORITHMS, alg) ? ALGORITHMS[alg] : undefined;
  if (!spec) throw new Error("jwt alg");
  const kid = typeof header.kid === "string" ? header.kid : "";
  const keys = await candidates(cfg.jwks_url, alg, spec, kid);
  if (!keys.length) throw new Error("jwt kid unknown");
  const data = Buffer.from(`${parts[0]}.${parts[1]}`);
  const signature = b64urlToBuf(parts[2]!);
  if (!keys.some((key) => verifySignature(spec, key, data, signature))) throw new Error("jwt signature");
  const claims = JSON.parse(b64urlToBuf(parts[1]!).toString("utf8")) as JwtClaims;
  if (cfg.issuer && claims.iss !== cfg.issuer) throw new Error("jwt issuer mismatch");
  if (cfg.audience) {
    const aud = claimStrings(claims.aud);
    if (!aud.includes(cfg.audience)) throw new Error("jwt audience mismatch");
    if (aud.length > 1 && typeof claims.azp === "string" && claims.azp !== cfg.audience) {
      throw new Error("jwt azp mismatch");
    }
  }
  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== "number" || claims.exp < now) throw new Error("jwt expired");
  if (typeof claims.nbf === "number" && claims.nbf > now + 60) throw new Error("jwt nbf");
  return claims;
}
