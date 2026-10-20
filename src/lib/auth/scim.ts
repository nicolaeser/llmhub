import "server-only";
import prisma from "@/lib/db/prisma";
import { uniqueUsername, unusablePassword } from "@/lib/auth/sso-user";
import { directoryOrgId, directoryRoleId } from "@/lib/auth/directory-roles";
import { getEnterprise, normalizeOidc } from "@/lib/settings/enterprise";
import { refuseIfNoOperators } from "@/lib/bootstrap/operators";
import { templateRoleId } from "@/lib/auth/roles";
import { isPrismaCode } from "@/lib/auth/errors";
import { securityEvent } from "@/lib/auth/security-events";
import { removeUserWithInternalKeys } from "@/lib/auth/user-removal";
import { writeAudit } from "@/lib/audit";
import { digest, randomToken } from "@/lib/crypto";
import { bearerToken } from "@/lib/http/api";
import { errorFields } from "@/lib/logging/format";
import { logger } from "@/lib/logging/logger";
import { isRoleTemplateKey } from "@/lib/auth/permissions";
import type { RoleTemplateKey } from "@/types/auth";
import { asRecord } from "@/lib/gateway/core";
import { NextResponse } from "next/server";
import type {
  ScimErrorType,
  ScimFilter,
  ScimPage,
  ScimPatchOperation,
  ScimUserChanges,
  ScimUserInput,
  ScimUserUpdate,
  ScimUser,
} from "@/types/scim";
import {
  scimBooleanSchema,
  scimEmailSchema,
  scimPatchSchema,
  scimUserNameSchema,
  scimUserResourceSchema,
  scimValuesSchema,
} from "@/schemas/scim";

export const SCIM_USER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User";
export const SCIM_LIST_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:ListResponse";
const SCIM_ERROR_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:Error";
const SCIM_CONTENT_TYPE = "application/scim+json";
const SCIM_TOKEN_KEY = "scim_token_hash";
const SCIM_ACTOR = "scim";
const SCIM_USER_PATH_PREFIX = `${SCIM_USER_SCHEMA}:`.toLowerCase();
const OWNER_DETAIL = "the owner account cannot be managed through SCIM";
const SCIM_DEFAULT_COUNT = 100;
const SCIM_MAX_COUNT = 200;

export function scimJson(body: unknown, status = 200): NextResponse {
  const res = NextResponse.json(body, { status });
  res.headers.set("Content-Type", SCIM_CONTENT_TYPE);
  return res;
}

export function scimError(
  status: number,
  detail: string,
  scimType?: ScimErrorType,
): NextResponse {
  return scimJson(
    {
      schemas: [SCIM_ERROR_SCHEMA],
      status: String(status),
      ...(scimType ? { scimType } : {}),
      detail,
    },
    status,
  );
}

export function scimFailure(status: number, detail: string, scimType?: ScimErrorType): Error {
  return Object.assign(new Error(detail), { status, scimType });
}

export function scimCaught(err: unknown): NextResponse {
  const status = (err as { status?: number }).status ?? 500;
  if (status === 401) return scimError(401, "SCIM requires a valid bearer token");
  if (
    (err as { code?: string }).code === "SETUP_REQUIRED" ||
    (err instanceof Error && err.message === "SETUP_REQUIRED")
  ) {
    return scimError(403, "SETUP_REQUIRED");
  }
  if (status >= 500) return scimError(500, "internal error");
  return scimError(
    status,
    err instanceof Error ? err.message : "scim error",
    (err as { scimType?: ScimErrorType }).scimType,
  );
}

export async function requireScimToken(req: Request): Promise<void> {
  const token = bearerToken(req);
  const stored = token
    ? await prisma.setting.findUnique({ where: { key: SCIM_TOKEN_KEY } })
    : null;
  if (!stored || digest(token) !== stored.value) {
    throw Object.assign(new Error("SCIM requires a valid bearer token"), { status: 401 });
  }
}

export function scimHandler<A extends unknown[]>(
  name: string,
  handler: (req: Request, ...args: A) => Promise<Response>,
) {
  return async (req: Request, ...args: A): Promise<Response> => {
    try {
      await requireScimToken(req);
      return await handler(req, ...args);
    } catch (err) {
      if (((err as { status?: number }).status ?? 500) >= 500) {
        logger.error(`scim.${name}.failed`, errorFields(err));
      }
      return scimCaught(err);
    }
  };
}

