const CODEX_SIGNATURE_PREFIX = "gAAAA";
const MUSE_SIGNATURE_PREFIX = "Q-PaDg";

export function isCodexSignature(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(CODEX_SIGNATURE_PREFIX);
}

export function isMuseSignature(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(MUSE_SIGNATURE_PREFIX);
}

export function isResponsesSignature(value: unknown): value is string {
  return isCodexSignature(value) || isMuseSignature(value);
}
