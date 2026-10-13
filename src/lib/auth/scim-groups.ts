import "server-only";
import prisma from "@/lib/db/prisma";
import { writeAudit } from "@/lib/audit";
import { isPrismaCode } from "@/lib/auth/errors";
import { syncScimRoles } from "@/lib/auth/directory-roles";
import { parseScimFilter, scimFailure, scimMeta } from "@/lib/auth/scim";
import { asRecord } from "@/lib/gateway/core";
import { scimGroupResourceSchema, scimMembersSchema, scimPatchSchema, scimUserNameSchema } from "@/schemas/scim";
import type { Prisma } from "@/generated/prisma/client";
import type { ScimGroup, ScimGroupInput, ScimGroupOperation, ScimPage } from "@/types/scim";

export const SCIM_GROUP_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:Group";
const SCIM_GROUP_PATH_PREFIX = `${SCIM_GROUP_SCHEMA}:`.toLowerCase();
const SCIM_ACTOR = "scim";
const GROUP_FILTERS = ["displayName", "externalId", "id"] as const;

const groupInclude = {
  members: { select: { user: { select: { id: true, email: true } } }, orderBy: { createdAt: "asc" } },
} as const satisfies Prisma.ScimGroupInclude;

type GroupRow = Prisma.ScimGroupGetPayload<{ include: typeof groupInclude }>;
type GroupRecord = Omit<GroupRow, "members"> & { members?: GroupRow["members"] };

export function toScimGroup(group: GroupRecord): ScimGroup {
  return {
    schemas: [SCIM_GROUP_SCHEMA],
    id: group.id,
    displayName: group.displayName,
    ...(group.externalId ? { externalId: group.externalId } : {}),
    ...(group.members
      ? { members: group.members.map(({ user }) => ({ value: user.id, display: user.email, type: "User" as const })) }
      : {}),
    meta: scimMeta("Group", group),
  };
}

export function parseScimGroupBody(raw: unknown): ScimGroupInput {
  if (!asRecord(raw)) throw scimFailure(400, "request body must be a SCIM Group resource", "invalidSyntax");
  const parsed = scimGroupResourceSchema.safeParse(raw);
  if (!parsed.success) throw scimFailure(400, "invalid SCIM Group resource", "invalidValue");
  return {
    displayName: parsed.data.displayName,
    externalId: parsed.data.externalId || null,
    members: parsed.data.members ?? [],
  };
}

function memberIds(value: unknown): string[] {
  const parsed = scimMembersSchema.safeParse(value);
  if (!parsed.success) throw scimFailure(400, "members must be a list of { value }", "invalidValue");
  return parsed.data;
}

