export const ANTHROPIC_VERSION_HEADER = "anthropic-version";
export const ANTHROPIC_VERSION_2023 = "2023-06-01";
export const ANTHROPIC_VERSION_2026 = "2026-10-21";

const VERSION_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function anthropicVersionOf(headers?: HeadersInit): string {
  if (!headers) return "";
  return new Headers(headers).get(ANTHROPIC_VERSION_HEADER)?.trim() ?? "";
}

export function strictAnthropicVersion(version: string | null): boolean {
  return version !== null && VERSION_DATE.test(version) && version >= ANTHROPIC_VERSION_2026;
}
