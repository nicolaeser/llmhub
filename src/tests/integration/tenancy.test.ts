import assert from "node:assert/strict";
import { after, test } from "node:test";
import prisma from "@/lib/db/prisma";
import { runAsPrincipal } from "@/lib/auth/delegation";
import { AuthError } from "@/lib/auth/errors";
import { deleteNode, loadStructure, saveMember, saveOrg, saveProject, saveTeam } from "@/lib/tenancy/structure";
import type { Permission } from "@/types/auth";
import { closeDatabase, uniqueName } from "./support/database";
import { sessionOf, TestData } from "./support/fixtures";

after(closeDatabase);

const TENANCY_ADMIN: Permission[] = ["tenancy:read", "tenancy:manage", "keys:read"];
const failsWith = (code: string) => (err: unknown) => err instanceof Error && err.message === code;
const forbidden = (err: unknown) => err instanceof AuthError && err.code === "FORBIDDEN";

const teamInput = (orgId: string, overrides: Record<string, unknown> = {}) => ({
  alias: uniqueName("team"),
  orgId,
  rpm: 0,
  tpm: 0,
  ...overrides,
});
const projectInput = (orgId: string, overrides: Record<string, unknown> = {}) => ({
  alias: uniqueName("project"),
  orgId,
  teamId: "",
  owner: "",
  ...overrides,
});
const memberInput = (orgId: string, overrides: Record<string, unknown> = {}) => ({
  alias: uniqueName("member"),
  email: "",
  orgId,
  teamId: "",
  blocked: false,
  logContent: true,
  ...overrides,
});

test("company users manage departments, projects, and people only inside their company", async () => {
  const data = new TestData();
  try {
    const home = await data.org();
    const away = await data.org();
    const awayTeam = await data.team(away.id);
    const awayProject = await data.project(away.id);
    const awayMember = await data.member(away.id);
    const manager = sessionOf(await data.user({ orgId: home.id }), { permissions: TENANCY_ADMIN });
    const as = <T>(fn: () => Promise<T>) => runAsPrincipal(manager, fn);

    await assert.rejects(as(() => saveTeam(teamInput(away.id))), failsWith("ORG_NOT_FOUND"));
    await assert.rejects(as(() => saveProject(projectInput(away.id))), failsWith("ORG_NOT_FOUND"));
    await assert.rejects(as(() => saveMember(memberInput(away.id))), failsWith("ORG_NOT_FOUND"));
    await assert.rejects(as(() => saveTeam(teamInput(home.id, { id: awayTeam.id }))), failsWith("NOT_FOUND"));
    await assert.rejects(as(() => saveProject(projectInput(home.id, { id: awayProject.id }))), failsWith("NOT_FOUND"));
    await assert.rejects(as(() => saveMember(memberInput(home.id, { id: awayMember.id }))), failsWith("NOT_FOUND"));
    for (const [kind, id] of [
      ["team", awayTeam.id],
      ["project", awayProject.id],
      ["member", awayMember.id],
    ] as const) {
      await assert.rejects(as(() => deleteNode({ kind, id })), failsWith("NOT_FOUND"), kind);
    }
    assert.equal(await prisma.team.count({ where: { id: awayTeam.id } }), 1);
    assert.equal(await prisma.project.count({ where: { id: awayProject.id } }), 1);
    assert.equal(await prisma.member.count({ where: { id: awayMember.id } }), 1);

    const payload = await as(() => saveTeam(teamInput(home.id, { alias: "Platform" })));
    assert.deepEqual(payload.orgs.map((org) => org.id), [home.id]);
    assert.deepEqual(payload.teams.map((team) => team.alias), ["Platform"]);
    assert.equal(payload.companyId, home.id);
  } finally {
    await data.cleanup();
  }
});

