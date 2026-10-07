import "server-only";

import prisma from "@/lib/db/prisma";
import { money } from "@/lib/utils/money";
import { toKeyView } from "@/app/(app)/_data";
import {
  createKeyAction,
  revokeKeyAction,
  rotateKeyAction,
  updateKeyAction,
} from "@/app/(app)/_action";
import {
  confirmKeyToolInput,
  createKeyToolInput,
  keyToolInput,
  listKeysToolInput,
  updateKeyToolInput,
} from "@/schemas/assistant";
import { defineTool, needsConfirmation, toolFail, viaAction } from "@/lib/assistant/tools/define";
import { ownKeysWhere } from "@/lib/assistant/tools/general";
import type { Prisma } from "@/generated/prisma/client";
import type { AssistantContext, AssistantToolResult, PublicKeyView } from "@/types/assistant";

const SECRET_NOTE = "The console already showed the operator the secret once. Never ask for it or repeat it.";

export function toPublicKeyView(row: {
  id: string;
  keyAlias: string;
  prefix: string;
  spend: Prisma.Decimal | number;
  maxBudget: Prisma.Decimal | number;
  blocked: boolean;
}): PublicKeyView {
  return {
    id: row.id,
    alias: row.keyAlias,
    prefix: row.prefix,
    spend: money(row.spend),
    maxBudget: money(row.maxBudget),
    blocked: row.blocked,
  };
}

async function findKey(ref: string, ctx: AssistantContext) {
  const rows = await prisma.virtualKey.findMany({
    where: { ...ownKeysWhere(ctx), OR: [{ id: ref }, { prefix: ref }, { keyAlias: ref }] },
    include: { templates: { select: { templateId: true } } },
    orderBy: { createdAt: "desc" },
    take: 5,
  });
  const exact = rows.find((row) => row.id === ref || row.prefix === ref);
  if (exact) return { key: exact };
  if (rows.length === 1) return { key: rows[0] };
  if (rows.length > 1) {
    return {
      failure: toolFail("ambiguous_key", {
        candidates: rows.map((row) => ({ id: row.id, alias: row.keyAlias, prefix: row.prefix })),
      }),
    };
  }
  return { failure: toolFail("not_found") };
}

async function withKey(
  ref: string,
  ctx: AssistantContext,
  run: (key: NonNullable<Awaited<ReturnType<typeof findKey>>["key"]>) => Promise<AssistantToolResult>,
): Promise<AssistantToolResult> {
  const found = await findKey(ref, ctx);
  if (!found.key) return found.failure ?? toolFail("not_found");
  return run(found.key);
}

