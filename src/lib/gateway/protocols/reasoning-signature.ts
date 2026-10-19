const CODEX_SIGNATURE_PREFIX = "gAAAA";

export function isCodexSignature(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(CODEX_SIGNATURE_PREFIX);
}
