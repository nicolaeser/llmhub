import assert from "node:assert/strict";
import test from "node:test";
import { legacyColumns, legacyGrant, type LegacyRole } from "@/lib/mcp/legacy-access";
import { grantAllows } from "@/lib/mcp/resolve";
import type { McpToolSpec } from "@/types/mcp";

function acted(name: string, action?: McpToolSpec["action"]): McpToolSpec {
  return { name, title: "", description: "", inputSchema: {}, ...(action ? { action } : {}) };
}

const TOOLS = [acted("list", "read"), acted("save", "write"), acted("remove", "delete"), acted("ping")];

const reader: LegacyRole = { allActions: false, actions: ["read"], tools: [], deniedTools: [] };
const operator: LegacyRole = { allActions: false, actions: ["read", "write"], tools: [], deniedTools: [] };
const admin: LegacyRole = { allActions: true, actions: [], tools: [], deniedTools: [] };

function reached(grant: ReturnType<typeof legacyGrant>): string[] {
  return grant ? TOOLS.filter((tool) => grantAllows(grant, tool)).map((tool) => tool.name) : [];
}

test("built-in roles become the matching level without exceptions", () => {
  assert.deepEqual(legacyGrant({ mode: "allow", blockedTools: [], blockedActions: [], role: reader }, TOOLS), {
    access: "read",
    extraTools: [],
    blockedTools: [],
  });
  assert.equal(legacyGrant({ mode: "allow", blockedTools: [], blockedActions: [], role: operator }, TOOLS)?.access, "write");
  assert.equal(legacyGrant({ mode: "allow", blockedTools: [], blockedActions: [], role: admin }, TOOLS)?.access, "all");
  assert.equal(legacyGrant({ mode: "allow", blockedTools: [], blockedActions: [], role: null }, TOOLS)?.access, "all");
});

test("custom roles and action blocks keep exactly the tools they reached", () => {
  const custom = { ...reader, tools: ["remove"], deniedTools: ["list"] };
  const converted = legacyGrant({ mode: "allow", blockedTools: [], blockedActions: [], role: custom }, TOOLS);
  assert.deepEqual(converted, { access: "read", extraTools: ["remove"], blockedTools: ["list"] });
  assert.deepEqual(reached(converted), ["remove"]);
  const noDelete = legacyGrant({ mode: "allow", blockedTools: ["save"], blockedActions: ["delete"], role: null }, TOOLS);
  assert.deepEqual(noDelete, { access: "write", extraTools: ["ping"], blockedTools: ["save"] });
  assert.deepEqual(reached(noDelete), ["list", "ping"]);
  const writeOnly = legacyGrant({ mode: "allow", blockedTools: [], blockedActions: [], role: { ...reader, actions: ["write"] } }, TOOLS);
  assert.deepEqual(writeOnly, { access: "none", extraTools: ["save"], blockedTools: [] });
});

test("blocks become no access or hidden tools", () => {
  assert.deepEqual(legacyGrant({ mode: "block", blockedTools: [], blockedActions: [], role: null }, TOOLS), {
    access: "none",
    extraTools: [],
    blockedTools: [],
  });
  assert.deepEqual(legacyGrant({ mode: "block", blockedTools: ["ping"], blockedActions: ["delete"], role: null }, TOOLS), {
    access: "inherit",
    extraTools: [],
    blockedTools: ["ping", "remove"],
  });
  assert.equal(legacyGrant({ mode: "block", blockedTools: [], blockedActions: ["delete"], role: null }, [acted("list", "read")]), null);
});

test("new rows keep old images from granting more than the level", () => {
  assert.deepEqual(legacyColumns({ access: "none", extraTools: [], blockedTools: [] }), { mode: "block", blockedActions: [], roleId: null });
  assert.deepEqual(legacyColumns({ access: "inherit", extraTools: [], blockedTools: ["x"] }), { mode: "block", blockedActions: [], roleId: null });
  assert.deepEqual(legacyColumns({ access: "read", extraTools: [], blockedTools: [] }), {
    mode: "allow",
    blockedActions: ["write", "delete"],
    roleId: null,
  });
  assert.deepEqual(legacyColumns({ access: "write", extraTools: [], blockedTools: [] }).blockedActions, ["delete"]);
  assert.deepEqual(legacyColumns({ access: "all", extraTools: [], blockedTools: [] }).blockedActions, []);
});