export async function scimTokenSet(): Promise<boolean> {
  return Boolean(await prisma.setting.findUnique({ where: { key: SCIM_TOKEN_KEY } }));
}

export async function issueScimToken(): Promise<string> {
  const token = `scim_${randomToken()}`;
  await prisma.setting.upsert({
    where: { key: SCIM_TOKEN_KEY },
    update: { value: digest(token) },
    create: { key: SCIM_TOKEN_KEY, value: digest(token) },
  });
  return token;
}

export async function revokeScimToken(): Promise<void> {
  await prisma.setting.deleteMany({ where: { key: SCIM_TOKEN_KEY } });
}

export function scimEmail(input: ScimUserInput): string {
  const emails = input.emails ?? [];
  const fromEmails =
    (emails.find((e) => e.primary && e.value) ?? emails.find((e) => e.value))?.value ?? "";
  return (fromEmails || input.userName || "").trim().toLowerCase();
}

export function scimRoleKey(input: { roles?: { value?: string }[] }): RoleTemplateKey {
  const raw = (input.roles?.[0]?.value ?? "").trim().toLowerCase();
  return isRoleTemplateKey(raw) ? raw : "viewer";
}

export function scimMeta(
  resourceType: "User" | "Group",
  row: { createdAt?: Date; updatedAt?: Date },
) {
  return {
    resourceType,
    ...(row.createdAt ? { created: row.createdAt.toISOString() } : {}),
    ...(row.updatedAt ? { lastModified: row.updatedAt.toISOString() } : {}),
  };
}

export function toScimUser(user: {
  id: string;
  email: string;
  blocked: boolean;
  externalId?: string | null;
  createdAt?: Date;
  updatedAt?: Date;
  role?: { templateKey: string | null; name: string | null } | null;
  scimGroups?: { group: { id: string; displayName: string } }[];
}): ScimUser {
  const role = user.role?.templateKey ?? user.role?.name ?? "";
  return {
    schemas: [SCIM_USER_SCHEMA],
    id: user.id,
    ...(user.externalId ? { externalId: user.externalId } : {}),
    userName: user.email,
    active: !user.blocked,
    name: { formatted: user.email },
    emails: [{ value: user.email, primary: true }],
    roles: role ? [{ value: role }] : [],
    ...(user.scimGroups
      ? { groups: user.scimGroups.map(({ group }) => ({ value: group.id, display: group.displayName })) }
      : {}),
    meta: scimMeta("User", user),
  };
}

export function parseScimFilter(filter: string | null, attributes: readonly string[]): ScimFilter {
  if (!filter?.trim()) return null;
  const match = filter.trim().match(/^([A-Za-z][\w.]*)\s+eq\s+"((?:[^"\\]|\\.)*)"$/i);
  const attribute = match?.[1] ? attributes.find((name) => name.toLowerCase() === match[1]!.toLowerCase()) : undefined;
  if (!match || !attribute) {
    throw scimFailure(400, "only <attribute> eq \"value\" filters on supported attributes are allowed", "invalidFilter");
  }
  return { attribute, value: match[2]!.replace(/\\(.)/g, "$1").trim() };
}

export function parseScimPage(url: URL): ScimPage {
  const startIndex = Math.max(1, Math.trunc(Number(url.searchParams.get("startIndex") ?? 1)) || 1);
  const countRaw = Number(url.searchParams.get("count") ?? SCIM_DEFAULT_COUNT);
  const count = Number.isFinite(countRaw) ? Math.min(Math.max(Math.trunc(countRaw), 0), SCIM_MAX_COUNT) : SCIM_DEFAULT_COUNT;
  return { startIndex, count };
}

export function scimList<T>(resources: T[], total: number, page: ScimPage) {
  return {
    schemas: [SCIM_LIST_SCHEMA],
    totalResults: total,
    startIndex: page.startIndex,
    itemsPerPage: resources.length,
    Resources: resources,
  };
}

const USER_FILTERS = ["userName", "emails.value", "externalId", "id"] as const;

function userWhere(filter: ScimFilter) {
  if (!filter) return {};
  if (filter.attribute === "externalId") return { externalId: filter.value };
  if (filter.attribute === "id") return { id: filter.value };
  return { email: filter.value.toLowerCase() };
}

