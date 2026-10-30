import assert from "node:assert/strict";
import test from "node:test";
import { roleReach, toolMatches, withGrant } from "@/app/(app)/mcp/_components/role-view";
import { accessOf, enabledTools, inFilter, matchesQuery, serverFilterOf } from "@/app/(app)/mcp/_components/server-view";
import type { McpAssignmentView, McpRoleView, McpServerView, McpToolSpec } from "@/types/mcp";

function tool(name: string, action?: McpToolSpec["action"]): McpToolSpec {
  return { name, title: "", description: "", inputSchema: {}, ...(action ? { action } : {}) };
}

function assignment(label: string, mode: McpAssignmentView["mode"]): McpAssignmentView {
  return { scope: "org", id: label, label, mode, blockedTools: [], blockedActions: [], roleId: "", role: null };
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

const reader: McpRoleView = {
  id: "r",
  key: "reader",
  name: "Reader",
  description: "",
  builtin: true,
  assigned: 0,
  allActions: false,
  actions: ["read"],
  tools: [],
  deniedTools: [],
};

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

test("enabledTools honours the server allowlist and accessOf summarises the rules", () => {
  assert.equal(enabledTools(server({})), 3);
  assert.equal(enabledTools(server({ toolsRestricted: true, allowedTools: ["list_issues"] })), 1);
  assert.deepEqual(
    accessOf(server({ assignments: [assignment("Acme", "allow"), assignment("Northwind", "allow"), assignment("Test", "block")] })),
    { first: "Acme", allowed: 2, blocks: 1 },
  );
  assert.deepEqual(accessOf(server({})), { first: "", allowed: 0, blocks: 0 });
});

test("role helpers set single tool grants and count what a role reaches", () => {
  const tools = server({}).tools;
  assert.deepEqual(roleReach(reader, tools), { granted: 1, total: 3, exceptions: 0 });
  const allowed = { ...reader, ...withGrant(reader, "close_issue", "allow") };
  assert.deepEqual([allowed.tools, allowed.deniedTools], [["close_issue"], []]);
  const denied = { ...allowed, ...withGrant(allowed, "close_issue", "deny") };
  assert.deepEqual([denied.tools, denied.deniedTools], [[], ["close_issue"]]);
  assert.deepEqual(roleReach(allowed, tools), { granted: 2, total: 3, exceptions: 1 });
  const reset = { ...denied, ...withGrant(denied, "close_issue", "inherit") };
  assert.deepEqual([reset.tools, reset.deniedTools], [[], []]);
  assert.equal(toolMatches(tool("list_issues"), "issue"), true);
  assert.equal(toolMatches(tool("list_issues"), "repo"), false);
});
