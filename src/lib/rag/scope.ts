import { GateError } from "@/lib/gateway/errors";
import type { Prisma } from "@/generated/prisma/client";
import type { Principal } from "@/types/gateway";
import type { VectorScope, VectorStoreOwner } from "@/types/rag";

export function storeOwner(principal: Principal): VectorStoreOwner {
  const orgId = principal.orgId || null;
  const projectId = principal.key?.project_id || "";
  if (projectId) return { orgId, projectId, memberId: null, userId: null };
  const memberId = principal.key?.member_id || principal.memberId || "";
  if (memberId) return { orgId, projectId: null, memberId, userId: null };
  if (principal.userId) return { orgId, projectId: null, memberId: null, userId: principal.userId };
  throw new GateError(403, "permission_denied", "this key has no project, person, or owner that can hold vector stores");
}

export function ownedStores(principal: Principal): Prisma.VectorStoreWhereInput {
  const owner = storeOwner(principal);
  if (owner.projectId) return { orgId: owner.orgId, projectId: owner.projectId };
  if (owner.memberId) return { orgId: owner.orgId, memberId: owner.memberId };
  return { orgId: owner.orgId, userId: owner.userId, projectId: null, memberId: null };
}

export function companyStores(orgId: string): Prisma.VectorStoreWhereInput {
  return { orgId, projectId: null, memberId: null, userId: null };
}

export function readableStores(principal: Principal): Prisma.VectorStoreWhereInput {
  const own = ownedStores(principal);
  return principal.orgId ? { OR: [own, companyStores(principal.orgId)] } : own;
}

export function scopeOf(row: VectorStoreOwner): VectorScope {
  if (row.projectId) return "project";
  if (row.memberId) return "member";
  if (row.userId) return "user";
  return "organization";
}

export function ownsStore(principal: Principal, row: VectorStoreOwner): boolean {
  const owner = storeOwner(principal);
  if ((row.orgId ?? null) !== owner.orgId) return false;
  if (owner.projectId) return row.projectId === owner.projectId;
  if (owner.memberId) return row.memberId === owner.memberId;
  return row.userId === owner.userId && !row.projectId && !row.memberId;
}

export function readsStore(principal: Principal, row: VectorStoreOwner): boolean {
  if (ownsStore(principal, row)) return true;
  return Boolean(principal.orgId) && row.orgId === principal.orgId && scopeOf(row) === "organization";
}