export function parseScimUserBody(raw: unknown): ScimUserInput {
  if (!asRecord(raw)) {
    throw scimFailure(400, "request body must be a SCIM User resource", "invalidSyntax");
  }
  const parsed = scimUserResourceSchema.safeParse(raw);
  if (!parsed.success) throw scimFailure(400, "invalid SCIM User resource", "invalidValue");
  const { userName, externalId, emails, roles, active } = parsed.data;
  return {
    userName: userName || undefined,
    externalId: externalId || undefined,
    emails: emails ?? undefined,
    roles: roles ?? undefined,
    active: active ?? undefined,
  };
}

export function parseScimPut(raw: unknown): ScimPatchOperation[] {
  const input = parseScimUserBody(raw);
  const email = scimEmail({ emails: input.emails });
  if (!input.userName && !email) {
    throw scimFailure(400, "userName or emails.value is required", "invalidValue");
  }
  const operations: ScimPatchOperation[] = [];
  if (input.userName) operations.push({ op: "replace", attribute: "userName", value: input.userName });
  if (input.externalId) operations.push({ op: "replace", attribute: "externalId", value: input.externalId });
  if (email) operations.push({ op: "replace", attribute: "email", value: email });
  if (input.active !== undefined) {
    operations.push({ op: "replace", attribute: "active", value: input.active });
  }
  if (input.roles) {
    operations.push({
      op: "replace",
      attribute: "roles",
      value: input.roles.flatMap((role) => (role.value ? [role.value] : [])),
    });
  }
  return operations;
}

function scimPath(path: string) {
  const trimmed = path.trim();
  const local = trimmed.toLowerCase().startsWith(SCIM_USER_PATH_PREFIX)
    ? trimmed.slice(SCIM_USER_PATH_PREFIX.length)
    : trimmed;
  const match = local.match(/^([a-z][\w$-]*)(?:\[([^\]]*)\])?(?:\.([a-z][\w$-]*))?$/i);
  if (!match?.[1]) return null;
  return {
    attribute: match[1].toLowerCase(),
    filter: match[2]?.trim() ?? "",
    sub: match[3]?.toLowerCase() ?? "",
  };
}

function scimFilterValue(filter: string): string | null {
  return filter.match(/^value\s+eq\s+"([^"]*)"$/i)?.[1]?.trim() || null;
}

function scimPatchTarget(
  op: "add" | "replace" | "remove",
  path: string,
  value: unknown,
): ScimPatchOperation[] {
  const target = scimPath(path);
  if (!target) return [];
  const simple = !target.filter && !target.sub;
  switch (target.attribute) {
    case "active": {
      if (!simple || op === "remove") throw scimFailure(400, `unsupported path ${path}`, "invalidPath");
      const active = scimBooleanSchema.safeParse(value);
      if (!active.success) throw scimFailure(400, "active must be a boolean", "invalidValue");
      return [{ op: "replace", attribute: "active", value: active.data }];
    }
    case "externalid": {
      if (!simple) throw scimFailure(400, `unsupported path ${path}`, "invalidPath");
      if (op === "remove") return [{ op: "replace", attribute: "externalId", value: null }];
      const externalId = scimUserNameSchema.safeParse(value);
      if (!externalId.success) throw scimFailure(400, "externalId must be a non-empty string", "invalidValue");
      return [{ op: "replace", attribute: "externalId", value: externalId.data }];
    }
    case "username": {
      if (!simple || op === "remove") throw scimFailure(400, `unsupported path ${path}`, "invalidPath");
      const userName = scimUserNameSchema.safeParse(value);
      if (!userName.success) throw scimFailure(400, "userName must be a non-empty string", "invalidValue");
      return [{ op: "replace", attribute: "userName", value: userName.data }];
    }
    case "emails": {
      if (target.sub && target.sub !== "value") return [];
      if (op === "remove") throw scimFailure(400, `unsupported path ${path}`, "invalidPath");
      const emails = scimValuesSchema.safeParse(value);
      const email = emails.success ? emails.data[0]?.value : undefined;
      if (!email) throw scimFailure(400, "emails requires a value", "invalidValue");
      return [{ op: "replace", attribute: "email", value: email }];
    }
    case "roles": {
      if (target.sub && target.sub !== "value") return [];
      const roles = value === undefined ? null : scimValuesSchema.safeParse(value);
      if (roles && !roles.success) throw scimFailure(400, "roles must be a list of values", "invalidValue");
      const values = roles ? roles.data.map((role) => role.value) : null;
      if (op === "remove") {
        const filtered = scimFilterValue(target.filter);
        return [{ op: "remove", attribute: "roles", value: filtered ? [filtered] : values }];
      }
      if (!values) throw scimFailure(400, "roles requires a value", "invalidValue");
      return [{ op: "replace", attribute: "roles", value: values }];
    }
    default:
      return [];
  }
}

