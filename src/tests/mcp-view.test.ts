import assert from "node:assert/strict";
import test from "node:test";
import { ancestorRules, newRule } from "@/app/(app)/mcp/_components/access-view";
import { accessOf, enabledTools, inFilter, matchesQuery, serverFilterOf } from "@/app/(app)/mcp/_components/server-view";
import type { McpAssignmentView, McpRuleAccess, McpServerView, McpTargetOptions, McpToolSpec } from "@/types/mcp";

function tool(name: string, action?: McpToolSpec["action"]): McpToolSpec {
  return { name, title: "", description: "", inputSchema: {}, ...(action ? { action } : {}) };
}

function assignment(label: string, access: McpRuleAccess, scope: McpAssignmentView["scope"] = "org"): McpAssignmentView {
  return { scope, id: label, label, access, extraTools: [], blockedTools: [] };
}

function server(change: Partial<McpServerView>): McpServerView {
  return {
    name: "GitHub",
    description: "Code hosting",
    url: "https://mcp.example.com/mcp",
    status: "connected",
    enabled: true,
    tools: [tool("list_issues", "read"), tool("close_issue", "write"), tool("delete_repo", "delete")],
    toolsRestricted: false,
    allowedTools: [],
    assignments: [],
    ...change,
  } as McpServerView;
}

test("server filters read the status query and sort servers into views", () => {
  assert.equal(serverFilterOf("attention"), "attention");
  assert.equal(serverFilterOf("bogus"), "all");
  assert.equal(serverFilterOf(null), "all");
  assert.equal(inFilter(server({ status: "signin" }), "attention"), true);
  assert.equal(inFilter(server({ status: "error" }), "attention"), true);
  assert.equal(inFilter(server({ status: "connected" }), "attention"), false);
  assert.equal(inFilter(server({ enabled: false, status: "disabled" }), "disabled"), true);
  assert.equal(inFilter(server({}), "all"), true);
});

test("server search matches name, description, and URL", () => {
  assert.equal(matchesQuery(server({}), "git"), true);
  assert.equal(matchesQuery(server({}), "hosting"), true);
  assert.equal(matchesQuery(server({}), "example.com"), true);
  assert.equal(matchesQuery(server({}), "jira"), false);
});

test("enabledTools honours the server allowlist and accessOf counts granting and limiting rules", () => {
  assert.equal(enabledTools(server({})), 3);
  assert.equal(enabledTools(server({ toolsRestricted: true, allowedTools: ["list_issues"] })), 1);
  assert.deepEqual(
    accessOf(
      server({
        assignments: [assignment("Acme", "read"), assignment("Northwind", "all"), assignment("Test", "none"), assignment("Ops", "inherit")],
      }),
    ),
    { first: "Acme", allowed: 2, limits: 2 },
  );
  assert.deepEqual(accessOf(server({})), { first: "", allowed: 0, limits: 0 });
});

test("ancestorRules lists the rules above a target in chain order", () => {
  const none = { orgId: "", teamId: "", projectId: "", memberId: "" };
  const options: McpTargetOptions = {
    org: [{ ...none, id: "acme", label: "Acme", detail: "" }],
    team: [{ ...none, id: "sales", label: "Sales", detail: "Acme", orgId: "acme" }],
    project: [],
    member: [],
    key: [{ id: "k1", label: "ci", detail: "Acme", orgId: "acme", teamId: "sales", projectId: "", memberId: "" }],
  };
  const key = newRule("key", options.key[0]!, "all");
  const rules = [assignment("sales", "write", "team"), assignment("acme", "read"), assignment("other", "all"), key];
  assert.deepEqual(
    ancestorRules(key, rules, options).map((rule) => `${rule.scope}:${rule.access}`),
    ["org:read", "team:write"],
  );
  assert.deepEqual(ancestorRules(assignment("acme", "read"), rules, options), []);
  assert.deepEqual(key, { scope: "key", id: "k1", label: "ci", access: "all", extraTools: [], blockedTools: [] });
});
