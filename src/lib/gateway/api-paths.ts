export const API_PREFIX = "/api";
export const SUBSCRIPTION_PREFIX = `${API_PREFIX}/subscription`;
export const MANAGEMENT_PREFIX = `${API_PREFIX}/mgmt`;

const GATEWAY_ROOTS = [SUBSCRIPTION_PREFIX, "/subscription", API_PREFIX] as const;

export function gatewayPath(pathname: string): string {
  const root = GATEWAY_ROOTS.find((prefix) => pathname.startsWith(`${prefix}/v1/`));
  return root ? pathname.slice(root.length) : pathname;
}