export function parseScimPatch(raw: unknown): ScimPatchOperation[] {
  const parsed = scimPatchSchema.safeParse(raw);
  if (!parsed.success) {
    throw scimFailure(400, "request body must be a SCIM PatchOp message", "invalidSyntax");
  }
  return parsed.data.Operations.flatMap(({ op, path, value }) => {
    if (path) return scimPatchTarget(op, path, value);
    if (op === "remove") throw scimFailure(400, "remove requires a path", "noTarget");
    const record = asRecord(value);
    if (!record) throw scimFailure(400, `${op} without a path requires an object value`, "invalidValue");
    return Object.entries(record).flatMap(([key, item]) => scimPatchTarget(op, key, item));
  });
}

export function applyScimPatch(
  operations: ScimPatchOperation[],
  currentRoles: string[],
): ScimUserChanges {
  return operations.reduce<ScimUserChanges>((changes, operation) => {
    if (operation.op === "remove") {
      const drop = operation.value?.map((role) => role.trim().toLowerCase());
      const roles = changes.roles ?? currentRoles;
      return {
        ...changes,
        roles: drop ? roles.filter((role) => !drop.includes(role.trim().toLowerCase())) : [],
      };
    }
    switch (operation.attribute) {
      case "active":
        return { ...changes, active: operation.value };
      case "userName":
        return { ...changes, userName: operation.value };
      case "email":
        return { ...changes, email: operation.value };
      case "roles":
        return { ...changes, roles: operation.value };
      case "externalId":
        return { ...changes, externalId: operation.value };
    }
  }, {});
}

