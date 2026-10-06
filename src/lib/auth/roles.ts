import "server-only";
import prisma from "@/lib/db/prisma";
import { AuthError, isPrismaCode, parseAuthInput } from "@/lib/auth/errors";
import { assertCanGrant, assertCanManage, canGrant, canManage } from "@/lib/auth/grants";
import {
  isRoleTemplateKey,
  permissionList,
  roleTemplateKeys,
  roleTemplates,
  sortPermissions,
} from "@/lib/auth/permissions";
import { writeAudit } from "@/lib/gateway/audit";
import { assistantToolList } from "@/lib/assistant/catalog";
import {
  idSchema,
  roleRevisionSchema,
  roleTemplateKeySchema,
  roleUpdateSchema,
  roleWriteSchema,
} from "@/schemas/auth";
import type { GrantActor, RoleOption, RoleSummary, RoleTemplateKey } from "@/types/auth";

const templateOrder = (key: string | null) => {
  const index = roleTemplateKeys.indexOf(key as RoleTemplateKey);
  return index === -1 ? roleTemplateKeys.length : index;
};

async function findRole(roleId: unknown) {
  const id = parseAuthInput(idSchema, roleId);
  const role = await prisma.role.findUnique({ where: { id } });
  if (!role) throw new AuthError("ROLE_NOT_FOUND");
  return role;
}

export async function listRoles(actor: GrantActor): Promise<RoleSummary[]> {
  const rows = await prisma.role.findMany({
    orderBy: { createdAt: "asc" },
    include: { _count: { select: { users: true } } },
  });
  return rows
    .sort((a, b) => templateOrder(a.templateKey) - templateOrder(b.templateKey))
    .map((role) => {
      const granted = permissionList(role.permissions);
      return {
        id: role.id,
        templateKey: isRoleTemplateKey(role.templateKey) ? role.templateKey : null,
        name: role.name,
        description: role.description,
        permissions: granted,
        assistantToolsDisabled: assistantToolList(role.assistantToolsDisabled),
        memberCount: role._count.users,
        revision: role.revision,
        editable: canManage(actor, granted),
      };
    });
}

export async function roleOptions(actor: GrantActor): Promise<RoleOption[]> {
  const rows = await prisma.role.findMany({ orderBy: { createdAt: "asc" } });
  return rows
    .sort((a, b) => templateOrder(a.templateKey) - templateOrder(b.templateKey))
    .map((role) => ({
      id: role.id,
      templateKey: isRoleTemplateKey(role.templateKey) ? role.templateKey : null,
      name: role.name,
      assignable: canGrant(actor, permissionList(role.permissions)),
    }));
}

export async function createRole(actor: GrantActor, actorUserId: string, raw: unknown) {
  const input = parseAuthInput(roleWriteSchema, raw);
  if (!input.name) throw new AuthError("NAME_REQUIRED");
  const granted = sortPermissions(input.permissions);
  const toolsOff = assistantToolList(input.assistantToolsDisabled);
  assertCanGrant(actor, granted);
  try {
    const role = await prisma.role.create({
      data: {
        name: input.name,
        description: input.description || null,
        permissions: granted,
        assistantToolsDisabled: toolsOff,
      },
      select: { id: true },
    });
    await writeAudit({
      actor: actorUserId,
      action: "role.create",
      objectType: "role",
      objectId: role.id,
      after: { name: input.name, permissions: granted, assistantToolsDisabled: toolsOff },
    });
    return role;
  } catch (error) {
    if (isPrismaCode(error, "P2002")) throw new AuthError("ROLE_EXISTS");
    throw error;
  }
}

