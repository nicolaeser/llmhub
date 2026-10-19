import type { SubAddLinkState, SubAddStatus } from "@/types/sub-add";

export function subAddStatus(link: SubAddLinkState, now = Date.now()): SubAddStatus {
  if (link.revokedAt) return "revoked";
  if (new Date(link.expiresAt).getTime() <= now) return "expired";
  if (link.maxAccounts !== null && link.added >= link.maxAccounts) return "used_up";
  return "active";
}

export function subAddRemaining(link: SubAddLinkState): number | null {
  return link.maxAccounts === null ? null : Math.max(0, link.maxAccounts - link.added);
}
