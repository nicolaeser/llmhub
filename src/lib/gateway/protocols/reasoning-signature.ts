const CODEX_SIGNATURE_PREFIX = "gAAAA";
export const DEVIN_SIGNATURE_PREFIX = "devin.v1:";

export function isCodexSignature(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(CODEX_SIGNATURE_PREFIX);
}

export function isDevinSignature(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(DEVIN_SIGNATURE_PREFIX);
}
