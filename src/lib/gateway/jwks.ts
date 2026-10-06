import { createVerify } from "node:crypto";
import type { Jwk, Cache, JwtClaims, JWTConfig } from "@/types/gateway";

let cache: Cache | null = null;

function b64urlToBuf(value: string): Buffer {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  return Buffer.from(padded, "base64");
}

function rsaPem(n: string, e: string): string {
  const modulus = b64urlToBuf(n);
  const exponent = b64urlToBuf(e);
  const der = encodeRsaPublic({ modulus, exponent });
  const b64 = der.toString("base64").match(/.{1,64}/g)?.join("\n") ?? "";
  return `-----BEGIN PUBLIC KEY-----\n${b64}\n-----END PUBLIC KEY-----`;
}

function encodeLen(len: number): Buffer {
  if (len < 128) return Buffer.from([len]);
  if (len < 256) return Buffer.from([0x81, len]);
  return Buffer.from([0x82, (len >> 8) & 0xff, len & 0xff]);
}

function encodeInt(buf: Buffer): Buffer {
  const body = buf[0]! & 0x80 ? Buffer.concat([Buffer.from([0]), buf]) : buf;
  return Buffer.concat([Buffer.from([0x02]), encodeLen(body.length), body]);
}

function encodeSeq(parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([0x30]), encodeLen(body.length), body]);
}

function encodeRsaPublic(input: { modulus: Buffer; exponent: Buffer }): Buffer {
  const n = encodeInt(input.modulus);
  const e = encodeInt(input.exponent);
  const rsa = encodeSeq([n, e]);
  const bitstring = Buffer.concat([
    Buffer.from([0x03]),
    encodeLen(rsa.length + 1),
    Buffer.from([0x00]),
    rsa,
  ]);
  const alg = Buffer.from("300d06092a864886f70d0101010500", "hex");
  return encodeSeq([alg, bitstring]);
}

async function loadKeys(url: string): Promise<Map<string, string>> {
  if (cache && cache.url === url && Date.now() - cache.fetched < 300_000) {
    return cache.keys;
  }
  const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
  if (!res.ok) throw new Error(`jwks ${res.status}`);
  const json = (await res.json()) as { keys?: Jwk[] };
  const keys = new Map<string, string>();
  for (const jwk of json.keys ?? []) {
    if (jwk.kty !== "RSA" || !jwk.n || !jwk.e) continue;
    keys.set(jwk.kid || "default", rsaPem(jwk.n, jwk.e));
  }
  cache = { url, keys, fetched: Date.now() };
  return keys;
}

function claimStrings(value: unknown): string[] {
  if (typeof value === "string" && value) return [value];
  if (Array.isArray(value)) return value.filter((x): x is string => typeof x === "string");
  return [];
}

export async function verifyJwt(token: string, cfg: JWTConfig): Promise<JwtClaims> {
  if (!cfg.jwks_url) throw new Error("jwks_url missing");
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("invalid jwt");
  const header = JSON.parse(b64urlToBuf(parts[0]!).toString("utf8")) as {
    alg?: string;
    kid?: string;
  };
  const alg = header.alg ?? "";
  if (!["RS256", "RS384", "RS512"].includes(alg)) throw new Error("jwt alg");
  const keys = await loadKeys(cfg.jwks_url);
  const pem = keys.get(header.kid || "") || keys.get("default") || [...keys.values()][0];
  if (!pem) throw new Error("jwt kid unknown");
  const verify = createVerify(alg.replace("RS", "RSA-SHA"));
  verify.update(`${parts[0]}.${parts[1]}`);
  if (!verify.verify(pem, b64urlToBuf(parts[2]!))) throw new Error("jwt signature");
  const claims = JSON.parse(b64urlToBuf(parts[1]!).toString("utf8")) as JwtClaims;
  if (cfg.issuer && claims.iss !== cfg.issuer) throw new Error("jwt issuer mismatch");
  if (cfg.audience) {
    const aud = claimStrings(claims.aud);
    if (!aud.includes(cfg.audience)) throw new Error("jwt audience mismatch");
  }
  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== "number" || claims.exp < now) throw new Error("jwt expired");
  if (typeof claims.nbf === "number" && claims.nbf > now + 60) throw new Error("jwt nbf");
  return claims;
}
