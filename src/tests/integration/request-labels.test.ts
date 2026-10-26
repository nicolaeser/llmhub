import assert from "node:assert/strict";
import { after, test } from "node:test";
import prisma from "@/lib/db/prisma";
import { runAsPrincipal } from "@/lib/auth/delegation";
import { withTrace } from "@/lib/gateway/access/gate";
import { keyPrincipal } from "@/lib/gateway/access/principal";
import { recordUsage } from "@/lib/gateway/billing/billing";
import { headerLabels } from "@/lib/gateway/billing/request-labels";
import { loadLogs } from "@/lib/gateway/request-logs/explorer";
import { patchEnterprise } from "@/lib/settings/enterprise";
import { savePlatformLabelKeys } from "@/lib/settings/request-labels";
import { saveCompanyLabelKeys } from "@/lib/tenancy/structure";
import { loadUsage } from "@/lib/usage/dashboard";
import { chargebackParts } from "@/lib/usage/usage-stats";
import { closeDatabase, ownerSession, uniqueName } from "./support/database";
import { preserveSetting, TestData } from "./support/fixtures";
import type { Deployment } from "@/types/routing";

after(closeDatabase);

const deployment: Deployment = {
  id: "",
  kind: "openai",
  base_url: "https://upstream.example.invalid/v1",
  model: "gpt-4o",
  weight: 1,
  cost_input_per_1k: 1,
  cost_output_per_1k: 2,
  provider_id: "",
};

test("labels are booked once per request into the log, the label rollup, usage, and log filters", async () => {
  const owner = await ownerSession();
  const data = new TestData();
  data.ownUser(owner.user.id);
  const restore = await preserveSetting("enterprise");
  const model = uniqueName("labels");
  try {
    const org = await data.org();
    const project = await data.project(org.id);
    const key = await data.key({ projectId: project.id, orgId: org.id });
    await patchEnterprise({ label_keys: ["env"] });
    await runAsPrincipal(owner, () => saveCompanyLabelKeys({ orgId: org.id, keys: ["Cost-Center"] }));
    assert.deepEqual((await prisma.organization.findUnique({ where: { id: org.id } }))?.labelKeys, ["cost_center"]);
    await assert.rejects(
      runAsPrincipal(owner, () => saveCompanyLabelKeys({ orgId: org.id, keys: ["no spaces"] })),
      /LABEL_KEY_INVALID/,
    );

    const send = async (headers: Record<string, string>, request: Record<string, unknown>) => {
      const base = await keyPrincipal(key.id);
      assert.ok(base);
      const principal = withTrace(base, "/v1/chat/completions");
      principal.trace!.labels = headerLabels(new Headers(headers));
      return recordUsage({
        principal,
        model,
        deployment,
        usage: { prompt_tokens: 100, completion_tokens: 50 },
        status: 200,
        outcome: "ok",
        latencyMs: 20,
        request: { model, ...request },
      });
    };
    await send({ "X-LLMHub-Label-Cost-Center": "4711" }, { metadata: { env: "prod", team_secret: "x" } });
    await send({}, { tags: ["env:dev"] });
    await send({}, {});

    const rollup = await prisma.usageLabelDaily.findMany({ where: { model }, orderBy: [{ label: "asc" }, { value: "asc" }] });
    assert.deepEqual(
      rollup.map((row) => [row.label, row.value, row.requests, row.orgId, row.projectId, row.keyId]),
      [
        ["cost_center", "4711", 1, org.id, project.id, key.id],
        ["env", "dev", 1, org.id, project.id, key.id],
        ["env", "prod", 1, org.id, project.id, key.id],
      ],
    );
    const logs = await prisma.requestLog.findMany({ where: { model }, orderBy: { createdAt: "asc" } });
    assert.deepEqual(
      logs.map((row) => row.labels),
      [["cost_center:4711", "env:prod"], ["env:dev"], []],
    );

    const filtered = await runAsPrincipal(owner, () => loadLogs({ filters: { model, label: "env:prod" } }));
    assert.deepEqual(
      filtered.requests.map((row) => row.labels),
      [
        [
          { key: "cost_center", value: "4711" },
          { key: "env", value: "prod" },
        ],
      ],
    );

    const grouped = await runAsPrincipal(owner, () => loadUsage({ days: 1, model, labelKey: "env" }));
    assert.equal(grouped.count, 3);
    assert.ok(grouped.labelKeys.includes("env") && grouped.labelKeys.includes("cost_center"));
    assert.deepEqual(grouped.labelValues, ["dev", "prod"]);
    assert.deepEqual(grouped.byLabel.map((row) => [row.name, row.requests]).sort(), [["", 1], ["dev", 1], ["prod", 1]]);
    assert.deepEqual(grouped.chargeback.map((row) => chargebackParts(row.name).label).sort(), ["", "dev", "prod"]);

    const one = await runAsPrincipal(owner, () => loadUsage({ days: 1, model, labelKey: "env", labelValue: "prod" }));
    assert.equal(one.count, 1);
    assert.equal(one.tokens, 150);

    await runAsPrincipal(owner, () => savePlatformLabelKeys(["feature"]));
    await send({ "x-llmhub-labels": "env=prod,feature=search" }, {});
    const [latest] = await prisma.requestLog.findMany({ where: { model }, orderBy: { createdAt: "desc" }, take: 1 });
    assert.deepEqual(latest?.labels, ["feature:search"]);
  } finally {
    await prisma.usageLabelDaily.deleteMany({ where: { model } });
    await prisma.usageDaily.deleteMany({ where: { model } });
    await prisma.spendEvent.deleteMany({ where: { model } });
    await prisma.requestLog.deleteMany({ where: { model } });
    await restore();
    await data.cleanup();
  }
});
