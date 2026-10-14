import assert from "node:assert/strict";
import test from "node:test";
import { addressAllowed, checkServerUrl } from "@/lib/mcp/url-guard";
import { bindTools, isMcpToolName, MAX_TOOL_NAME_LENGTH, mcpToolName } from "@/lib/mcp/tool-names";
import { chainOf, effectiveServers, explainAccess } from "@/lib/mcp/resolve";
import type { Principal } from "@/types/gateway";
import type { McpAssignmentRule, McpAssignmentView, McpChain, McpServerPolicy, McpToolSpec } from "@/types/mcp";

const tool = (name: string): McpToolSpec => ({ name, title: "", description: "", inputSchema: { type: "object" } });

function server(id: string, change: Partial<McpServerPolicy> = {}): McpServerPolicy {
  return {
    id,
    name: id,
    global: false,
    enabled: true,
    toolsRestricted: false,
    allowedTools: [],
    tools: [tool("search"), tool("fetch"), tool("delete")],
    ...change,
  };
}

function rule(
  serverId: string,
  target: Partial<McpAssignmentRule>,
  mode: "allow" | "block" = "allow",
  blockedTools: string[] = [],
  blockedActions: string[] = [],
): McpAssignmentRule {
  return {
    serverId,
    orgId: null,
    teamId: null,
    projectId: null,
    memberId: null,
    keyId: null,
    mode,
    blockedTools,
    blockedActions,
    ...target,
  };
}

function acted(name: string, action?: McpToolSpec["action"]): McpToolSpec {
  return { ...tool(name), ...(action ? { action } : {}) };
}

const CHAIN: McpChain = { orgId: "org1", teamId: "team1", projectId: "", memberId: "mem1", keyId: "key1" };

function names(chain: McpChain, servers: McpServerPolicy[], rules: McpAssignmentRule[]): Record<string, string[]> {
  return Object.fromEntries(effectiveServers(servers, rules, chain).map((item) => [item.serverId, item.tools.map((t) => t.name)]));
}

test("allows inherit from the company down to the key and are unioned across levels", () => {
  const servers = [server("a"), server("b"), server("c")];
  const rules = [rule("a", { orgId: "org1" }), rule("b", { keyId: "key1" }), rule("c", { orgId: "other" })];
  assert.deepEqual(names(CHAIN, servers, rules), { a: ["search", "fetch", "delete"], b: ["search", "fetch", "delete"] });
});

test("a block anywhere in the chain removes the server or single tools", () => {
  const servers = [server("a"), server("b")];
  const rules = [
    rule("a", { orgId: "org1" }),
    rule("a", { memberId: "mem1" }, "block"),
    rule("b", { orgId: "org1" }, "allow", ["delete"]),
    rule("b", { teamId: "team1" }, "block", ["fetch"]),
  ];
  assert.deepEqual(names(CHAIN, servers, rules), { b: ["search"] });
  assert.deepEqual(names({ ...CHAIN, memberId: "mem2", teamId: "" }, servers, rules), {
    a: ["search", "fetch", "delete"],
    b: ["search", "fetch"],
  });
});

test("a tool-only block does not grant, global grants everyone, and disabled servers vanish", () => {
  const servers = [server("a"), server("g", { global: true }), server("off", { global: true, enabled: false })];
  const rules = [rule("a", { orgId: "org1" }, "block", ["delete"]), rule("g", { keyId: "key1" }, "block")];
  assert.deepEqual(names(CHAIN, servers, rules), {});
  assert.deepEqual(names({ ...CHAIN, keyId: "key2" }, servers, rules), { g: ["search", "fetch", "delete"] });
});

test("the server allowlist applies before assignment blocks, and empty tool lists drop the server", () => {
  const servers = [server("a", { global: true, toolsRestricted: true, allowedTools: ["search"] }), server("b", { global: true, tools: [] })];
  assert.deepEqual(names(CHAIN, servers, []), { a: ["search"] });
  assert.deepEqual(names(CHAIN, servers, [rule("a", { orgId: "org1" }, "allow", ["search"])]), {});
});

test("empty chain values never match empty assignment columns", () => {
  const rules = [rule("a", { projectId: "" })];
  assert.deepEqual(names(CHAIN, [server("a")], rules), {});
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

test("explainAccess names where access comes from", () => {
  const views: McpAssignmentView[] = [
    { scope: "org", id: "org1", label: "Acme", mode: "allow", blockedTools: [], blockedActions: [] },
    { scope: "team", id: "team1", label: "Sales", mode: "block", blockedTools: ["delete"], blockedActions: [] },
  ];
  const policy = server("a");
  const granted = explainAccess(policy, views, CHAIN);
  assert.equal(granted.state, "granted");
  assert.deepEqual(granted.grantedBy.map((v) => v.label), ["Acme"]);
  assert.deepEqual(granted.tools, ["search", "fetch"]);
  const blocked = explainAccess(
    policy,
    [...views, { scope: "key", id: "key1", label: "ci", mode: "block", blockedTools: [], blockedActions: [] }],
    CHAIN,
  );
  assert.equal(blocked.state, "blocked");
  assert.deepEqual(blocked.tools, []);
  assert.equal(explainAccess(policy, views, { ...CHAIN, orgId: "other", teamId: "" }).state, "none");
});

test("action blocks remove matching tools and leave the server available", () => {
  const pets = server("pets", {
    tools: [acted("list", "read"), acted("save", "write"), acted("remove", "delete"), acted("ping")],
  });
  const rules = [
    rule("pets", { orgId: "org1" }),
    rule("pets", { keyId: "key1" }, "allow", [], ["write", "delete"]),
  ];
  assert.deepEqual(names(CHAIN, [pets], rules), { pets: ["list", "ping"] });
  const deleteOnly = [rule("pets", { orgId: "org1" }), rule("pets", { keyId: "key1" }, "block", [], ["delete"])];
  assert.deepEqual(names(CHAIN, [pets], deleteOnly), { pets: ["list", "save", "ping"] });
  const explained = explainAccess(
    pets,
    [
      { scope: "org", id: "org1", label: "Acme", mode: "allow", blockedTools: [], blockedActions: [] },
      { scope: "key", id: "key1", label: "ci", mode: "block", blockedTools: [], blockedActions: ["delete"] },
    ],
    CHAIN,
  );
  assert.equal(explained.state, "granted");
  assert.deepEqual(explained.blockedActions, ["delete"]);
  assert.deepEqual(explained.blockedBy, []);
  assert.deepEqual(explained.tools, ["list", "save", "ping"]);
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
