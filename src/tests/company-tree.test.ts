import assert from "node:assert/strict";
import test from "node:test";
import {
  accessUsersOf,
  matchesKey,
  matchesMember,
  nodeActions,
  nodeIn,
  parseNodeRef,
  structureGroups,
  usageFilterOf,
} from "@/app/(app)/companies/_components/tree-model";
import {
  companyAlias,
  companyHref,
  companySlice,
  companyStatus,
  companyTabOf,
  legacyCompanyLink,
  matchesCompany,
} from "@/lib/tenancy/company-view";
import { logsHref } from "@/lib/gateway/request-logs/request-log-query";
import { usageHref } from "@/lib/usage/usage-query";
import { keyOptionsOf, keyPresetOf, withKey, withoutKey } from "@/app/(app)/companies/_components/key-model";
import { keyMenuActions } from "@/app/(app)/keys/_components/key-menu";
import type { VirtualKeyView } from "@/types/keys";
import type { BudgetView, CompanyRow, KeyNode, NodeRef, StructurePayload } from "@/types/structure";

function budget(maxBudget = 0, spend = 0): BudgetView {
  return {
    maxBudget,
    spend,
    budgetDuration: "",
    boost: 0,
    boosts: [],
    resetsAt: null,
    projectedMonth: 0,
    daysToExhaust: null,
    pctUsed: null,
  };
}

function key(id: string, alias: string, place: Partial<KeyNode>): KeyNode {
  return {
    id,
    alias,
    prefix: `sk-hub-${id}`,
    userId: "",
    orgId: "",
    teamId: "",
    projectId: "",
    memberId: "",
    blocked: false,
    paused: false,
    pausedUntil: "",
    budget: budget(),
    ...place,
  };
}

const structure: StructurePayload = {
  platformLabelKeys: [],
  orgs: [
    { id: "o1", alias: "Acme", budget: budget(1000), labelKeys: [] },
    { id: "o2", alias: "Beta", budget: budget(), labelKeys: [] },
  ],
  teams: [{ id: "t1", alias: "IT", orgId: "o1", rpmLimit: 0, tpmLimit: 0, budget: budget(500) }],
  projects: [
    { id: "p1", alias: "Support bot", orgId: "o1", teamId: "t1", owner: "", budget: budget() },
    { id: "p2", alias: "Website", orgId: "o1", teamId: "", owner: "", budget: budget() },
  ],
  members: [
    { id: "m1", alias: "Alex Example", email: "", orgId: "o1", teamId: "t1", blocked: false, logContent: true, budget: budget() },
    { id: "m2", alias: "Robin Sample", email: "", orgId: "o1", teamId: "", blocked: false, logContent: true, budget: budget() },
  ],
  users: [
    { id: "u1", alias: "operator", orgId: "o1", budget: budget() },
    { id: "u2", alias: "platform-admin", orgId: "", budget: budget() },
  ],
  keys: [
    key("k1", "deploy-bot", { orgId: "o1", teamId: "t1", projectId: "p1", userId: "u1" }),
    key("k2", "alex-laptop", { orgId: "o1", teamId: "t1", memberId: "m1", userId: "u1" }),
    key("k3", "ops-internal", { orgId: "o1", userId: "u1" }),
    key("k4", "platform-internal", { userId: "u2" }),
    key("k5", "robin-phone", { orgId: "o1", memberId: "m2", userId: "u1" }),
  ],
  thresholds: [50, 80, 100],
  companyId: "",
  canManage: true,
  canBudget: true,
  canSeeKeys: true,
  canManageKeys: true,
  canCreateKeys: true,
  canMcp: true,
  canSeeMcp: true,
  reports: [],
  canSeeReports: false,
  canReport: false,
  canSeeSettings: false,
  canSeeUsers: false,
  canSeeUsage: false,
  canSeePolicies: false,
  mailEnabled: false,
};

const ref = (value: string): NodeRef => {
  const parsed = parseNodeRef(value);
  assert.ok(parsed, value);
  return parsed;
};

const groups = (data: StructurePayload, query: string) =>
  structureGroups(data, query).map((group) => `${group.team?.id ?? "-"}:${group.projects.map((row) => row.id).join(",")}`);

