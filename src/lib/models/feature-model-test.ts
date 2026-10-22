import "server-only";

import { requirePlatformPermission } from "@/lib/auth/guards";
import { PERMISSIONS } from "@/lib/auth/permissions";
import { toGateError } from "@/lib/gateway/access/gate";
import { systemPrincipal } from "@/lib/gateway/access/system-principal";
import { usageFromUnknown } from "@/lib/gateway/billing/billing";
import { meter } from "@/lib/gateway/billing/meter";
import { jevRequest } from "@/lib/gateway/catalog/jev";
import { asRecord } from "@/lib/gateway/core";
import { forwardToModel } from "@/lib/gateway/dispatch/upstream";
import { assertModelRoles } from "@/lib/models/aliases";
import { featureModel, featureRoles, ROLE_KIND } from "@/lib/models/feature-models";
import { RERANK_PATH, rerankUsage } from "@/lib/rag/models";
import { featureModelTestSchema } from "@/schemas/models";
import type { TokenUsage } from "@/types/billing";
import type { JsonMap } from "@/types/gateway";
import type { JevTask } from "@/types/model-catalog";
import type { FeatureModelRole, FeatureModelTest } from "@/types/models";

export const MODEL_TEST_TIMEOUT_MS = 30_000;
const ERROR_LIMIT = 300;
const PROBE_TEXT = "Reply with OK.";
const PROBE_IMAGE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=";
const PROBE_TASK: JevTask = {
  providerId: "",
  upstreamId: "gpt-4o",
  kind: "openai",
  vendor: "openai",
  name: "GPT-4o",
  candidates: [{ alias: "gpt-4o", label: "GPT-4o" }],
};

type Probe = { path: string; body: JsonMap; usage: (json: unknown) => Partial<TokenUsage> };

const tokenUsage = (json: unknown) => usageFromUnknown(asRecord(json)?.usage, json);

const PROBES: Record<FeatureModelRole, (model: string) => Probe> = {
  chat: (model) => ({
    path: "/chat/completions",
    body: { model, messages: [{ role: "user", content: PROBE_TEXT }] },
    usage: tokenUsage,
  }),
  jev: (model) => ({ path: "/systemone", body: jevRequest(PROBE_TASK, model), usage: tokenUsage }),
  embedding: (model) => ({ path: "/embeddings", body: { model, input: PROBE_TEXT }, usage: tokenUsage }),
  ocr: (model) => ({
    path: "/ocr",
    body: { model, document: { type: "image_url", image_url: PROBE_IMAGE } },
    usage: tokenUsage,
  }),
  rerank: (model) => ({
    path: RERANK_PATH,
    body: { model, query: PROBE_TEXT, documents: [PROBE_TEXT, "pong"], top_n: 2 },
    usage: rerankUsage,
  }),
};

export async function testFeatureModel(raw: unknown): Promise<FeatureModelTest> {
  await requirePlatformPermission(PERMISSIONS.SETTINGS_MANAGE);
  const parsed = featureModelTestSchema.safeParse(raw);
  if (!parsed.success || !featureRoles(parsed.data.feature).includes(parsed.data.role)) throw new Error("VALIDATION");
  const { feature, role } = parsed.data;
  const model = parsed.data.model || (await featureModel(feature, role));
  if (!model) throw new Error("MODEL_REQUIRED");
  await assertModelRoles([{ alias: model, role: ROLE_KIND[role] }]);
  const probe = PROBES[role](model);
  const principal = systemPrincipal(`test:${feature}`);
  const usage = meter(principal, model, probe.body);
  const started = Date.now();
  let hit;
  try {
    hit = await forwardToModel([model], principal, probe.path, probe.body, {
      pool: "internal",
      timeoutMs: MODEL_TEST_TIMEOUT_MS,
    });
  } catch (err) {
    const latencyMs = Date.now() - started;
    await usage.fail(err);
    const gate = toGateError(err);
    return { model, ok: false, latencyMs, status: gate.status, error: gate.message.slice(0, ERROR_LIMIT) };
  }
  const latencyMs = Date.now() - started;
  await usage.ok(hit, probe.usage(hit.json));
  return { model, ok: true, latencyMs, status: hit.status, error: "" };
}
