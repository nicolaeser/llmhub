import assert from "node:assert/strict";
import test from "node:test";
import { addressAllowed, checkServerUrl } from "@/lib/mcp/url-guard";
import { bindTools, isMcpToolName, MAX_TOOL_NAME_LENGTH, mcpToolName } from "@/lib/mcp/tool-names";
import {
  ceilingOf,
  chainOf,
  classifyTools,
  cleanGrant,
  defaultAccessOf,
  effectiveServers,
  explainAccess,
  grantAllows,
  toolActionsOf,
  withToolVisible,
} from "@/lib/mcp/resolve";
import type { Principal } from "@/types/gateway";
import type { McpAccessGrant, McpAssignmentRule, McpAssignmentView, McpChain, McpRuleAccess, McpServerPolicy, McpToolSpec } from "@/types/mcp";

const tool = (name: string): McpToolSpec => ({ name, title: "", description: "", inputSchema: { type: "object" } });

function acted(name: string, action?: McpToolSpec["action"]): McpToolSpec {
  return { ...tool(name), ...(action ? { action } : {}) };
}

const PET_TOOLS = [acted("list", "read"), acted("save", "write"), acted("remove", "delete"), acted("ping")];

function server(id: string, change: Partial<McpServerPolicy> = {}): McpServerPolicy {
  return {
    id,
    name: id,
    defaultAccess: "none",
    enabled: true,
    toolsRestricted: false,
    allowedTools: [],
    tools: PET_TOOLS,
    ...change,
  };
}

function rule(
  serverId: string,
  target: Partial<McpAssignmentRule>,
  access: McpRuleAccess,
  exceptions: Partial<Pick<McpAccessGrant, "extraTools" | "blockedTools">> = {},
): McpAssignmentRule {
  return {
    serverId,
    orgId: null,
    teamId: null,
    projectId: null,
    memberId: null,
    keyId: null,
    access,
    extraTools: [],
    blockedTools: [],
    ...exceptions,
    ...target,
  };
}

function view(scope: McpAssignmentView["scope"], id: string, access: McpRuleAccess, extra: Partial<McpAccessGrant> = {}): McpAssignmentView {
  return { scope, id, label: id, access, extraTools: [], blockedTools: [], ...extra };
}

const CHAIN: McpChain = { orgId: "org1", teamId: "team1", projectId: "", memberId: "mem1", keyId: "key1" };

function names(chain: McpChain, servers: McpServerPolicy[], rules: McpAssignmentRule[]): Record<string, string[]> {
  return Object.fromEntries(effectiveServers(servers, rules, chain).map((item) => [item.serverId, item.tools.map((t) => t.name)]));
}

test("each level grants the tools of its actions, and Everything adds delete and unclassified tools", () => {
  const pets = [server("pets")];
  const at = (access: McpRuleAccess) => names(CHAIN, pets, [rule("pets", { orgId: "org1" }, access)]).pets ?? [];
  assert.deepEqual(at("read"), ["list"]);
  assert.deepEqual(at("write"), ["list", "save"]);
  assert.deepEqual(at("all"), ["list", "save", "remove", "ping"]);
  assert.deepEqual(at("none"), []);
  assert.deepEqual(at("inherit"), []);
});

test("a level reaches everything below it and lower levels can only narrow it", () => {
  const pets = [server("pets")];
  assert.deepEqual(
    names(CHAIN, pets, [rule("pets", { orgId: "org1" }, "read"), rule("pets", { keyId: "key1" }, "all")]),
    { pets: ["list"] },
  );
  assert.deepEqual(
    names(CHAIN, pets, [rule("pets", { orgId: "org1" }, "all"), rule("pets", { keyId: "key1" }, "read")]),
    { pets: ["list"] },
  );
  assert.deepEqual(
    names(CHAIN, pets, [rule("pets", { orgId: "org1" }, "write"), rule("pets", { teamId: "team1" }, "none")]),
    {},
  );
  assert.deepEqual(
    names({ ...CHAIN, teamId: "team2" }, pets, [rule("pets", { orgId: "org1" }, "write"), rule("pets", { teamId: "team1" }, "none")]),
    { pets: ["list", "save"] },
  );
  assert.deepEqual(names(CHAIN, pets, [rule("pets", { orgId: "other" }, "all")]), {});
});

