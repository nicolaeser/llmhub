import "server-only";

import prisma from "@/lib/db/prisma";
import { asStringArray } from "@/lib/gateway/core";
import { templateRuleSelect } from "@/lib/gateway/model-access";
import { templateModels, templateRulesOf } from "@/lib/gateway/model-policy";
import { money } from "@/lib/utils/money";
import {
  createModelGroupAction,
  deleteModelGroupAction,
  loadModelsAction,
  updateModelGroupAction,
} from "@/app/(app)/models/_action";
import {
  createTemplateAction,
  deleteTemplateAction,
  loadTemplatesAction,
  updateTemplateAction,
} from "@/app/(app)/model-templates/_action";
import {
  aliasToolInput,
  confirmAliasToolInput,
  confirmIdToolInput,
  createModelToolInput,
  emptyToolInput,
  saveTemplateToolInput,
  updateModelToolInput,
} from "@/schemas/assistant";
import { defineTool, needsConfirmation, toolFail, viaAction } from "@/lib/assistant/tools/define";
import type { DeploymentInput } from "@/types/models";

const MAX_TEMPLATE_MATCHES = 100;

async function providerNames(): Promise<Map<string, string>> {
  const rows = await prisma.providerConnection.findMany({ select: { id: true, name: true } });
  return new Map(rows.map((row) => [row.id, row.name]));
}

async function newDeployments(
  rows: { providerId: string; upstreamModel: string; weight?: number }[],
): Promise<DeploymentInput[] | null> {
  if (!rows.length) return [];
  const ids = [...new Set(rows.map((row) => row.providerId))];
  const providers = await prisma.providerConnection.findMany({
    where: { id: { in: ids } },
    select: { id: true, kind: true, baseUrl: true },
  });
  const byId = new Map(providers.map((row) => [row.id, row]));
  if (byId.size !== ids.length) return null;
  return rows.map((row) => {
    const provider = byId.get(row.providerId)!;
    return {
      kind: provider.kind,
      baseUrl: provider.baseUrl,
      model: row.upstreamModel,
      weight: row.weight ?? 1,
      costInput: 0,
      costOutput: 0,
      providerId: provider.id,
    };
  });
}