function groupPath(path: string) {
  const trimmed = path.trim();
  const local = trimmed.toLowerCase().startsWith(SCIM_GROUP_PATH_PREFIX)
    ? trimmed.slice(SCIM_GROUP_PATH_PREFIX.length)
    : trimmed;
  const match = local.match(/^([a-z][\w$-]*)(?:\[\s*value\s+eq\s+"([^"]*)"\s*\])?$/i);
  if (!match?.[1]) throw scimFailure(400, `unsupported path ${path}`, "invalidPath");
  return { attribute: match[1].toLowerCase(), member: match[2]?.trim() ?? null };
}

function groupOperation(op: "add" | "replace" | "remove", path: string, value: unknown): ScimGroupOperation[] {
  const target = groupPath(path);
  switch (target.attribute) {
    case "members":
      if (target.member !== null) {
        if (op !== "remove") throw scimFailure(400, `unsupported path ${path}`, "invalidPath");
        return [{ kind: "removeMembers", ids: [target.member] }];
      }
      if (op === "remove") return [{ kind: "removeMembers", ids: value === undefined ? null : memberIds(value) }];
      return [{ kind: op === "add" ? "addMembers" : "replaceMembers", ids: memberIds(value) }];
    case "displayname": {
      if (op === "remove" || target.member !== null) throw scimFailure(400, "displayName is required", "mutability");
      const name = scimUserNameSchema.safeParse(value);
      if (!name.success) throw scimFailure(400, "displayName must be a non-empty string", "invalidValue");
      return [{ kind: "displayName", value: name.data }];
    }
    case "externalid": {
      if (target.member !== null) throw scimFailure(400, `unsupported path ${path}`, "invalidPath");
      if (op === "remove") return [{ kind: "externalId", value: null }];
      const externalId = scimUserNameSchema.safeParse(value);
      if (!externalId.success) throw scimFailure(400, "externalId must be a non-empty string", "invalidValue");
      return [{ kind: "externalId", value: externalId.data }];
    }
    default:
      return [];
  }
}

export function parseScimGroupPatch(raw: unknown): ScimGroupOperation[] {
  const parsed = scimPatchSchema.safeParse(raw);
  if (!parsed.success) {
    throw scimFailure(400, "request body must be a SCIM PatchOp message", "invalidSyntax");
  }
  return parsed.data.Operations.flatMap(({ op, path, value }) => {
    if (path) return groupOperation(op, path, value);
    if (op === "remove") throw scimFailure(400, "remove requires a path", "noTarget");
    const record = asRecord(value);
    if (!record) throw scimFailure(400, `${op} without a path requires an object value`, "invalidValue");
    return Object.entries(record).flatMap(([key, item]) => groupOperation(op, key, item));
  });
}

export function applyGroupOperations(current: readonly string[], operations: readonly ScimGroupOperation[]) {
  let members = [...current];
  let displayName: string | undefined;
  let externalId: string | null | undefined;
  for (const operation of operations) {
    switch (operation.kind) {
      case "displayName":
        displayName = operation.value;
        break;
      case "externalId":
        externalId = operation.value;
        break;
      case "addMembers":
        members = [...new Set([...members, ...operation.ids])];
        break;
      case "replaceMembers":
        members = [...operation.ids];
        break;
      case "removeMembers": {
        const drop = operation.ids;
        members = drop ? members.filter((id) => !drop.includes(id)) : [];
        break;
      }
    }
  }
  return { members, displayName, externalId };
}

function groupWhere(filter: ReturnType<typeof parseScimFilter>): Prisma.ScimGroupWhereInput {
  if (!filter) return {};
  if (filter.attribute === "id") return { id: filter.value };
  if (filter.attribute === "externalId") return { externalId: filter.value };
  return { displayName: { equals: filter.value, mode: "insensitive" } };
}

function uniqueness(err: unknown): never {
  if (isPrismaCode(err, "P2002")) throw scimFailure(409, "displayName or externalId is already in use", "uniqueness");
  if (isPrismaCode(err, "P2025")) throw scimFailure(404, "not found");
  throw err;
}

async function knownUsers(ids: readonly string[]): Promise<string[]> {
  if (!ids.length) return [];
  const rows = await prisma.user.findMany({ where: { id: { in: [...ids] } }, select: { id: true } });
  const known = new Set(rows.map((row) => row.id));
  return ids.filter((id) => known.has(id));
}

export async function listScimGroups(filterParam: string | null, page: ScimPage, withMembers: boolean) {
  const where = groupWhere(parseScimFilter(filterParam, GROUP_FILTERS));
  const [total, groups] = await Promise.all([
    prisma.scimGroup.count({ where }),
    page.count
      ? prisma.scimGroup.findMany({
          where,
          orderBy: { displayName: "asc" },
          skip: page.startIndex - 1,
          take: page.count,
          ...(withMembers ? { include: groupInclude } : {}),
        })
      : [],
  ]);
  return { total, groups: groups as GroupRecord[] };
}

export async function getScimGroup(id: string, withMembers = true): Promise<GroupRecord | null> {
  return prisma.scimGroup.findUnique({ where: { id }, ...(withMembers ? { include: groupInclude } : {}) });
}

export async function createScimGroup(input: ScimGroupInput, ipAddress: string | null) {
  const members = await knownUsers(input.members);
  const group = await prisma.scimGroup
    .create({
      data: {
        displayName: input.displayName,
        externalId: input.externalId,
        members: { create: members.map((userId) => ({ userId })) },
      },
      include: groupInclude,
    })
    .catch(uniqueness);
  await writeAudit({
    actor: SCIM_ACTOR,
    action: "scim.group.create",
    objectType: "scim_group",
    objectId: group.id,
    after: { displayName: group.displayName, externalId: group.externalId, members: members.length },
  });
  await syncScimRoles(members, ipAddress);
  return group;
}

async function writeGroup(
  id: string,
  next: { displayName?: string; externalId?: string | null; members: string[] },
  ipAddress: string | null,
) {
  const current = await prisma.scimGroup.findUnique({ where: { id }, include: groupInclude });
  if (!current) throw scimFailure(404, "not found");
  const before = current.members.map(({ user }) => user.id);
  const members = await knownUsers(next.members);
  const added = members.filter((userId) => !before.includes(userId));
  const removed = before.filter((userId) => !members.includes(userId));
  const group = await prisma
    .$transaction([
      prisma.scimGroupMember.deleteMany({ where: { groupId: id, userId: { in: removed } } }),
      prisma.scimGroupMember.createMany({
        data: added.map((userId) => ({ groupId: id, userId })),
        skipDuplicates: true,
      }),
      prisma.scimGroup.update({
        where: { id },
        data: {
          ...(next.displayName !== undefined ? { displayName: next.displayName } : {}),
          ...(next.externalId !== undefined ? { externalId: next.externalId } : {}),
          updatedAt: new Date(),
        },
        include: groupInclude,
      }),
    ])
    .then(([, , updated]) => updated)
    .catch(uniqueness);
  await writeAudit({
    actor: SCIM_ACTOR,
    action: "scim.group.update",
    objectType: "scim_group",
    objectId: id,
    before: { displayName: current.displayName, externalId: current.externalId },
    after: { displayName: group.displayName, externalId: group.externalId, added, removed },
  });
  await syncScimRoles([...added, ...removed], ipAddress);
  return group;
}

export async function replaceScimGroup(id: string, input: ScimGroupInput, ipAddress: string | null) {
  return writeGroup(id, input, ipAddress);
}

export async function patchScimGroup(id: string, operations: ScimGroupOperation[], ipAddress: string | null) {
  const current = await prisma.scimGroupMember.findMany({ where: { groupId: id }, select: { userId: true } });
  const next = applyGroupOperations(
    current.map((row) => row.userId),
    operations,
  );
  return writeGroup(id, next, ipAddress);
}

export async function deleteScimGroup(id: string, ipAddress: string | null) {
  const group = await prisma.scimGroup.findUnique({ where: { id }, include: groupInclude });
  if (!group) throw scimFailure(404, "not found");
  await prisma.scimGroup.delete({ where: { id } }).catch(uniqueness);
  const members = group.members.map(({ user }) => user.id);
  await writeAudit({
    actor: SCIM_ACTOR,
    action: "scim.group.delete",
    objectType: "scim_group",
    objectId: id,
    before: { displayName: group.displayName, externalId: group.externalId, members: members.length },
  });
  await syncScimRoles(members, ipAddress);
}