export const keyTools = {
  list_keys: defineTool({
    description: "Virtual keys with id, alias, prefix, spend, budget, and blocked state. Never full secrets.",
    input: listKeysToolInput,
    run: async ({ search, limit }, ctx) => {
      const rows = await prisma.virtualKey.findMany({
        where: {
          ...ownKeysWhere(ctx),
          ...(search
            ? {
                OR: [
                  { keyAlias: { contains: search, mode: "insensitive" as const } },
                  { prefix: { contains: search } },
                ],
              }
            : {}),
        },
        orderBy: { createdAt: "desc" },
        take: limit,
        select: {
          id: true,
          keyAlias: true,
          prefix: true,
          spend: true,
          maxBudget: true,
          blocked: true,
        },
      });
      return { result: rows.map(toPublicKeyView) };
    },
  }),
  get_key: defineTool({
    description:
      "One virtual key by id, alias, or prefix: models, templates, RPM and TPM limits, allowed IPs, budget, expiry, who it belongs to (project, person, or internal) with its department and company, content logging, and PII override. Never the secret.",
    input: keyToolInput,
    run: async ({ key }, ctx) =>
      withKey(key, ctx, async (row) => {
        const [org, team, project, member] = await Promise.all([
          row.orgId ? prisma.organization.findUnique({ where: { id: row.orgId }, select: { alias: true } }) : null,
          row.teamId ? prisma.team.findUnique({ where: { id: row.teamId }, select: { alias: true } }) : null,
          row.projectId
            ? prisma.project.findUnique({ where: { id: row.projectId }, select: { alias: true } })
            : null,
          row.memberId ? prisma.member.findUnique({ where: { id: row.memberId }, select: { name: true } }) : null,
        ]);
        return {
          result: {
            ...toKeyView(row),
            binding: row.memberId ? "member" : row.projectId ? "project" : "internal",
            org_alias: org?.alias ?? "",
            team_alias: team?.alias ?? "",
            project_alias: project?.alias ?? "",
            member_name: member?.name ?? "",
          },
        };
      }),
  }),
  create_key: defineTool({
    description:
      "Create a virtual key for a project (projectId) or a person (memberId) of a company, or an internal key of the operator when neither is given; optionally limited to models, templates, IPs, RPM, TPM, and an expiry. Binding to a project or person needs tenancy:manage. The console shows the secret to the operator once; you never see it.",
    input: createKeyToolInput,
    run: async (args) =>
      viaAction(createKeyAction(args), ({ key }) => ({
        result: { ok: true, id: key.token_id, alias: key.key_alias, prefix: key.key_name, note: SECRET_NOTE },
        secret: key.key,
        navigate: "/keys",
      })),
  }),
  update_key: defineTool({
    description:
      "Change a virtual key: alias, who it belongs to (projectId or memberId; sending either replaces the binding, both empty makes it internal), models, templates, RPM, TPM, allowed IPs, content logging, or blocked state. Omitted fields stay unchanged. Budgets use set_budget.",
    input: updateKeyToolInput,
    run: async (args, ctx) =>
      withKey(args.key, ctx, async (row) => {
        const view = toKeyView(row);
        const rebinds = args.projectId !== undefined || args.memberId !== undefined;
        return viaAction(
          updateKeyAction({
            id: row.id,
            alias: args.alias ?? (row.keyAlias || row.prefix),
            projectId: rebinds ? (args.projectId ?? "") : view.project_id,
            memberId: rebinds ? (args.memberId ?? "") : view.member_id,
            models: args.models ?? view.models,
            templateIds: args.templateIds ?? view.templates,
            rpm: args.rpm ?? view.rpm_limit,
            tpm: args.tpm ?? view.tpm_limit,
            allowedIps: args.allowedIps ?? view.allowed_ips,
            logContent: args.logContent ?? view.log_content,
            blocked: args.blocked ?? view.blocked,
          }),
          ({ key }) => ({
            result: {
              ok: true,
              id: key.token_id,
              alias: key.key_alias,
              blocked: key.blocked,
              models: key.models,
              templates: key.templates,
              rpm_limit: key.rpm_limit,
              tpm_limit: key.tpm_limit,
            },
          }),
        );
      }),
  }),
  rotate_key: defineTool({
    description:
      "Issue a new secret for a virtual key. The old secret keeps working for one hour. Destructive: ask first and pass confirm only after the operator agreed.",
    input: confirmKeyToolInput,
    run: async ({ key, confirm }, ctx) =>
      needsConfirmation(confirm) ??
      withKey(key, ctx, async (row) =>
        viaAction(rotateKeyAction(row.id), ({ key: rotated }) => ({
          result: { ok: true, id: rotated.token_id, alias: rotated.key_alias, prefix: rotated.key_name, note: SECRET_NOTE },
          secret: rotated.key,
          navigate: "/keys",
        })),
      ),
  }),
  revoke_key: defineTool({
    description:
      "Delete a virtual key permanently. Clients using it fail immediately. Destructive: ask first and pass confirm only after the operator agreed.",
    input: confirmKeyToolInput,
    run: async ({ key, confirm }, ctx) =>
      needsConfirmation(confirm) ??
      withKey(key, ctx, async (row) =>
        viaAction(revokeKeyAction(row.id), (deleted) => ({
          result: { ok: true, id: deleted.id, alias: row.keyAlias, prefix: row.prefix },
        })),
      ),
  }),
};