test("node refs accept keys but not console users", () => {
  assert.deepEqual(parseNodeRef("key:k1"), { kind: "key", id: "k1" });
  assert.deepEqual(parseNodeRef("member:m1"), { kind: "member", id: "m1" });
  assert.equal(parseNodeRef("user:u1"), null);
  assert.equal(parseNodeRef("key:"), null);
  assert.equal(parseNodeRef(undefined), null);
});

test("departments list their projects and projects without a department come last", () => {
  assert.deepEqual(groups(structure, ""), ["t1:p1", "-:p2"]);
  assert.equal(structureGroups(structure, "")[0]?.members, 1);
  assert.deepEqual(groups({ ...structure, projects: [] }, ""), ["t1:"]);
});

test("a structure search keeps a matching department whole and filters projects elsewhere", () => {
  const research = { ...structure, teams: structure.teams.map((row) => ({ ...row, alias: "Research" })) };
  assert.deepEqual(groups(research, "research"), ["t1:p1"]);
  assert.deepEqual(groups(structure, "it"), ["t1:p1", "-:p2"]);
  assert.deepEqual(groups(structure, "website"), ["-:p2"]);
  assert.deepEqual(groups(structure, "SUPPORT"), ["t1:p1"]);
  assert.deepEqual(groups(structure, "nothing matches"), []);
  assert.deepEqual(
    groups({ ...structure, projects: [{ ...structure.projects[0]!, owner: "ops@example.com" }] }, "ops@"),
    ["t1:p1"],
  );
});

test("people and keys match by name, email, or key prefix", () => {
  const [alex, robin] = structure.members;
  assert.ok(alex && robin);
  assert.equal(matchesMember(alex, "alex"), true);
  assert.equal(matchesMember({ ...robin, email: "robin@example.com" }, "EXAMPLE.com"), true);
  assert.equal(matchesMember(robin, "alex"), false);
  const deploy = structure.keys[0];
  assert.ok(deploy);
  assert.equal(matchesKey(deploy, "deploy"), true);
  assert.equal(matchesKey(deploy, "sk-hub-k1"), true);
  assert.equal(matchesKey(deploy, "laptop"), false);
});

test("a focused row must exist in the loaded company", () => {
  assert.equal(nodeIn(structure, ref("team:t1")), true);
  assert.equal(nodeIn(structure, ref("member:m2")), true);
  assert.equal(nodeIn(structure, ref("key:k3")), true);
  assert.equal(nodeIn(structure, ref("project:elsewhere")), false);
  assert.equal(nodeIn(structure, ref("org:o1")), false);
  assert.equal(nodeIn(structure, null), false);
});

test("row menus offer only what the caller may do", () => {
  const all = { canManage: true, canBudget: true, canCreateKeys: true, canSeeUsage: true };
  assert.deepEqual(nodeActions("team", all, true), ["edit", "budget", "boost", "addProject", "usage", "delete"]);
  assert.deepEqual(nodeActions("project", all, false), ["edit", "budget", "createKey", "usage", "delete"]);
  assert.deepEqual(nodeActions("member", { ...all, canManage: false, canCreateKeys: false }, true), [
    "budget",
    "boost",
    "usage",
  ]);
  assert.deepEqual(
    nodeActions("member", { canManage: false, canBudget: false, canCreateKeys: false, canSeeUsage: false }, true),
    [],
  );
});

test("a company view holds only that company's rows", () => {
  const view = companySlice(structure, "o1");
  assert.ok(view);
  assert.deepEqual(view.orgs.map((row) => row.id), ["o1"]);
  assert.deepEqual(view.teams.map((row) => row.id), ["t1"]);
  assert.deepEqual(view.users.map((row) => row.id), ["u1"]);
  assert.deepEqual(view.keys.map((row) => row.id), ["k1", "k2", "k3", "k5"]);
  assert.deepEqual(companySlice(structure, "o2")?.projects, []);
  assert.equal(companySlice(structure, "missing"), null);
});

function companyRow(overrides: Partial<CompanyRow>): CompanyRow {
  return { id: "o1", alias: "Acme", budget: budget(), teams: 0, projects: 1, members: 0, keys: 0, ...overrides };
}

test("the directory status reads the budget first and then whether the company is set up", () => {
  assert.equal(companyStatus(companyRow({ budget: budget(100, 100) })), "exhausted");
  assert.equal(companyStatus(companyRow({ budget: budget(100, 85) })), "near");
  assert.equal(companyStatus(companyRow({ budget: budget(100, 10) })), "ok");
  assert.equal(companyStatus(companyRow({ projects: 0, members: 0 })), "empty");
  assert.equal(companyStatus(companyRow({ projects: 0, members: 2 })), "ok");
  assert.equal(matchesCompany(companyRow({}), "acm"), true);
  assert.equal(matchesCompany(companyRow({}), "beta"), false);
});

