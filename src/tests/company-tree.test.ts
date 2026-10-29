import assert from "node:assert/strict";
import test from "node:test";
import {
  accessUsersOf,
  nodeExists,
  nodeKey,
  nodePath,
  parentOf,
  parseNodeRef,
  treeHighlight,
  treeRows,
  usageFilterOf,
} from "@/app/(app)/companies/_components/tree-model";
import { logsHref } from "@/lib/gateway/request-logs/request-log-query";
import { usageHref } from "@/lib/usage/usage-query";
import { keyOptionsOf, keyPresetOf, withKey, withoutKey } from "@/app/(app)/companies/_components/key-model";
import { keyMenuActions } from "@/components/keys/key-menu";
import type { VirtualKeyView } from "@/types/keys";
import type { BudgetView, KeyNode, NodeRef, StructurePayload } from "@/types/structure";

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

const shape = (rows: ReturnType<typeof treeRows>) => rows.map((row) => `${row.depth}:${nodeKey(row)}`);

test("node refs accept keys but not console users", () => {
  assert.deepEqual(parseNodeRef("key:k1"), { kind: "key", id: "k1" });
  assert.deepEqual(parseNodeRef("member:m1"), { kind: "member", id: "m1" });
  assert.equal(parseNodeRef("user:u1"), null);
  assert.equal(parseNodeRef("key:"), null);
  assert.equal(parseNodeRef(undefined), null);
});

test("a key's path runs from its company through department and project or person to the key", () => {
  const path = (value: string) => nodePath(structure, ref(value)).map((link) => `${nodeKey(link)}=${link.alias}`);
  assert.deepEqual(path("key:k1"), ["org:o1=Acme", "team:t1=IT", "project:p1=Support bot", "key:k1=deploy-bot"]);
  assert.deepEqual(path("key:k2"), ["org:o1=Acme", "team:t1=IT", "member:m1=Alex Example", "key:k2=alex-laptop"]);
  assert.deepEqual(path("key:k3"), ["org:o1=Acme", "key:k3=ops-internal"]);
  assert.deepEqual(path("key:k5"), ["org:o1=Acme", "member:m2=Robin Sample", "key:k5=robin-phone"]);
  assert.deepEqual(path("member:m1"), ["org:o1=Acme", "team:t1=IT", "member:m1=Alex Example"]);
  assert.deepEqual(path("team:t1"), ["org:o1=Acme", "team:t1=IT"]);
  assert.deepEqual(path("key:missing"), []);
});

test("only keys of a company in scope open as nodes", () => {
  assert.equal(nodeExists(structure, ref("key:k1")), true);
  assert.equal(nodeExists(structure, ref("key:k3")), true);
  assert.equal(nodeExists(structure, ref("key:k4")), false);
  assert.equal(nodeExists(structure, ref("key:unknown")), false);
  assert.equal(nodeExists(structure, ref("member:m2")), true);
  assert.equal(nodeExists(structure, ref("project:elsewhere")), false);
  assert.equal(nodeExists({ ...structure, keys: [] }, ref("key:k1")), false);
});

test("the parent of a key is its project or person, else its company", () => {
  assert.deepEqual(parentOf(structure, ref("key:k1")), { kind: "project", id: "p1" });
  assert.deepEqual(parentOf(structure, ref("key:k2")), { kind: "member", id: "m1" });
  assert.deepEqual(parentOf(structure, ref("key:k3")), { kind: "org", id: "o1" });
  assert.deepEqual(parentOf(structure, ref("member:m1")), { kind: "team", id: "t1" });
  assert.equal(parentOf(structure, ref("org:o1")), null);
});

test("the unfiltered tree lists companies, departments, and projects only", () => {
  assert.deepEqual(shape(treeRows(structure, "")), [
    "0:org:o1",
    "1:team:t1",
    "2:project:p1",
    "1:project:p2",
    "0:org:o2",
  ]);
});

test("a filter also shows matching people and keys under their place", () => {
  assert.deepEqual(shape(treeRows(structure, "alex")), ["0:org:o1", "1:team:t1", "2:member:m1", "3:key:k2"]);
  assert.deepEqual(shape(treeRows(structure, "deploy")), ["0:org:o1", "1:team:t1", "2:project:p1", "3:key:k1"]);
  assert.deepEqual(shape(treeRows(structure, "robin")), ["0:org:o1", "1:member:m2", "2:key:k5"]);
  assert.deepEqual(shape(treeRows(structure, "internal")), ["0:org:o1", "1:key:k3"]);
  assert.deepEqual(shape(treeRows(structure, "sk-hub-k2")), ["0:org:o1", "1:team:t1", "2:member:m1", "3:key:k2"]);
  assert.deepEqual(shape(treeRows(structure, "beta")), ["0:org:o2"]);
  assert.deepEqual(shape(treeRows(structure, "nothing matches")), []);
});

test("a selected person or key highlights its nearest row in the tree", () => {
  const rows = treeRows(structure, "");
  assert.deepEqual(treeHighlight(structure, ref("member:m1"), rows), { key: "team:t1", exact: false });
  assert.deepEqual(treeHighlight(structure, ref("member:m2"), rows), { key: "org:o1", exact: false });
  assert.deepEqual(treeHighlight(structure, ref("key:k1"), rows), { key: "project:p1", exact: false });
  assert.deepEqual(treeHighlight(structure, ref("key:k2"), rows), { key: "team:t1", exact: false });
  assert.deepEqual(treeHighlight(structure, ref("key:k3"), rows), { key: "org:o1", exact: false });
  assert.deepEqual(treeHighlight(structure, ref("project:p2"), rows), { key: "project:p2", exact: true });
  assert.equal(treeHighlight(structure, null, rows), null);
  const filtered = treeRows(structure, "alex");
  assert.deepEqual(treeHighlight(structure, ref("member:m1"), filtered), { key: "member:m1", exact: true });
  assert.deepEqual(treeHighlight(structure, ref("key:k2"), filtered), { key: "key:k2", exact: true });
  assert.deepEqual(treeHighlight(structure, ref("project:p2"), filtered), { key: "org:o1", exact: false });
  assert.equal(treeHighlight(structure, ref("org:o2"), filtered), null);
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