export const modelTools = {
  list_models: defineTool({
    description: "Public model aliases with routing strategy, retries, fallbacks, overflow, and the providers behind them.",
    input: emptyToolInput,
    run: async () => {
      const names = await providerNames();
      return viaAction(loadModelsAction(), ({ groups }) => ({
        result: groups.map((group) => ({
          alias: group.alias,
          strategy: group.strategy,
          numRetries: group.numRetries,
          fallbackGroups: group.fallbackGroups,
          overflowGroup: group.overflowGroup,
          endpoints: group.endpoints,
          providers: [
            ...new Set(group.deployments.map((dep) => (dep.providerId ? names.get(dep.providerId) : null) ?? dep.kind)),
          ],
        })),
      }));
    },
  }),
  get_model: defineTool({
    description:
      "One model alias with routing settings and every deployment: provider, upstream model, weight, and price per 1K input and output tokens.",
    input: aliasToolInput,
    run: async ({ alias }) => {
      const names = await providerNames();
      return viaAction(loadModelsAction(), ({ groups }) => {
        const group = groups.find((row) => row.alias === alias);
        if (!group) return toolFail("not_found");
        return {
          result: {
            ...group,
            deployments: group.deployments.map((dep) => ({
              id: dep.id,
              provider: dep.providerId ? (names.get(dep.providerId) ?? dep.providerId) : dep.kind,
              providerId: dep.providerId,
              upstreamModel: dep.model,
              weight: dep.weight,
              costInputPer1k: dep.costInput,
              costOutputPer1k: dep.costOutput,
            })),
          },
        };
      });
    },
  }),
  create_model: defineTool({
    description: "Add a public model alias that routes to an upstream model on a connected provider.",
    input: createModelToolInput,
    run: async (args) => {
      const deployments = await newDeployments([args]);
      if (!deployments) return toolFail("provider_not_found");
      return viaAction(
        createModelGroupAction({
          alias: args.alias,
          strategy: args.strategy ?? "least_inflight",
          numRetries: args.numRetries ?? 2,
          overflowGroup: args.overflowGroup ?? "",
          fallbackGroups: args.fallbackGroups ?? [],
          deployments,
        }),
        (group) => ({ result: { ok: true, alias: group.alias, endpoints: group.endpoints }, navigate: "/models" }),
      );
    },
  }),
  update_model: defineTool({
    description:
      "Change a model alias: routing strategy, billing mode, retries, fallback aliases, overflow alias, add deployments, remove deployments by id, or change deployment weights. Omitted fields stay unchanged.",
    input: updateModelToolInput,
    run: async (args) => {
      const existing = await prisma.modelGroup.findUnique({
        where: { alias: args.alias },
        include: { deployments: true },
      });
      if (!existing) return toolFail("not_found");
      const removed = new Set(args.removeDeploymentIds ?? []);
      const weights = new Map((args.deploymentWeights ?? []).map((row) => [row.id, row.weight]));
      const known = new Set(existing.deployments.map((dep) => dep.id));
      if ([...removed, ...weights.keys()].some((id) => !known.has(id))) {
        return toolFail("deployment_not_found");
      }
      const added = await newDeployments(args.addDeployments ?? []);
      if (!added) return toolFail("provider_not_found");
      const changesDeployments = removed.size > 0 || weights.size > 0 || added.length > 0;
      const deployments: DeploymentInput[] | undefined = changesDeployments
        ? [
            ...existing.deployments
              .filter((dep) => !removed.has(dep.id))
              .map((dep) => ({
                id: dep.id,
                kind: dep.kind,
                baseUrl: dep.baseUrl,
                model: dep.model,
                weight: weights.get(dep.id) ?? dep.weight,
                costInput: money(dep.costInput),
                costOutput: money(dep.costOutput),
                providerId: dep.providerId,
              })),
            ...added,
          ]
        : undefined;
      return viaAction(
        updateModelGroupAction({
          alias: existing.alias,
          strategy: args.strategy ?? existing.strategy,
          billingMode: args.billingMode ?? existing.billingMode,
          numRetries: args.numRetries ?? existing.numRetries,
          overflowGroup: args.overflowGroup ?? existing.overflowGroup,
          fallbackGroups: args.fallbackGroups ?? asStringArray(existing.fallbackGroups),
          deployments,
        }),
        (group) => ({
          result: {
            ok: true,
            alias: group.alias,
            strategy: group.strategy,
            numRetries: group.numRetries,
            fallbackGroups: group.fallbackGroups,
            overflowGroup: group.overflowGroup,
            endpoints: group.endpoints,
          },
          navigate: "/models",
        }),
      );
    },
  }),
  delete_model: defineTool({
    description:
      "Delete a model alias and its deployments. Clients using it start failing. Destructive: ask first and pass confirm only after the operator agreed.",
    input: confirmAliasToolInput,
    run: async ({ alias, confirm }) =>
      needsConfirmation(confirm) ??
      viaAction(deleteModelGroupAction(alias), (deleted) => ({ result: { ok: true, alias: deleted.alias } })),
  }),
  list_model_templates: defineTool({
    description: "Model templates (reusable model allowlists for keys) with their rules, how many keys use them, and which aliases they currently allow.",
    input: emptyToolInput,
    run: async () =>
      viaAction(loadTemplatesAction(), ({ templates, policies }) => ({
        result: templates.map((template) => ({
          ...template,
          matches: templateModels(template, policies).slice(0, MAX_TEMPLATE_MATCHES),
        })),
      })),
  }),
  save_model_template: defineTool({
    description:
      "Create a model template, or update one when id is given. A template needs at least one model or rule. Omitted fields keep their current value on update.",
    input: saveTemplateToolInput,
    run: async (args) => {
      if (!args.id) {
        if (!args.name) return toolFail("invalid_arguments", { issues: [{ path: "name", message: "required" }] });
        return viaAction(
          createTemplateAction({
            name: args.name,
            description: args.description ?? "",
            models: args.models ?? [],
            patterns: args.patterns ?? [],
            providerIds: args.providerIds ?? [],
            regions: args.regions ?? [],
            zdrOnly: args.zdrOnly ?? false,
            noTrainingOnly: args.noTrainingOnly ?? false,
            maxRetentionDays: args.maxRetentionDays ?? null,
          }),
          ({ template }) => ({ result: { ok: true, template }, navigate: "/model-templates" }),
        );
      }
      const existing = await prisma.modelTemplate.findUnique({
        where: { id: args.id },
        select: { ...templateRuleSelect, name: true, description: true },
      });
      if (!existing) return toolFail("not_found");
      const rules = templateRulesOf(existing);
      return viaAction(
        updateTemplateAction({
          id: existing.id,
          name: args.name ?? existing.name,
          description: args.description ?? existing.description,
          models: args.models ?? rules.models,
          patterns: args.patterns ?? rules.patterns,
          providerIds: args.providerIds ?? rules.providerIds,
          regions: args.regions ?? rules.regions,
          zdrOnly: args.zdrOnly ?? rules.zdrOnly,
          noTrainingOnly: args.noTrainingOnly ?? rules.noTrainingOnly,
          maxRetentionDays: args.maxRetentionDays ?? rules.maxRetentionDays,
        }),
        ({ template }) => ({ result: { ok: true, template }, navigate: "/model-templates" }),
      );
    },
  }),
  delete_model_template: defineTool({
    description:
      "Delete a model template that no key uses. Destructive: ask first and pass confirm only after the operator agreed.",
    input: confirmIdToolInput,
    run: async ({ id, confirm }) =>
      needsConfirmation(confirm) ??
      viaAction(deleteTemplateAction(id), (deleted) => ({ result: { ok: true, id: deleted.id } })),
  }),
};