test("tool exceptions add or hide single tools, and a hide anywhere wins", () => {
  const pets = [server("pets")];
  assert.deepEqual(
    names(CHAIN, pets, [rule("pets", { orgId: "org1" }, "read", { extraTools: ["save"] })]),
    { pets: ["list", "save"] },
  );
  assert.deepEqual(
    names(CHAIN, pets, [rule("pets", { orgId: "org1" }, "write", { blockedTools: ["list"] })]),
    { pets: ["save"] },
  );
  assert.deepEqual(
    names(CHAIN, pets, [rule("pets", { orgId: "org1" }, "read"), rule("pets", { keyId: "key1" }, "read", { extraTools: ["save"] })]),
    { pets: ["list"] },
  );
  assert.deepEqual(
    names(CHAIN, pets, [rule("pets", { orgId: "org1" }, "all"), rule("pets", { keyId: "key1" }, "inherit", { blockedTools: ["remove"] })]),
    { pets: ["list", "save", "ping"] },
  );
  assert.deepEqual(
    names(CHAIN, pets, [rule("pets", { keyId: "key1" }, "none", { extraTools: ["ping"] })]),
    { pets: ["ping"] },
  );
});

test("the default applies only where no level is set, and disabled or empty servers vanish", () => {
  const open = server("open", { defaultAccess: "read" });
  assert.deepEqual(names(CHAIN, [open], []), { open: ["list"] });
  assert.deepEqual(names(CHAIN, [open], [rule("open", { orgId: "org1" }, "all")]), { open: ["list", "save", "remove", "ping"] });
  assert.deepEqual(names(CHAIN, [open], [rule("open", { keyId: "key1" }, "none")]), {});
  assert.deepEqual(names(CHAIN, [open], [rule("open", { orgId: "org1" }, "inherit", { blockedTools: ["list"] })]), {});
  assert.deepEqual(names(CHAIN, [server("off", { defaultAccess: "all", enabled: false })], []), {});
  assert.deepEqual(names(CHAIN, [server("empty", { defaultAccess: "all", tools: [] })], []), {});
  assert.deepEqual(
    names(CHAIN, [server("a", { defaultAccess: "all", toolsRestricted: true, allowedTools: ["list", "remove"] })], []),
    { a: ["list", "remove"] },
  );
  assert.equal(defaultAccessOf({ global: false, globalAccess: "read" }), "none");
  assert.equal(defaultAccessOf({ global: true, globalAccess: "read" }), "read");
  assert.equal(defaultAccessOf({ global: true, globalAccess: "bogus" }), "all");
});

test("empty chain values never match empty assignment columns", () => {
  assert.deepEqual(names(CHAIN, [server("a")], [rule("a", { projectId: "" }, "all")]), {});
});

test("chainOf reads the principal's key tenancy", () => {
  const principal = {
    actor: "k",
    teamId: "t",
    orgId: "o",
    userId: "",
    memberId: "",
    models: [],
    routeLimits: {},
    key: { token_id: "key", project_id: "p" },
  } as unknown as Principal;
  assert.deepEqual(chainOf(principal), { orgId: "o", teamId: "t", projectId: "p", memberId: "", keyId: "key" });
});

test("explainAccess names the effective level, the path, and the rule that limits it", () => {
  const pets = server("pets", { defaultAccess: "all" });
  const views = [view("key", "key1", "all"), view("org", "org1", "write"), view("team", "team1", "read")];
  const explained = explainAccess(pets, views, CHAIN);
  assert.equal(explained.state, "granted");
  assert.equal(explained.level, "read");
  assert.deepEqual(explained.steps.map((step) => step.scope), ["org", "team", "key"]);
  assert.deepEqual(explained.limitedBy, { kind: "rule", rule: views[2] });
  assert.equal(explained.usesDefault, false);
  assert.deepEqual(explained.tools, ["list"]);
  const fallback = explainAccess(pets, [], CHAIN);
  assert.deepEqual([fallback.state, fallback.level, fallback.limitedBy, fallback.usesDefault], ["granted", "all", { kind: "default" }, true]);
  const blocked = explainAccess(pets, [view("org", "org1", "all"), view("member", "mem1", "none")], CHAIN);
  assert.deepEqual([blocked.state, blocked.tools], ["blocked", []]);
  assert.equal(explainAccess(server("closed"), [view("org", "other", "all")], CHAIN).state, "none");
});

