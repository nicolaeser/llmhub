"use server";

import prisma from "@/lib/db/prisma";
import { requirePermission } from "@/lib/auth/guards";
import { PERMISSIONS } from "@/lib/auth/permissions";
import { actionFail, runAction } from "@/lib/http/action-result";
import { writeAudit } from "@/lib/audit";
import { isAccountStrategy, isAssignmentScope } from "@/lib/gateway/routing/account-access";
import { assignmentOptions, replaceAssignments } from "@/lib/gateway/routing/account-assignments";
import { forgetAccountPolicies } from "@/lib/gateway/routing/account-routing";
import { antigravityClientSecret, saveAntigravityClientSecret } from "@/lib/gateway/upstreams/antigravity-config";
import { isSignInKind } from "@/lib/gateway/upstreams/provider-kinds";
import type { AccountRouting, AssignmentInput, SignInKind } from "@/types/providers";

const MAX_TARGETS = 500;
const MAX_SECRET_LENGTH = 200;

async function currentRouting(): Promise<AccountRouting> {
  const rows = await prisma.accountRouting.findMany();
  const routing: AccountRouting = {};
  for (const row of rows) {
    if (isSignInKind(row.kind) && isAccountStrategy(row.strategy)) routing[row.kind as SignInKind] = row.strategy;
  }
  return routing;
}

export async function loadAccountRoutingAction() {
  return runAction(async () => {
    await requirePermission(PERMISSIONS.PROVIDERS_READ);
    return { routing: await currentRouting() };
  });
}

export async function saveAccountRoutingAction(input: { kind: string; strategy: string }) {
  return runAction(async () => {
    const session = await requirePermission(PERMISSIONS.PROVIDERS_MANAGE);
    if (!isSignInKind(input.kind)) return actionFail("UNKNOWN_PROVIDER_KIND");
    if (!isAccountStrategy(input.strategy)) return actionFail("VALIDATION");
    const before = (await currentRouting())[input.kind] ?? "inherit";
    await prisma.accountRouting.upsert({
      where: { kind: input.kind },
      create: { kind: input.kind, strategy: input.strategy },
      update: { strategy: input.strategy },
    });
    forgetAccountPolicies();
    await writeAudit({
      actor: session.user.id,
      action: "account_routing.update",
      objectType: "account_routing",
      objectId: input.kind,
      before: { strategy: before },
      after: { strategy: input.strategy },
    });
    return { routing: await currentRouting() };
  });
}

export async function loadAssignmentOptionsAction() {
  return runAction(async () => {
    await requirePermission(PERMISSIONS.PROVIDERS_MANAGE);
    return { options: await assignmentOptions() };
  });
}

export async function saveAssignmentsAction(input: {
  providerId: string;
  restricted: boolean;
  targets: AssignmentInput[];
}) {
  return runAction(async () => {
    const session = await requirePermission(PERMISSIONS.PROVIDERS_MANAGE);
    if (!input.providerId) return actionFail("MISSING_ID");
    if (input.targets.length > MAX_TARGETS) return actionFail("VALIDATION");
    if (!input.targets.every((target) => isAssignmentScope(target.scope) && target.id)) return actionFail("VALIDATION");
    const provider = await prisma.providerConnection.findUnique({
      where: { id: input.providerId },
      select: { kind: true, restricted: true, assignments: { select: { id: true } } },
    });
    if (!provider || !isSignInKind(provider.kind)) return actionFail("NOT_FOUND");
    const saved = await replaceAssignments(input.providerId, Boolean(input.restricted), input.targets);
    if (!saved) return actionFail("NOT_FOUND");
    await writeAudit({
      actor: session.user.id,
      action: "provider.assign",
      objectType: "provider",
      objectId: input.providerId,
      before: { restricted: provider.restricted, targets: provider.assignments.length },
      after: { restricted: saved.restricted, targets: saved.assignments.map((target) => ({ scope: target.scope, id: target.id })) },
    });
    return saved;
  });
}

export async function loadAntigravityConfigAction() {
  return runAction(async () => {
    await requirePermission(PERMISSIONS.PROVIDERS_READ);
    return { configured: Boolean(await antigravityClientSecret()) };
  });
}

export async function saveAntigravityConfigAction(input: { clientSecret: string }) {
  return runAction(async () => {
    const session = await requirePermission(PERMISSIONS.PROVIDERS_MANAGE);
    const secret = input.clientSecret.trim();
    if (secret.length > MAX_SECRET_LENGTH || /\s/.test(secret)) return actionFail("VALIDATION");
    await saveAntigravityClientSecret(secret);
    await writeAudit({
      actor: session.user.id,
      action: "antigravity.configure",
      objectType: "settings",
      objectId: "antigravity",
      after: { configured: secret !== "" },
    });
    return { configured: secret !== "" };
  });
}
