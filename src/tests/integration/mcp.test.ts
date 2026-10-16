import assert from "node:assert/strict";
import { after, test } from "node:test";
import prisma from "@/lib/db/prisma";
import { runAsPrincipal } from "@/lib/auth/delegation";
import { ensureMcpRoles, saveMcpPermissions } from "@/lib/mcp/catalog";
import { createMcpServer, deleteMcpServer, loadMcpServerList, saveMcpAssignments } from "@/lib/mcp/servers";
import { loadMcpServers } from "@/lib/mcp/toolset";
import { closeDatabase, ownerSession, uniqueName } from "./support/database";

after(closeDatabase);

const TOOLS = ["search", "fetch", "delete"].map((name) => ({
  name,
  title: "",
  description: name,
  inputSchema: { type: "object" },
}));

function toolNames(result: Awaited<ReturnType<typeof loadMcpServers>>, serverId: string): string[] | null {
  const found = result.servers.find((item) => item.serverId === serverId);
  return found ? found.tools.map((tool) => tool.name) : null;
}

test("MCP assignments inherit down the tenancy chain and blocks win", async () => {
  const owner = await ownerSession();
  const org = await prisma.organization.create({ data: { alias: uniqueName("org") } });
  const other = await prisma.organization.create({ data: { alias: uniqueName("other") } });
  const team = await prisma.team.create({ data: { alias: uniqueName("team"), orgId: org.id } });
  const project = await prisma.project.create({ data: { alias: uniqueName("project"), orgId: org.id, teamId: team.id } });
  const member = await prisma.member.create({ data: { name: uniqueName("person"), orgId: org.id, teamId: team.id } });
  const key = (data: object) =>
    prisma.virtualKey.create({ data: { hash: uniqueName("hash"), prefix: "sk-it", ...data } });
  const projectKey = await key({ projectId: project.id, orgId: org.id, teamId: team.id });
  const personKey = await key({ memberId: member.id, orgId: org.id, teamId: team.id });
  const otherKey = await key({ orgId: other.id });
  let serverId = "";
  try {
    const created = await runAsPrincipal(owner, () =>
      createMcpServer({
        name: uniqueName("srv").slice(0, 40),
        description: "",
        url: "http://127.0.0.1:1/mcp",
        authType: "bearer",
        authHeader: "",
        secret: "very-secret-token",
        clearSecret: false,
        internal: true,
        enabled: true,
        global: false,
        toolsRestricted: false,
        allowedTools: [],
      }),
    );
    serverId = created.server.id;
    assert.equal(created.server.hasSecret, true);
    assert.equal(created.server.status, "error");
    assert.ok(!JSON.stringify(created.server).includes("very-secret-token"));
    const stored = await prisma.mcpServer.findUniqueOrThrow({ where: { id: serverId } });
    assert.ok(stored.authSecret.startsWith("enc1:"));
    await prisma.mcpServer.update({ where: { id: serverId }, data: { tools: TOOLS, lastError: "", refreshedAt: new Date() } });

    const saved = await runAsPrincipal(owner, () =>
      saveMcpAssignments({
        serverId,
        global: false,
        assignments: [
          { scope: "org", id: org.id, mode: "allow", blockedTools: [] },
          { scope: "team", id: team.id, mode: "block", blockedTools: ["delete"] },
          { scope: "member", id: member.id, mode: "block", blockedTools: [] },
          { scope: "key", id: otherKey.id, mode: "allow", blockedTools: ["fetch", "fetch"] },
        ],
      }),
    );
    assert.equal(saved.server.assignments.length, 4);
    assert.deepEqual(saved.server.assignments.find((row) => row.scope === "key")?.blockedTools, ["fetch"]);

    const chain = (input: Partial<Record<"orgId" | "teamId" | "projectId" | "memberId" | "keyId", string>>) => ({
      orgId: "",
      teamId: "",
      projectId: "",
      memberId: "",
      keyId: "",
      ...input,
    });
    const viaProject = await loadMcpServers(chain({ orgId: org.id, teamId: team.id, projectId: project.id, keyId: projectKey.id }));
    assert.deepEqual(toolNames(viaProject, serverId), ["search", "fetch"]);
    assert.equal(viaProject.records.get(serverId)?.url, "http://127.0.0.1:1/mcp");
    const viaPerson = await loadMcpServers(chain({ orgId: org.id, teamId: team.id, memberId: member.id, keyId: personKey.id }));
    assert.equal(toolNames(viaPerson, serverId), null);
    const viaOther = await loadMcpServers(chain({ orgId: other.id, keyId: otherKey.id }));
    assert.deepEqual(toolNames(viaOther, serverId), ["search", "delete"]);
    const stranger = await loadMcpServers(chain({ orgId: other.id }));
    assert.equal(toolNames(stranger, serverId), null);

    await assert.rejects(
      runAsPrincipal(owner, () =>
        saveMcpAssignments({ serverId, global: false, assignments: [{ scope: "team", id: "missing", mode: "allow", blockedTools: [] }] }),
      ),
      /NOT_FOUND/,
    );
    await assert.rejects(
      prisma.mcpAssignment.create({ data: { serverId, orgId: org.id } }),
      (err: { code?: string }) => err.code === "P2002",
    );

    await prisma.virtualKey.delete({ where: { id: personKey.id } });
    await prisma.member.delete({ where: { id: member.id } });
    assert.equal(await prisma.mcpAssignment.count({ where: { serverId } }), 3);

    await runAsPrincipal(owner, () => saveMcpAssignments({ serverId, global: true, assignments: [] }));
    const global = await loadMcpServers(chain({ orgId: other.id }));
    assert.deepEqual(toolNames(global, serverId), ["search", "fetch", "delete"]);

    const list = await runAsPrincipal(owner, () => loadMcpServerList());
    assert.equal(list.canManage, true);
    assert.ok(list.servers.some((row) => row.id === serverId && row.global));

    await runAsPrincipal(owner, () => deleteMcpServer(serverId));
    assert.equal(await prisma.mcpAssignment.count({ where: { serverId } }), 0);
    serverId = "";
  } finally {
    if (serverId) await prisma.mcpServer.delete({ where: { id: serverId } });
    await prisma.virtualKey.deleteMany({ where: { id: { in: [projectKey.id, personKey.id, otherKey.id] } } });
    await prisma.member.deleteMany({ where: { id: member.id } });
    await prisma.project.delete({ where: { id: project.id } });
    await prisma.team.delete({ where: { id: team.id } });
    await prisma.organization.deleteMany({ where: { id: { in: [org.id, other.id] } } });
    await prisma.gatewayAuditLog.deleteMany({ where: { objectType: "mcp_server", actor: owner.user.id } });
    await prisma.user.delete({ where: { id: owner.user.id } });
  }
});

