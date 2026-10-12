export const API_ROUTE_PREFIX = "api/";

export const RESERVED_ALIASES: ReadonlySet<string> = new Set(["auto"]);

export function isReservedAlias(alias: string): boolean {
  return RESERVED_ALIASES.has(alias) || alias.startsWith(API_ROUTE_PREFIX);
}

export function plainModel(model: string): string {
  const trimmed = model.trim();
  const lower = trimmed.toLowerCase();
  return lower.startsWith(API_ROUTE_PREFIX) && lower.length > API_ROUTE_PREFIX.length
    ? trimmed.slice(API_ROUTE_PREFIX.length).trim()
    : trimmed;
}

export function modelAlias(value: string): string {
  return value.trim().toLowerCase();
}
