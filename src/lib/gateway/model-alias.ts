export const RESERVED_ALIASES: ReadonlySet<string> = new Set(["auto"]);

export function modelAlias(value: string): string {
  return value.trim().toLowerCase();
}