export async function updateRole(
  actor: GrantActor,
  actorUserId: string,
  roleId: unknown,
  raw: unknown,
) {
  const input = parseAuthInput(roleUpdateSchema, raw);
  const role = await findRole(roleId);
  assertCanManage(actor, permissionList(role.permissions), "ROLE_PROTECTED");
  if (!role.templateKey && !input.name) throw new AuthError("NAME_REQUIRED");
  const granted = sortPermissions(input.permissions);
  const toolsOff = assistantToolList(input.assistantToolsDisabled);
  assertCanGrant(actor, granted);
  let count: number;
  try {
    ({ count } = await prisma.role.updateMany({
      where: { id: role.id, revision: input.revision },
      data: {
        name: input.name,
        description: input.description || null,
        permissions: granted,
        assistantToolsDisabled: toolsOff,
        revision: { increment: 1 },
      },
    }));
  } catch (error) {
    if (isPrismaCode(error, "P2002")) throw new AuthError("ROLE_EXISTS");
    throw error;
  }
  if (!count) throw new AuthError("ROLE_CHANGED");
  await writeAudit({
    actor: actorUserId,
    action: "role.update",
    objectType: "role",
    objectId: role.id,
    before: {
      name: role.name,
      permissions: permissionList(role.permissions),
      assistantToolsDisabled: assistantToolList(role.assistantToolsDisabled),
    },
    after: { name: input.name, permissions: granted, assistantToolsDisabled: toolsOff },
  });
  return { id: role.id };
}

export async function deleteRole(actor: GrantActor, actorUserId: string, roleId: unknown) {
  const role = await findRole(roleId);
  assertCanManage(actor, permissionList(role.permissions), "ROLE_PROTECTED");
  let count: number;
  try {
    ({ count } = await prisma.role.deleteMany({
      where: { id: role.id, users: { none: {} } },
    }));
  } catch (error) {
    if (isPrismaCode(error, "P2003")) throw new AuthError("ROLE_IN_USE");
    throw error;
  }
  if (!count) {
    const still = await prisma.role.findUnique({ where: { id: role.id }, select: { id: true } });
    throw new AuthError(still ? "ROLE_IN_USE" : "ROLE_NOT_FOUND");
  }
  await writeAudit({
    actor: actorUserId,
    action: "role.delete",
    objectType: "role",
    objectId: role.id,
    before: { name: role.name, templateKey: role.templateKey },
  });
  return { deleted: true as const };
}

export async function resetRoleToTemplate(
  actor: GrantActor,
  actorUserId: string,
  roleId: unknown,
  revision: unknown,
) {
  const expected = parseAuthInput(roleRevisionSchema, revision);
  const role = await findRole(roleId);
  if (!isRoleTemplateKey(role.templateKey)) throw new AuthError("ROLE_NOT_TEMPLATE");
  const granted = [...roleTemplates[role.templateKey]];
  assertCanManage(actor, permissionList(role.permissions), "ROLE_PROTECTED");
  assertCanGrant(actor, granted);
  const { count } = await prisma.role.updateMany({
    where: { id: role.id, revision: expected },
    data: {
      name: null,
      description: null,
      permissions: granted,
      assistantToolsDisabled: [],
      revision: { increment: 1 },
    },
  });
  if (!count) throw new AuthError("ROLE_CHANGED");
  await writeAudit({
    actor: actorUserId,
    action: "role.reset",
    objectType: "role",
    objectId: role.id,
    after: { templateKey: role.templateKey, permissions: granted },
  });
  return { id: role.id };
}

export async function restoreRoleTemplate(actor: GrantActor, actorUserId: string, key: unknown) {
  const templateKey = parseAuthInput(roleTemplateKeySchema, key);
  const granted = [...roleTemplates[templateKey]];
  assertCanGrant(actor, granted);
  try {
    const role = await prisma.role.create({
      data: { templateKey, permissions: granted },
      select: { id: true },
    });
    await writeAudit({
      actor: actorUserId,
      action: "role.create",
      objectType: "role",
      objectId: role.id,
      after: { templateKey, permissions: granted },
    });
    return role;
  } catch (error) {
    if (isPrismaCode(error, "P2002")) throw new AuthError("ROLE_EXISTS");
    throw error;
  }
}

export async function templateRoleId(key: RoleTemplateKey): Promise<string | null> {
  const role = await prisma.role.findUnique({ where: { templateKey: key }, select: { id: true } });
  return role?.id ?? null;
}