function scimHandle(userName: string): string {
  return userName
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

export function scimUserUpdate(
  current: { email: string; username: string; blocked: boolean; roles: string[]; externalId?: string | null },
  changes: ScimUserChanges,
): ScimUserUpdate {
  const userName = changes.userName?.trim() ?? "";
  const isEmailName = userName.includes("@");
  const handle = userName && !isEmailName ? scimHandle(userName) : "";
  if (userName && !isEmailName && !handle) {
    throw scimFailure(400, "userName is not a valid user name", "invalidValue");
  }
  const emailInput = changes.email ?? (isEmailName ? userName : undefined);
  const email = emailInput === undefined ? null : scimEmailSchema.safeParse(emailInput);
  if (email && !email.success) {
    throw scimFailure(400, "emails.value must be an email address", "invalidValue");
  }
  const update: ScimUserUpdate = {};
  if (changes.externalId !== undefined && changes.externalId !== (current.externalId ?? null)) {
    update.externalId = changes.externalId;
  }
  if (email?.success && email.data !== current.email) update.email = email.data;
  if (handle && handle !== current.username) update.username = handle;
  if (changes.active !== undefined && changes.active === current.blocked) {
    update.blocked = !changes.active;
  }
  const requestedRole = (changes.roles?.[0] ?? "").trim().toLowerCase();
  const currentRole = (current.roles[0] ?? "").trim().toLowerCase();
  if (changes.roles && requestedRole !== currentRole) {
    const roleKey = scimRoleKey({ roles: changes.roles.map((value) => ({ value })) });
    if (roleKey !== currentRole) update.roleKey = roleKey;
  }
  return update;
}

const userInclude = {
  role: { select: { templateKey: true, name: true } },
  scimGroups: { select: { group: { select: { id: true, displayName: true } } } },
} as const;

export async function listScimUsers(filterParam: string | null, page: ScimPage) {
  const where = userWhere(parseScimFilter(filterParam, USER_FILTERS));
  const [total, users] = await Promise.all([
    prisma.user.count({ where }),
    page.count
      ? prisma.user.findMany({
          where,
          orderBy: { email: "asc" },
          skip: page.startIndex - 1,
          take: page.count,
          include: userInclude,
        })
      : [],
  ]);
  return { total, users };
}

export async function getScimUser(id: string) {
  return prisma.user.findUnique({ where: { id }, include: userInclude });
}

async function directorySettings() {
  return normalizeOidc((await getEnterprise()).oidc);
}

export async function createScimUser(input: ScimUserInput) {
  const email = scimEmail(input);
  if (!email || !email.includes("@")) {
    throw scimFailure(400, "userName or emails.value is required", "invalidValue");
  }
  const exists = await prisma.user.findUnique({ where: { email } });
  if (exists) throw scimFailure(409, "User already exists", "uniqueness");
  await refuseIfNoOperators();
  const oidc = await directorySettings();
  const roleId =
    input.roles && !oidc.role_mappings.length
      ? await templateRoleId(scimRoleKey(input))
      : await directoryRoleId(oidc, []);
  const local = (input.userName && !input.userName.includes("@")
    ? input.userName
    : email.split("@")[0]) ?? "user";
  try {
    const user = await prisma.user.create({
      data: {
        username: await uniqueUsername(local),
        email,
        externalId: input.externalId ?? null,
        password: await unusablePassword(),
        blocked: input.active === false,
        roleId,
        orgId: await directoryOrgId(oidc),
      },
      include: userInclude,
    });
    await writeAudit({
      actor: SCIM_ACTOR,
      action: "scim.user.create",
      objectType: "user",
      objectId: user.id,
      after: { roleId, orgId: user.orgId, externalId: user.externalId, blocked: user.blocked },
    });
    return user;
  } catch (err) {
    if (isPrismaCode(err, "P2002")) throw scimFailure(409, "User already exists", "uniqueness");
    throw err;
  }
}

export async function updateScimUser(
  id: string,
  operations: ScimPatchOperation[],
  ipAddress: string | null,
) {
  const user = await prisma.user.findUnique({ where: { id }, include: userInclude });
  if (!user) throw scimFailure(404, "not found");
  if (user.isOwner) throw scimFailure(403, OWNER_DETAIL);
  const roles = toScimUser(user).roles?.map((role) => role.value) ?? [];
  const directoryRoles = (await directorySettings()).role_mappings.length > 0;
  const update = scimUserUpdate(
    { email: user.email, username: user.username, blocked: user.blocked, roles, externalId: user.externalId },
    applyScimPatch(
      directoryRoles ? operations.filter((operation) => operation.attribute !== "roles") : operations,
      roles,
    ),
  );
  const roleId = update.roleKey ? await templateRoleId(update.roleKey) : user.roleId;
  if (update.roleKey && !roleId) {
    throw scimFailure(500, `role template ${update.roleKey} is missing`);
  }
  const next = {
    ...(update.externalId !== undefined ? { externalId: update.externalId } : {}),
    ...(update.email ? { email: update.email } : {}),
    ...(update.username ? { username: update.username } : {}),
    ...(update.blocked !== undefined ? { blocked: update.blocked } : {}),
    ...(roleId !== user.roleId ? { roleId } : {}),
  };
  const keys = Object.keys(next) as (keyof typeof next)[];
  if (!keys.length) return user;
  const events = [
    ...(update.blocked !== undefined
      ? [securityEvent(SCIM_ACTOR, update.blocked ? "account.blocked" : "account.unblocked", ipAddress)]
      : []),
    ...(update.blocked ? [securityEvent(SCIM_ACTOR, "sessions.revoked", ipAddress)] : []),
    ...(next.roleId !== undefined ? [securityEvent(SCIM_ACTOR, "role.changed", ipAddress)] : []),
  ];
  let updated;
  try {
    updated = await prisma.user.update({
      where: { id: user.id, isOwner: false },
      data: {
        ...next,
        revision: { increment: 1 },
        ...(update.blocked
          ? { sessions: { deleteMany: {} }, loginChallenges: { deleteMany: {} } }
          : {}),
        ...(events.length ? { securityEvents: { create: events } } : {}),
      },
      include: userInclude,
    });
  } catch (err) {
    if (isPrismaCode(err, "P2002")) {
      throw scimFailure(409, "userName, email, or externalId is already in use", "uniqueness");
    }
    if (isPrismaCode(err, "P2025")) throw scimFailure(404, "not found");
    throw err;
  }
  await writeAudit({
    actor: SCIM_ACTOR,
    action: "scim.user.update",
    objectType: "user",
    objectId: user.id,
    before: Object.fromEntries(keys.map((key) => [key, user[key]])),
    after: next,
  });
  return updated;
}

export async function deleteScimUser(id: string) {
  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) throw scimFailure(404, "not found");
  if (user.isOwner) throw scimFailure(403, OWNER_DETAIL);
  const { revokedKeys } = await removeUserWithInternalKeys(user.id);
  await writeAudit({
    actor: SCIM_ACTOR,
    action: "scim.user.delete",
    objectType: "user",
    objectId: user.id,
    before: { username: user.username, email: user.email, orgId: user.orgId },
    after: { revokedKeys },
  });
}