test("projects and people only join departments of their own company", async () => {
  const data = new TestData();
  try {
    const home = await data.org();
    const away = await data.org();
    const awayTeam = await data.team(away.id);
    const homeTeam = await data.team(home.id);
    const admin = sessionOf(await data.user(), { permissions: TENANCY_ADMIN });
    const as = <T>(fn: () => Promise<T>) => runAsPrincipal(admin, fn);

    await assert.rejects(as(() => saveProject(projectInput(home.id, { teamId: awayTeam.id }))), failsWith("TEAM_NOT_IN_ORG"));
    await assert.rejects(as(() => saveMember(memberInput(home.id, { teamId: awayTeam.id }))), failsWith("TEAM_NOT_IN_ORG"));
    await assert.rejects(as(() => saveProject(projectInput(home.id, { teamId: "missing-team" }))), failsWith("TEAM_NOT_FOUND"));

    const payload = await as(() => saveProject(projectInput(home.id, { teamId: homeTeam.id })));
    assert.ok(payload.projects.some((project) => project.orgId === home.id && project.teamId === homeTeam.id));
  } finally {
    await data.cleanup();
  }
});

test("departments, projects, and people cannot move to another company", async () => {
  const data = new TestData();
  try {
    const home = await data.org();
    const away = await data.org();
    const team = await data.team(home.id);
    const project = await data.project(home.id);
    const member = await data.member(home.id);
    const admin = sessionOf(await data.user(), { permissions: TENANCY_ADMIN });
    const as = <T>(fn: () => Promise<T>) => runAsPrincipal(admin, fn);

    await assert.rejects(as(() => saveTeam(teamInput(away.id, { id: team.id }))), failsWith("ORG_LOCKED"));
    await assert.rejects(as(() => saveProject(projectInput(away.id, { id: project.id }))), failsWith("ORG_LOCKED"));
    await assert.rejects(as(() => saveMember(memberInput(away.id, { id: member.id }))), failsWith("ORG_LOCKED"));
    assert.equal((await prisma.team.findUniqueOrThrow({ where: { id: team.id } })).orgId, home.id);
    assert.equal((await prisma.project.findUniqueOrThrow({ where: { id: project.id } })).orgId, home.id);
    assert.equal((await prisma.member.findUniqueOrThrow({ where: { id: member.id } })).orgId, home.id);
  } finally {
    await data.cleanup();
  }
});

test("companies are created, renamed, and deleted only by platform users", async () => {
  const data = new TestData();
  const alias = uniqueName("org");
  try {
    const home = await data.org();
    const scoped = sessionOf(await data.user({ orgId: home.id }), { permissions: TENANCY_ADMIN });
    await assert.rejects(runAsPrincipal(scoped, () => saveOrg({ alias })), failsWith("PLATFORM_ONLY"));
    assert.equal(await prisma.organization.count({ where: { alias } }), 0);
    await assert.rejects(runAsPrincipal(scoped, () => saveOrg({ id: home.id, alias: "Renamed" })), failsWith("PLATFORM_ONLY"));
    await assert.rejects(runAsPrincipal(scoped, () => deleteNode({ kind: "org", id: home.id })), failsWith("PLATFORM_ONLY"));

    const admin = sessionOf(await data.user(), { permissions: TENANCY_ADMIN });
    await assert.rejects(runAsPrincipal(admin, () => deleteNode({ kind: "org", id: home.id })), failsWith("HAS_CHILDREN"));
    const empty = await data.org();
    await runAsPrincipal(admin, () => deleteNode({ kind: "org", id: empty.id }));
    assert.equal(await prisma.organization.count({ where: { id: empty.id } }), 0);
  } finally {
    await data.cleanup();
    await prisma.organization.deleteMany({ where: { alias } });
  }
});

test("structure changes need tenancy:manage", async () => {
  const data = new TestData();
  try {
    const home = await data.org();
    const team = await data.team(home.id);
    const reader = sessionOf(await data.user(), { permissions: ["tenancy:read"] });
    for (const call of [
      () => saveOrg({ alias: uniqueName("org") }),
      () => saveTeam(teamInput(home.id)),
      () => saveProject(projectInput(home.id)),
      () => saveMember(memberInput(home.id)),
      () => deleteNode({ kind: "team", id: team.id }),
    ]) {
      await assert.rejects(runAsPrincipal(reader, call), forbidden);
    }
    assert.equal(await prisma.team.count({ where: { orgId: home.id } }), 1);
    const payload = await runAsPrincipal(reader, () => loadStructure());
    assert.equal(payload.canManage, false);
    await assert.rejects(runAsPrincipal(sessionOf(await data.user(), { permissions: [] }), () => loadStructure()), forbidden);
  } finally {
    await data.cleanup();
  }
});