test("company links point at the detail route in the platform and at /companies in the company scope", () => {
  assert.equal(companyHref({ orgId: "o1", tab: null, node: null }, true), "/companies/o1");
  assert.equal(companyHref({ orgId: "o1", tab: "overview", node: null }, true), "/companies/o1");
  assert.equal(
    companyHref({ orgId: "o1", tab: "structure", node: { kind: "team", id: "t1" } }, true),
    "/companies/o1?tab=structure&node=team%3At1",
  );
  assert.equal(companyHref({ orgId: "o1", tab: "people", node: null }, false), "/companies?tab=people");
});

test("old ?node= links open the tab that now holds the row", () => {
  assert.equal(companyTabOf(ref("team:t1")), "structure");
  assert.equal(companyTabOf(ref("project:p1")), "structure");
  assert.equal(companyTabOf(ref("member:m1")), "people");
  assert.equal(companyTabOf(ref("key:k1")), "keys");
  assert.equal(companyTabOf(ref("org:o1")), null);
  assert.deepEqual(legacyCompanyLink(ref("project:p1"), "o1"), {
    orgId: "o1",
    tab: "structure",
    node: { kind: "project", id: "p1" },
  });
  assert.deepEqual(legacyCompanyLink(ref("org:o1"), "o1"), { orgId: "o1", tab: null, node: null });
});

test("old company and key node links redirect on the server", async () => {
  const { default: config } = await import("../../next.config");
  const redirects = (await config.redirects?.()) ?? [];
  const byNode = (kind: string) =>
    redirects.find(
      (rule) => rule.source === "/companies" && rule.has?.some((item) => item.type === "query" && item.value?.startsWith(`${kind}:`)),
    );
  assert.equal(byNode("org")?.destination, "/companies/:id");
  assert.equal(byNode("key")?.destination, "/keys/:id");
  const pattern = new RegExp(`^${byNode("org")?.has?.[0]?.value}$`);
  assert.equal(pattern.exec("org:cm1abc_X-2")?.groups?.id, "cm1abc_X-2");
  assert.equal(pattern.test("org:../x"), false);
  assert.equal(byNode("team"), undefined);
});

test("new keys from a project or person start with that binding", () => {
  assert.deepEqual(keyPresetOf(ref("project:p1")), { kind: "project", id: "p1" });
  assert.deepEqual(keyPresetOf(ref("member:m1")), { kind: "member", id: "m1" });
  assert.equal(keyPresetOf(ref("org:o1")), null);
  assert.equal(keyPresetOf(ref("team:t1")), null);
  assert.equal(keyPresetOf(ref("key:k1")), null);
  assert.equal(keyPresetOf(null), null);
});

test("key dialog options come from the structure and the loaded model choices", () => {
  const options = keyOptionsOf(structure, { models: ["gpt-x"], templates: [], canTemplates: true });
  assert.deepEqual(options.models, ["gpt-x"]);
  assert.equal(options.canTemplates, true);
  assert.equal(options.companyId, "");
  assert.deepEqual(options.orgs, [
    { id: "o1", alias: "Acme" },
    { id: "o2", alias: "Beta" },
  ]);
  assert.deepEqual(options.teams, [{ id: "t1", alias: "IT", orgId: "o1" }]);
  assert.deepEqual(options.members[0], { id: "m1", alias: "Alex Example", orgId: "o1", teamId: "t1" });
  assert.deepEqual(options.projects[1], { id: "p2", alias: "Website", orgId: "o1", teamId: "" });
});

function view(overrides: Partial<VirtualKeyView>): VirtualKeyView {
  return {
    token_id: "k9",
    key_name: "sk-hub-new",
    key_alias: "new-key",
    user_id: "u1",
    team_id: "",
    org_id: "o1",
    project_id: "p2",
    member_id: "",
    models: [],
    templates: [],
    max_budget: 0,
    spend: 0,
    rpm_limit: 0,
    tpm_limit: 0,
    max_request_cost: 0,
    budget_duration: "",
    expires: "",
    allowed_ips: [],
    allowed_endpoints: [],
    access_windows: [],
    access_time_zone: "UTC",
    blocked: false,
    paused: false,
    paused_until: "",
    log_content: true,
    created_at: "2026-10-01T00:00:00.000Z",
    ...overrides,
  };
}

