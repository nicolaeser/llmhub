import assert from "node:assert/strict";
import { after, test } from "node:test";
import prisma from "@/lib/db/prisma";
import { runAsPrincipal } from "@/lib/auth/delegation";
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