test("ceilingOf reports what the levels above allow", () => {
  const pets = server("pets", { defaultAccess: "all" });
  const capped = ceilingOf(pets, [view("org", "org1", "read", { extraTools: ["save"] })]);
  assert.equal(capped.level, "read");
  assert.equal(capped.allows(acted("save", "write")), true);
  assert.equal(capped.allows(acted("remove", "delete")), false);
  const open = ceilingOf(pets, [view("org", "org1", "inherit", { blockedTools: ["ping"] })]);
  assert.equal(open.level, null);
  assert.equal(open.allows(acted("remove", "delete")), true);
  assert.equal(open.allows(acted("ping")), false);
});

test("tool switches record exceptions relative to the level, and cleanGrant drops meaningless parts", () => {
  const read: McpAccessGrant = { access: "read", extraTools: [], blockedTools: [] };
  const added = { ...read, ...withToolVisible(read, acted("save", "write"), true) };
  assert.deepEqual(added, { access: "read", extraTools: ["save"], blockedTools: [] });
  assert.equal(grantAllows(added, acted("save", "write")), true);
  const hidden = { ...added, ...withToolVisible(added, acted("list", "read"), false) };
  assert.deepEqual(hidden, { access: "read", extraTools: ["save"], blockedTools: ["list"] });
  assert.deepEqual({ ...hidden, ...withToolVisible(hidden, acted("save", "write"), false) }.extraTools, []);
  const inherit: McpAccessGrant = { access: "inherit", extraTools: [], blockedTools: [] };
  assert.deepEqual(withToolVisible(inherit, acted("save", "write"), true), { extraTools: [], blockedTools: [] });
  assert.equal(cleanGrant(inherit), null);
  assert.deepEqual(cleanGrant({ access: "inherit", extraTools: ["x"], blockedTools: ["y", "y"] }), {
    access: "inherit",
    extraTools: [],
    blockedTools: ["y"],
  });
  assert.deepEqual(cleanGrant({ access: "all", extraTools: ["x"], blockedTools: ["gone"] }, new Set(["x"])), {
    access: "all",
    extraTools: [],
    blockedTools: [],
  });
  assert.deepEqual(cleanGrant({ access: "none", extraTools: ["x"], blockedTools: ["x"] }), {
    access: "none",
    extraTools: ["x"],
    blockedTools: [],
  });
});

test("operator classification decides which tools a level reaches", () => {
  const remote = [tool("issues_list"), tool("issue_close"), { ...tool("repo_delete"), hint: "read" as const }];
  const read: McpAccessGrant = { access: "read", extraTools: [], blockedTools: [] };
  assert.deepEqual(remote.filter((item) => grantAllows(read, item)).map((item) => item.name), []);
  const actions = toolActionsOf({ issues_list: "read", issue_close: "write", repo_delete: "delete", junk: "admin", other: 3 });
  assert.deepEqual(actions, { issues_list: "read", issue_close: "write", repo_delete: "delete" });
  const classified = classifyTools(remote, actions);
  assert.deepEqual(classified.filter((item) => grantAllows(read, item)).map((item) => item.name), ["issues_list"]);
  assert.deepEqual(
    classified.filter((item) => grantAllows({ ...read, access: "write" }, item)).map((item) => item.name),
    ["issues_list", "issue_close"],
  );
  const hosted = [acted("pets_list", "read")];
  assert.deepEqual(classifyTools(hosted, { pets_list: "delete" })[0]?.action, "delete");
  assert.deepEqual(classifyTools(hosted, {})[0]?.action, "read");
  assert.deepEqual(toolActionsOf(null), {});
  assert.deepEqual(toolActionsOf(["read"]), {});
});

