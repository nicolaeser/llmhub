import assert from "node:assert/strict";
import { after, test } from "node:test";
import prisma from "@/lib/db/prisma";
import { runAsPrincipal } from "@/lib/auth/delegation";
import { permissions } from "@/lib/auth/permissions";
import { keyPrincipal } from "@/lib/gateway/access/principal";
import { resolvePolicies } from "@/lib/settings/enterprise";
import {
  loadCompanyPolicies,
  loadGuardrails,
  removePolicyOverride,
  savePolicyOverride,
} from "@/lib/settings/guardrail-policies";
import type { AuthenticatedSession } from "@/types/auth";
import type { GuardrailRule, PiiPolicy, PolicyLayer, PolicyScope } from "@/types/guardrails";
import { closeDatabase } from "./support/database";
import { sessionOf, TestData } from "./support/fixtures";

after(closeDatabase);

const BLOCK_EMAIL: PiiPolicy = {
  enabled: true,
  mode: "block",
  output: false,
  entities: ["EMAIL_ADDRESS"],
  detector: "patterns",
  failure: "patterns",
};

function rule(name: string): GuardrailRule {
  return { id: name, name, kind: "denylist", target: "input", action: "block", patterns: [name], caseSensitive: false };
}

function saver(session: AuthenticatedSession) {
  return (scope: PolicyScope, id: string, sections: Partial<PolicyLayer>) =>
    runAsPrincipal(session, () =>
      savePolicyOverride({ scope, id, pii: null, injection: null, secrets: null, rules: null, ...sections }),
    );
}

test("each part is inherited on its own along key, project, department, and company", async () => {
  const data = new TestData();
  try {
    const org = await data.org();
    const team = await data.team(org.id);
    const project = await data.project(org.id, team.id);
    const key = await data.key({ projectId: project.id, orgId: org.id });
    const admin = sessionOf(await data.user(), { owner: true, permissions: [...permissions] });
    const save = saver(admin);

    await save("org", org.id, { pii: BLOCK_EMAIL, rules: [rule("company")] });
    await save("team", team.id, { rules: [rule("department")] });
    const saved = await save("key", key.id, { injection: { enabled: true, action: "block", checks: [] } });
    assert.deepEqual(saved.override?.target.path, [org.alias, team.alias, project.alias]);
    assert.equal(saved.override?.pii, null);

    const principal = await keyPrincipal(key.id);
    assert.ok(principal);
    const resolved = await resolvePolicies(principal);
    assert.equal(resolved.pii.mode, "block");
    assert.deepEqual(resolved.guardrails.rules.map((row) => row.name), ["department"]);
    assert.equal(resolved.guardrails.injection.enabled, true);

    const view = await runAsPrincipal(admin, () => loadGuardrails());
    const ids = new Set([org.id, team.id, key.id]);
    assert.equal(view.overrides.filter((row) => ids.has(row.target.id)).length, 3);
    const target = view.targets.find((row) => row.scope === "key" && row.id === key.id);
    assert.deepEqual([target?.orgId, target?.teamId, target?.projectId], [org.id, team.id, project.id]);

    await runAsPrincipal(admin, () => removePolicyOverride({ scope: "team", id: team.id }));
    assert.equal(await prisma.policyOverride.count({ where: { teamId: team.id } }), 0);
    const fallback = await resolvePolicies((await keyPrincipal(key.id))!);
    assert.deepEqual(fallback.guardrails.rules.map((row) => row.name), ["company"]);

    const company = await runAsPrincipal(admin, () => loadCompanyPolicies(org.id));
    assert.deepEqual(
      company.sections.map((row) => [row.section, row.level]),
      [
        ["pii", "org"],
        ["injection", "global"],
        ["secrets", "global"],
        ["rules", "org"],
      ],
    );
    assert.deepEqual(
      company.overrides.map((row) => [row.scope, row.id, row.sections.map((entry) => entry.section)]),
      [["key", key.id, ["injection"]]],
    );

    await save("key", key.id, {});
    assert.equal(await prisma.policyOverride.count({ where: { keyId: key.id } }), 0);
    await save("key", key.id, { rules: [] });
    await prisma.virtualKey.delete({ where: { id: key.id } });
    assert.equal(await prisma.policyOverride.count({ where: { keyId: key.id } }), 0);
  } finally {
    await data.cleanup();
  }
});

test("the company scope edits only that company's overrides", async () => {
  const data = new TestData();
  try {
    const own = await data.org();
    const other = await data.org();
    const otherTeam = await data.team(other.id);
    const owner = sessionOf(await data.user(), { owner: true, permissions: [...permissions] });
    const admin = { ...owner, workspaceOrgId: own.id };
    const save = saver(admin);
    await assert.rejects(save("org", other.id, { pii: BLOCK_EMAIL }), /NOT_FOUND/);
    await assert.rejects(save("team", otherTeam.id, { pii: BLOCK_EMAIL }), /NOT_FOUND/);
    const leaked = await prisma.policyOverride.count({ where: { OR: [{ orgId: other.id }, { teamId: otherTeam.id }] } });
    assert.equal(leaked, 0);

    await save("org", own.id, { pii: BLOCK_EMAIL });
    const view = await runAsPrincipal(admin, () => loadGuardrails());
    assert.equal(view.platform, false);
    assert.deepEqual(
      view.overrides.map((row) => [row.target.scope, row.target.id]),
      [["org", own.id]],
    );
  } finally {
    await data.cleanup();
  }
});
