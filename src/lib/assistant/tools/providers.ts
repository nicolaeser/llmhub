import "server-only";

import prisma from "@/lib/db/prisma";
import {
  createProviderAction,
  deleteProviderAction,
  discoverProviderAction,
  importProviderModelsAction,
  loadProvidersAction,
  updateProviderAction,
} from "@/app/(app)/providers/_action";
import {
  confirmIdToolInput,
  createProviderToolInput,
  emptyToolInput,
  idToolInput,
  importModelsToolInput,
  providerToolInput,
  updateProviderToolInput,
} from "@/schemas/assistant";
import { defineTool, needsConfirmation, toolFail, viaAction } from "@/lib/assistant/tools/define";
import type { ProviderPolicyInput } from "@/types/providers";

const MAX_DISCOVERED = 150;

type PolicyArgs = {
  zdr?: boolean;
  retentionDays?: number;
  region?: string;
  noTraining?: boolean;
};

function hasPolicy(args: PolicyArgs): boolean {
  return (
    args.zdr !== undefined ||
    args.retentionDays !== undefined ||
    args.region !== undefined ||
    args.noTraining !== undefined
  );
}

function mergePolicy(args: PolicyArgs, base: ProviderPolicyInput): ProviderPolicyInput {
  return {
    zdr: args.zdr ?? base.zdr,
    retentionDays: args.retentionDays ?? base.retentionDays,
    region: args.region ?? base.region,
    noTraining: args.noTraining ?? base.noTraining,
  };
}

const NO_POLICY: ProviderPolicyInput = { zdr: false, retentionDays: null, region: "", noTraining: false };

export const providerTools = {
  list_providers: defineTool({
    description: "Connected providers with kind, base URL, data policy, whether a key is set or which subscription account is signed in, and how many upstream models were discovered. Never returns API keys or tokens.",
    input: emptyToolInput,
    run: async () =>
      viaAction(loadProvidersAction(), ({ connected }) => ({
        result: connected.map((row) => ({
          id: row.id,
          name: row.name,
          kind: row.kind,
          baseUrl: row.baseUrl,
          hasApiKey: row.hasApiKey,
          signIn: row.signIn,
          policy: row.policy,
          discoveredModels: row.discovered.length,
        })),
      })),
  }),
  get_provider: defineTool({
    description:
      "One provider connection with its data policy and discovered upstream models (ids, context length, prices per 1K tokens). Never returns the API key.",
    input: providerToolInput,
    run: async ({ id, search }) =>
      viaAction(loadProvidersAction(), ({ connected }) => {
        const row = connected.find((item) => item.id === id);
        if (!row) return toolFail("not_found");
        const needle = search?.toLowerCase() ?? "";
        const matches = row.discovered.filter((model) => !needle || model.id.toLowerCase().includes(needle));
        return {
          result: {
            id: row.id,
            name: row.name,
            kind: row.kind,
            baseUrl: row.baseUrl,
            hasApiKey: row.hasApiKey,
            policy: row.policy,
            discoveredTotal: matches.length,
            discovered: matches.slice(0, MAX_DISCOVERED).map((model) => ({
              id: model.id,
              contextLength: model.contextLength,
              costInputPer1k: model.costInputPer1k,
              costOutputPer1k: model.costOutputPer1k,
            })),
          },
        };
      }),
  }),
  create_provider: defineTool({
    description:
      "Create a provider connection without a key and open the Providers page, where the operator enters the API key. Never ask for API keys in chat. Subscription kinds (codex, grok_build) need the operator to sign in on the Providers page and cannot be created here.",
    input: createProviderToolInput,
    run: async (args) =>
      viaAction(
        createProviderAction({
          name: args.name ?? "",
          kind: args.kind,
          baseUrl: args.baseUrl ?? "",
          apiKey: "",
          policy: hasPolicy(args) ? mergePolicy(args, NO_POLICY) : undefined,
        }),
        ({ provider }) => ({
          result: {
            ok: true,
            id: provider.id,
            name: provider.name,
            kind: provider.kind,
            next: "The operator adds the API key on the Providers page.",
          },
          navigate: "/providers",
        }),
      ),
  }),
  update_provider: defineTool({
    description:
      "Rename a provider, change its base URL, or change its data policy. API keys are only changed by the operator on the Providers page.",
    input: updateProviderToolInput,
    run: async (args) => {
      const existing = await prisma.providerConnection.findUnique({
        where: { id: args.id },
        select: { zdr: true, retentionDays: true, region: true, noTraining: true },
      });
      if (!existing) return toolFail("not_found");
      return viaAction(
        updateProviderAction({
          id: args.id,
          name: args.name ?? "",
          baseUrl: args.baseUrl ?? "",
          apiKey: "",
          policy: hasPolicy(args) ? mergePolicy(args, existing) : undefined,
        }),
        ({ provider }) => ({
          result: { ok: true, id: provider.id, name: provider.name, baseUrl: provider.baseUrl, policy: provider.policy },
        }),
      );
    },
  }),
  refresh_provider_models: defineTool({
    description: "Fetch the provider's current upstream model list now.",
    input: idToolInput,
    run: async ({ id }) =>
      viaAction(discoverProviderAction(id), ({ provider, models }) => ({
        result: {
          ok: true,
          id: provider.id,
          discovered: models.length,
          sample: models.slice(0, 30).map((model) => model.id),
        },
      })),
  }),
  import_provider_models: defineTool({
    description:
      "Create public model aliases from a provider's discovered models, or add the provider as another deployment to existing aliases with the same name.",
    input: importModelsToolInput,
    run: async (args) =>
      viaAction(
        importProviderModelsAction({ id: args.id, models: args.models, strategy: args.strategy }),
        ({ added, updated, strategy }) => ({
          result: { ok: true, added, updated, strategy },
          navigate: "/models",
        }),
      ),
  }),
  delete_provider: defineTool({
    description:
      "Delete a provider connection. Fails while any model deployment still uses it. Destructive: ask first and pass confirm only after the operator agreed.",
    input: confirmIdToolInput,
    run: async ({ id, confirm }) =>
      needsConfirmation(confirm) ??
      viaAction(deleteProviderAction(id), (deleted) => ({ result: { ok: true, id: deleted.id } })),
  }),
};