test("tool names are namespaced, valid for providers, and unique", () => {
  assert.equal(mcpToolName("GitHub", "search_issues"), "mcp__GitHub__search_issues");
  assert.ok(isMcpToolName("mcp__a__b"));
  const odd = mcpToolName("Jira Cloud (EU)", "issue.search");
  assert.match(odd, /^mcp__Jira_Cloud_EU__issue_search_[0-9a-f]{8}$/);
  const long = mcpToolName("a-very-long-server-name-indeed", "x".repeat(100));
  assert.ok(long.length <= MAX_TOOL_NAME_LENGTH);
  assert.match(long, /^[A-Za-z0-9_-]+$/);
  assert.notEqual(mcpToolName("s", "a.b"), mcpToolName("s", "a_b"));

  const bound = bindTools(
    [
      { serverId: "1", serverName: "dup", tools: [tool("t")] },
      { serverId: "2", serverName: "dup", tools: [tool("t")] },
    ],
    ["mcp__caller__x"],
  );
  assert.equal(bound.length, 2);
  assert.notEqual(bound[0]!.name, bound[1]!.name);
  const shadowed = bindTools([{ serverId: "1", serverName: "caller", tools: [tool("x")] }], ["mcp__caller__x"]);
  assert.notEqual(shadowed[0]!.name, "mcp__caller__x");
  const many = bindTools([{ serverId: "1", serverName: "s", tools: Array.from({ length: 200 }, (_, i) => tool(`t${i}`)) }]);
  assert.equal(many.length, 128);
});

test("server URLs must be https unless internal, and metadata addresses are always blocked", () => {
  assert.equal(checkServerUrl("https://mcp.example.com/mcp", false).ok, true);
  const verdict = (url: string, internal = false) => {
    const result = checkServerUrl(url, internal);
    return result.ok ? "ok" : result.code;
  };
  assert.equal(verdict("http://mcp.example.com/mcp"), "MCP_URL_INSECURE");
  assert.equal(verdict("http://mcp.example.com/mcp", true), "ok");
  assert.equal(verdict("ftp://mcp.example.com"), "MCP_URL_INVALID");
  assert.equal(verdict("https://user:pw@mcp.example.com"), "MCP_URL_INVALID");
  assert.equal(verdict("not a url"), "MCP_URL_INVALID");
  assert.equal(verdict("https://127.0.0.1/mcp"), "MCP_URL_BLOCKED");
  assert.equal(verdict("https://127.0.0.1/mcp", true), "ok");
  assert.equal(verdict("https://localhost/mcp"), "MCP_URL_BLOCKED");
  assert.equal(verdict("https://localhost/mcp", true), "ok");
  assert.equal(verdict("https://10.1.2.3/"), "MCP_URL_BLOCKED");
  assert.equal(verdict("https://169.254.169.254/latest", true), "MCP_URL_BLOCKED");
  assert.equal(verdict("http://169.254.169.254/latest", true), "MCP_URL_BLOCKED");
  assert.equal(verdict("https://[fd00:ec2::254]/", true), "MCP_URL_BLOCKED");
  assert.equal(verdict("https://[::ffff:169.254.169.254]/", true), "MCP_URL_BLOCKED");
  assert.equal(verdict("https://[::ffff:10.0.0.1]/"), "MCP_URL_BLOCKED");
  assert.equal(verdict("https://metadata.google.internal/", true), "MCP_URL_BLOCKED");
  assert.equal(verdict("https://0.0.0.0/", true), "MCP_URL_BLOCKED");
});

test("resolved addresses are checked against the same rules", () => {
  assert.equal(addressAllowed("93.184.216.34", false), true);
  assert.equal(addressAllowed("192.168.1.5", false), false);
  assert.equal(addressAllowed("192.168.1.5", true), true);
  assert.equal(addressAllowed("169.254.10.10", true), false);
  assert.equal(addressAllowed("fe80::1", true), false);
  assert.equal(addressAllowed("::1", false), false);
  assert.equal(addressAllowed("::ffff:7f00:1", false), false);
  assert.equal(addressAllowed("::ffff:a9fe:a9fe", true), false);
  assert.equal(addressAllowed("2606:4700::1111", false), true);
  assert.equal(addressAllowed("garbage", true), false);
});