test("saved keys update the structure without reloading it", () => {
  const created = withKey(structure, view({}));
  assert.deepEqual(
    created.keys.map((row) => row.id),
    ["k2", "k1", "k9", "k3", "k4", "k5"],
  );
  const added = created.keys.find((row) => row.id === "k9");
  assert.equal(added?.projectId, "p2");
  assert.equal(added?.budget.maxBudget, 0);

  const capped = { ...structure, keys: structure.keys.map((row) => (row.id === "k1" ? { ...row, budget: budget(25, 3) } : row)) };
  const updated = withKey(
    capped,
    view({ token_id: "k1", key_alias: "deploy-bot-2", key_name: "sk-hub-rot", blocked: true, project_id: "", member_id: "m2" }),
  );
  const changed = updated.keys.find((row) => row.id === "k1");
  assert.equal(changed?.alias, "deploy-bot-2");
  assert.equal(changed?.prefix, "sk-hub-rot");
  assert.equal(changed?.blocked, true);
  assert.equal(changed?.memberId, "m2");
  assert.equal(changed?.projectId, "");
  assert.deepEqual(changed?.budget, budget(25, 3));
  assert.equal(updated.keys.length, structure.keys.length);

  assert.deepEqual(
    withoutKey(structure, "k3").keys.map((row) => row.id),
    ["k1", "k2", "k4", "k5"],
  );
});

test("key row menus offer only what the caller may do", () => {
  const running = { capped: true, paused: false };
  assert.deepEqual(keyMenuActions({ canManage: true, canMcp: true, canBudget: true }, running), [
    "edit",
    "pause",
    "mcp",
    "budget",
    "boost",
    "rotate",
    "revoke",
  ]);
  assert.deepEqual(keyMenuActions({ canManage: true, canMcp: false, canBudget: true }, { capped: false, paused: true }), [
    "edit",
    "resume",
    "budget",
    "rotate",
    "revoke",
  ]);
  assert.deepEqual(keyMenuActions({ canManage: false, canMcp: true, canBudget: false }, { capped: true, paused: true }), [
    "mcp",
  ]);
  assert.deepEqual(keyMenuActions({ canManage: false, canMcp: false, canBudget: false }, running), []);
});

test("usage drill-downs filter by the selected node and drop the company filter in the company scope", () => {
  assert.equal(usageHref(usageFilterOf(ref("org:o1"), true)), "/usage?orgId=o1");
  assert.equal(usageHref(usageFilterOf(ref("org:o1"), false)), "/usage");
  assert.equal(usageHref(usageFilterOf(ref("team:t1"), true)), "/usage?teamId=t1");
  assert.equal(usageHref(usageFilterOf(ref("project:p1"), false)), "/usage?projectId=p1");
  assert.equal(usageHref(usageFilterOf(ref("member:m1"), true)), "/usage?memberId=m1");
  assert.equal(usageHref(usageFilterOf(ref("key:k1"), true)), "/usage?keyId=k1");
  assert.equal(logsHref({ keyId: "k1" }), "/logs?keyId=k1");
});

test("console users with company access are listed only for platform callers who may read users", () => {
  assert.equal(accessUsersOf(structure, "o1"), null);
  const reader = { ...structure, canSeeUsers: true };
  assert.deepEqual(accessUsersOf(reader, "o1")?.map((user) => user.id), ["u1"]);
  assert.deepEqual(accessUsersOf(reader, "o2"), []);
  assert.equal(accessUsersOf({ ...reader, companyId: "o1" }, "o1"), null);
});

test("loading screens name the company from the scope list or the current company scope", () => {
  const companies = [{ id: "o1", alias: "Acme" }];
  assert.equal(companyAlias({ scope: { kind: "platform" }, companies, canSwitch: true }, "o1"), "Acme");
  assert.equal(companyAlias({ scope: { kind: "platform" }, companies, canSwitch: true }, "o2"), undefined);
  assert.equal(
    companyAlias({ scope: { kind: "company", id: "o2", alias: "Beta" }, companies: [], canSwitch: false }, "o2"),
    "Beta",
  );
});
