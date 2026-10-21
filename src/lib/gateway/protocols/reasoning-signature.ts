const CODEX_SIGNATURE_PREFIX = "gAAAA";
const MUSE_SIGNATURE_PREFIX = "Q-PaDg";
export const DEVIN_SIGNATURE_PREFIX = "devin.v1:";

export function isCodexSignature(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(CODEX_SIGNATURE_PREFIX);
}

export function isMuseSignature(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(MUSE_SIGNATURE_PREFIX);
}

export function isResponsesSignature(value: unknown): value is string {
  return isCodexSignature(value) || isMuseSignature(value);
}

export function isDevinSignature(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(DEVIN_SIGNATURE_PREFIX);
}
