export const API_ROUTE_PREFIX = "api/";
export const ANTHROPIC_ROUTE_PREFIX = "anthropic/";

export const RESERVED_ALIASES: ReadonlySet<string> = new Set(["auto"]);

export function isReservedAlias(alias: string): boolean {
  return (
    RESERVED_ALIASES.has(alias) ||
    alias.startsWith(API_ROUTE_PREFIX) ||
    alias.startsWith(ANTHROPIC_ROUTE_PREFIX)
  );
}

export function plainModel(model: string): string {
  let plain = model.trim();
  let lower = plain.toLowerCase();
  while (
    (lower.startsWith(ANTHROPIC_ROUTE_PREFIX) && lower.length > ANTHROPIC_ROUTE_PREFIX.length) ||
    (lower.startsWith(API_ROUTE_PREFIX) && lower.length > API_ROUTE_PREFIX.length)
  ) {
    const prefix = lower.startsWith(ANTHROPIC_ROUTE_PREFIX) ? ANTHROPIC_ROUTE_PREFIX : API_ROUTE_PREFIX;
    plain = plain.slice(prefix.length).trim();
    lower = plain.toLowerCase();
  }
  return plain;
}

export function modelAlias(value: string): string {
  return value.trim().toLowerCase();
}
