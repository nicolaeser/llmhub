import "server-only";
import { randomBytes } from "node:crypto";
import { keyedDigest } from "@/lib/crypto";

export const RECOVERY_CODE_COUNT = 10;

export function normalizeRecoveryCode(input: string): string | null {
  const compact = input.toLowerCase().replace(/[\s-]/g, "");
  if (!/^[0-9a-f]{16}$/.test(compact)) return null;
  return `${compact.slice(0, 8)}-${compact.slice(8)}`;
}

export function recoveryCodeHash(normalized: string): string {
  return keyedDigest("recovery-code", normalized);
}


export function newRecoveryCodes(): { codes: string[]; hashes: string[] } {
  const codes = new Set<string>();
  while (codes.size < RECOVERY_CODE_COUNT) {
    codes.add(`${randomBytes(4).toString("hex")}-${randomBytes(4).toString("hex")}`);
  }
  const list = [...codes];
  return { codes: list, hashes: list.map(recoveryCodeHash) };
}