test("per-tool role grants and operator classification decide what a key reaches", async () => {
  const owner = await ownerSession();
  const org = await prisma.organization.create({ data: { alias: uniqueName("org") } });
  const key = await prisma.virtualKey.create({ data: { hash: uniqueName("hash"), prefix: "sk-it", orgId: org.id } });
  const server = await prisma.mcpServer.create({
    data: {
      name: uniqueName("perms").slice(0, 40),
      url: "http://127.0.0.1:1/mcp",
      internal: true,
      refreshedAt: new Date(),
      tools: [
        { name: "list", title: "", description: "", inputSchema: { type: "object" } },
        { name: "close", title: "", description: "", inputSchema: { type: "object" } },
        { name: "purge", title: "", description: "", inputSchema: { type: "object" }, hint: "read" },
      ],
    },
  });
  const chain = { orgId: org.id, teamId: "", projectId: "", memberId: "", keyId: key.id };
  const reached = async () => {
    const result = await loadMcpServers(chain);
    return result.servers.find((item) => item.serverId === server.id)?.tools.map((tool) => tool.name) ?? null;
  };
  try {
    await runAsPrincipal(owner, () => ensureMcpRoles(server.id));
    const builtins = await prisma.mcpRole.findMany({ where: { serverId: server.id } });
    const role = (roleKey: string) => builtins.find((item) => item.key === roleKey)!;
    const asInput = (row: (typeof builtins)[number]) => ({
      id: row.id,
      name: row.name,
      description: row.description,
      allActions: row.allActions,
      actions: row.actions,
      tools: row.tools,
      deniedTools: row.deniedTools,
    });

    await runAsPrincipal(owner, () =>
      saveMcpAssignments({
        serverId: server.id,
        global: false,
        assignments: [{ scope: "key", id: key.id, mode: "allow", blockedTools: [], roleId: role("reader").id }],
      }),
    );
    assert.equal(await reached(), null);

    await runAsPrincipal(owner, () =>
      saveMcpPermissions({
        serverId: server.id,
        toolActions: { list: "read", close: "write", purge: "delete", ghost: "read" },
        roles: [
          { ...asInput(role("reader")), name: "Renamed", tools: ["close", "ghost"] },
          asInput(role("operator")),
          { ...asInput(role("admin")), deniedTools: ["purge"] },
          { name: "Closer", description: "", allActions: false, actions: [], tools: ["close", "list"], deniedTools: ["list"] },
        ],
        removed: [],
      }),
    );
    const stored = await prisma.mcpServer.findUniqueOrThrow({ where: { id: server.id }, include: { roles: true } });
    assert.deepEqual(stored.toolActions, { list: "read", close: "write", purge: "delete" });
    const reader = stored.roles.find((item) => item.key === "reader")!;
    assert.equal(reader.name, "Reader");
    assert.deepEqual(reader.tools, ["close"]);
    const closer = stored.roles.find((item) => item.name === "Closer")!;
    assert.deepEqual([closer.tools, closer.deniedTools], [["close"], ["list"]]);
    assert.deepEqual(await reached(), ["list", "close"]);

    await runAsPrincipal(owner, () =>
      saveMcpAssignments({
        serverId: server.id,
        global: false,
        assignments: [
          { scope: "org", id: org.id, mode: "allow", blockedTools: [], roleId: role("admin").id },
          { scope: "key", id: key.id, mode: "allow", blockedTools: [], roleId: closer.id },
        ],
      }),
    );
    assert.deepEqual(await reached(), ["close"]);
    const listed = await runAsPrincipal(owner, () => loadMcpServerList());
    assert.equal(listed.servers.find((row) => row.id === server.id)?.roles.find((row) => row.id === closer.id)?.assigned, 1);

    const keep = (await prisma.mcpRole.findMany({ where: { serverId: server.id } })).map(asInput);
    await assert.rejects(
      runAsPrincipal(owner, () =>
        saveMcpPermissions({ serverId: server.id, toolActions: {}, roles: keep.filter((row) => row.id !== closer.id), removed: [closer.id] }),
      ),
      /MCP_ROLE_IN_USE/,
    );
    await assert.rejects(
      runAsPrincipal(owner, () =>
        saveMcpPermissions({ serverId: server.id, toolActions: {}, roles: keep, removed: [role("reader").id] }),
      ),
      /VALIDATION/,
    );
    assert.equal(await prisma.mcpRole.count({ where: { serverId: server.id } }), 4);

    await runAsPrincipal(owner, () =>
      saveMcpAssignments({
        serverId: server.id,
        global: false,
        assignments: [{ scope: "org", id: org.id, mode: "allow", blockedTools: [], roleId: role("admin").id }],
      }),
    );
    assert.deepEqual(await reached(), ["list", "close"]);
    await runAsPrincipal(owner, () =>
      saveMcpPermissions({
        serverId: server.id,
        toolActions: {},
        roles: keep.filter((row) => row.id !== closer.id),
        removed: [closer.id],
      }),
    );
    assert.equal(await prisma.mcpRole.count({ where: { serverId: server.id } }), 3);
    assert.deepEqual(await prisma.mcpServer.findUniqueOrThrow({ where: { id: server.id }, select: { toolActions: true } }), { toolActions: {} });
    assert.deepEqual(await reached(), ["list", "close"]);
  } finally {
    await prisma.mcpServer.delete({ where: { id: server.id } });
    await prisma.virtualKey.delete({ where: { id: key.id } });
    await prisma.organization.delete({ where: { id: org.id } });
    await prisma.gatewayAuditLog.deleteMany({ where: { objectType: "mcp_server", actor: owner.user.id } });
    await prisma.user.delete({ where: { id: owner.user.id } });
  }
});
