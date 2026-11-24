import assert from "node:assert/strict";
import { after, test } from "node:test";
import prisma from "@/lib/db/prisma";
import { runAsPrincipal } from "@/lib/auth/delegation";
import { adoptMcpAccessLevels } from "@/lib/bootstrap/mcp-access-levels";
import { saveMcpPermissions } from "@/lib/mcp/catalog";
import { loadKeyMcpAccess, saveKeyMcpAccess } from "@/lib/mcp/key-access";
import {
  createMcpServer,
  deleteMcpServer,
  loadCompanyMcpServers,
  loadMcpServerList,
  saveCompanyMcpInstallation,
  saveMcpAssignments,
} from "@/lib/mcp/servers";
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

test("MCP access levels reach down the tenancy chain and lower levels only narrow them", async () => {
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
        defaultAccess: "none",
        assignments: [
          { scope: "org", id: org.id, access: "all" },
          { scope: "team", id: team.id, access: "inherit", blockedTools: ["delete"] },
          { scope: "member", id: member.id, access: "none" },
          { scope: "key", id: otherKey.id, access: "all", blockedTools: ["fetch", "fetch", "ghost"] },
          { scope: "project", id: project.id, access: "inherit" },
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
        saveMcpAssignments({ serverId, defaultAccess: "none", assignments: [{ scope: "team", id: "missing", access: "all" }] }),
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

    await runAsPrincipal(owner, () => saveMcpAssignments({ serverId, defaultAccess: "all", assignments: [] }));
    const global = await loadMcpServers(chain({ orgId: other.id }));
    assert.deepEqual(toolNames(global, serverId), ["search", "fetch", "delete"]);

    const list = await runAsPrincipal(owner, () => loadMcpServerList());
    assert.equal(list.canManage, true);
    assert.ok(list.servers.some((row) => row.id === serverId && row.global && row.defaultAccess === "all"));

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

test("tool classification sorts tools into levels and old role rules are adopted at boot", async () => {
  const owner = await ownerSession();
  const org = await prisma.organization.create({ data: { alias: uniqueName("org") } });
  const key = await prisma.virtualKey.create({ data: { hash: uniqueName("hash"), prefix: "sk-it", orgId: org.id } });
  const server = await prisma.mcpServer.create({
    data: {
      name: uniqueName("levels").slice(0, 40),
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
    await runAsPrincipal(owner, () =>
      saveMcpAssignments({ serverId: server.id, defaultAccess: "none", assignments: [{ scope: "key", id: key.id, access: "read" }] }),
    );
    assert.equal(await reached(), null);

    await runAsPrincipal(owner, () =>
      saveMcpPermissions({ serverId: server.id, toolActions: { list: "read", close: "write", purge: "delete", ghost: "read" } }),
    );
    const stored = await prisma.mcpServer.findUniqueOrThrow({ where: { id: server.id } });
    assert.deepEqual(stored.toolActions, { list: "read", close: "write", purge: "delete" });
    assert.deepEqual(await reached(), ["list"]);

    await runAsPrincipal(owner, () =>
      saveMcpAssignments({
        serverId: server.id,
        defaultAccess: "none",
        assignments: [
          { scope: "org", id: org.id, access: "write" },
          { scope: "key", id: key.id, access: "all" },
        ],
      }),
    );
    assert.deepEqual(await reached(), ["list", "close"]);
    const rows = await prisma.mcpAssignment.findMany({ where: { serverId: server.id }, orderBy: { keyId: "asc" } });
    assert.deepEqual(
      rows.map((row) => [row.access, row.mode, row.blockedActions]),
      [
        ["all", "allow", []],
        ["write", "allow", ["delete"]],
      ],
    );

    await prisma.mcpAssignment.deleteMany({ where: { serverId: server.id } });
    const reader = await prisma.mcpRole.create({
      data: { serverId: server.id, key: "reader", name: "Reader", actions: ["read"], tools: ["purge"], builtin: true },
    });
    await prisma.mcpAssignment.createMany({
      data: [
        { serverId: server.id, orgId: org.id, mode: "allow", roleId: reader.id },
        { serverId: server.id, keyId: key.id, mode: "block", blockedActions: ["delete"] },
      ],
    });
    assert.equal(await reached(), null);
    assert.equal(await adoptMcpAccessLevels(), 2);
    assert.equal(await adoptMcpAccessLevels(), 0);
    const adopted = await prisma.mcpAssignment.findMany({ where: { serverId: server.id }, orderBy: { keyId: "asc" } });
    assert.deepEqual(
      adopted.map((row) => [row.access, row.extraTools, row.blockedTools]),
      [
        ["inherit", [], ["purge"]],
        ["read", ["purge"], []],
      ],
    );
    assert.deepEqual(await reached(), ["list"]);
  } finally {
    await prisma.mcpServer.delete({ where: { id: server.id } });
    await prisma.virtualKey.delete({ where: { id: key.id } });
    await prisma.organization.delete({ where: { id: org.id } });
    await prisma.gatewayAuditLog.deleteMany({ where: { objectType: "mcp_server", actor: owner.user.id } });
    await prisma.user.delete({ where: { id: owner.user.id } });
  }
});

test("a key's own level narrows, grants, or blocks a server tool by tool", async () => {
  const owner = await ownerSession();
  const org = await prisma.organization.create({ data: { alias: uniqueName("org") } });
  const member = await prisma.member.create({ data: { name: uniqueName("person"), orgId: org.id } });
  const key = await prisma.virtualKey.create({
    data: { hash: uniqueName("hash"), prefix: "sk-it", memberId: member.id, orgId: org.id },
  });
  const servers = await Promise.all(
    ["keyed", "other"].map((label) =>
      prisma.mcpServer.create({
        data: {
          name: uniqueName(label).slice(0, 40),
          url: "http://127.0.0.1:1/mcp",
          internal: true,
          tools: TOOLS,
          toolActions: { search: "read", fetch: "read", delete: "delete" },
          refreshedAt: new Date(),
        },
      }),
    ),
  );
  const [server, other] = servers;
  const chain = { orgId: org.id, teamId: "", projectId: "", memberId: member.id, keyId: key.id };
  try {
    await runAsPrincipal(owner, () =>
      saveMcpAssignments({ serverId: server!.id, defaultAccess: "none", assignments: [{ scope: "org", id: org.id, access: "all" }] }),
    );
    const before = await runAsPrincipal(owner, () => loadKeyMcpAccess(key.id));
    assert.deepEqual(before.chain, chain);
    const entry = before.servers.find((row) => row.serverId === server!.id)!;
    assert.equal(entry.rule, null);
    assert.deepEqual(entry.inherited.map((rule) => [rule.scope, rule.access]), [["org", "all"]]);
    assert.equal(entry.tools.find((tool) => tool.name === "delete")?.action, "delete");
    assert.deepEqual(toolNames(await loadMcpServers(chain), server!.id), ["search", "fetch", "delete"]);

    const narrowed = await runAsPrincipal(owner, () =>
      saveKeyMcpAccess({
        keyId: key.id,
        servers: [{ serverId: server!.id, access: "read", blockedTools: ["fetch", "missing"] }],
      }),
    );
    const narrowedRule = narrowed.servers.find((row) => row.serverId === server!.id)?.rule;
    assert.equal(narrowedRule?.access, "read");
    assert.deepEqual(narrowedRule?.blockedTools, ["fetch"]);
    assert.deepEqual(toolNames(await loadMcpServers(chain), server!.id), ["search"]);

    const granted = await runAsPrincipal(owner, () =>
      saveKeyMcpAccess({ keyId: key.id, servers: [{ serverId: other!.id, access: "read" }] }),
    );
    assert.equal(granted.servers.find((row) => row.serverId === other!.id)?.rule?.access, "read");
    assert.deepEqual(toolNames(await loadMcpServers(chain), other!.id), ["search", "fetch"]);
    assert.deepEqual(toolNames(await loadMcpServers(chain), server!.id), ["search"]);

    await assert.rejects(
      runAsPrincipal(owner, () =>
        saveKeyMcpAccess({ keyId: key.id, servers: [{ serverId: server!.id, access: "allow" }] }),
      ),
      /VALIDATION/,
    );
    await assert.rejects(
      runAsPrincipal(owner, () => saveKeyMcpAccess({ keyId: "missing", servers: [] })),
      /NOT_FOUND/,
    );

    await runAsPrincipal(owner, () =>
      saveKeyMcpAccess({ keyId: key.id, servers: [{ serverId: server!.id, access: "none" }] }),
    );
    assert.equal(toolNames(await loadMcpServers(chain), server!.id), null);

    const cleared = await runAsPrincipal(owner, () =>
      saveKeyMcpAccess({
        keyId: key.id,
        servers: [
          { serverId: server!.id, access: "inherit" },
          { serverId: other!.id, access: "inherit" },
        ],
      }),
    );
    assert.ok(cleared.servers.every((row) => row.rule === null));
    assert.equal(await prisma.mcpAssignment.count({ where: { keyId: key.id } }), 0);
    assert.deepEqual(toolNames(await loadMcpServers(chain), server!.id), ["search", "fetch", "delete"]);
    assert.equal(toolNames(await loadMcpServers(chain), other!.id), null);
  } finally {
    await prisma.mcpServer.deleteMany({ where: { id: { in: servers.map((row) => row.id) } } });
    await prisma.virtualKey.delete({ where: { id: key.id } });
    await prisma.member.delete({ where: { id: member.id } });
    await prisma.organization.delete({ where: { id: org.id } });
    await prisma.gatewayAuditLog.deleteMany({ where: { actor: owner.user.id } });
    await prisma.user.delete({ where: { id: owner.user.id } });
  }
});

test("a company connects its own key to an offered server from the company pages", async () => {
  const owner = await ownerSession();
  const org = await prisma.organization.create({ data: { alias: uniqueName("org") } });
  const offered = await prisma.mcpServer.create({
    data: { name: uniqueName("offered").slice(0, 40), url: "http://127.0.0.1:1/mcp", internal: true, template: true, tools: TOOLS },
  });
  const plain = await prisma.mcpServer.create({
    data: { name: uniqueName("plain").slice(0, 40), url: "http://127.0.0.1:1/mcp", internal: true, tools: TOOLS },
  });
  try {
    const listed = await runAsPrincipal(owner, () => loadCompanyMcpServers(org.id));
    assert.equal(listed.company.id, org.id);
    assert.equal(listed.canInstall, true);
    assert.ok(listed.servers.some((row) => row.id === offered.id));
    assert.ok(!listed.servers.some((row) => row.id === plain.id));
    const saved = await runAsPrincipal(owner, () =>
      saveCompanyMcpInstallation({
        serverId: offered.id,
        orgId: org.id,
        enabled: true,
        baseUrl: "",
        authType: "bearer",
        authHeader: "",
        secret: "company-secret-token",
      }),
    );
    const installation = saved.server.installations.find((row) => row.orgId === org.id);
    assert.equal(installation?.hasSecret, true);
    assert.ok(saved.server.installations.every((row) => row.orgId === org.id));
    assert.ok(!JSON.stringify(saved).includes("company-secret-token"));
    await assert.rejects(runAsPrincipal(owner, () => loadCompanyMcpServers("missing-org")), /ORG_NOT_FOUND/);
  } finally {
    await prisma.mcpServer.deleteMany({ where: { id: { in: [offered.id, plain.id] } } });
    await prisma.organization.delete({ where: { id: org.id } });
    await prisma.gatewayAuditLog.deleteMany({ where: { actor: owner.user.id } });
    await prisma.user.delete({ where: { id: owner.user.id } });
  }
});
