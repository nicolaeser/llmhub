import assert from "node:assert/strict";
import { after, test } from "node:test";
import prisma from "@/lib/db/prisma";
import { runAsPrincipal } from "@/lib/auth/delegation";
import { AuthError } from "@/lib/auth/errors";
import { permissions } from "@/lib/auth/permissions";
import { createKey, loadKeysPage, revokeKey, rotateKey, updateKey } from "@/lib/keys/manage";
import { digest } from "@/lib/crypto";
import { PATCH as patchKey } from "@/app/api/mgmt/keys/[id]/route";
import type { Permission } from "@/types/auth";
import { closeDatabase, uniqueName } from "./support/database";
import { sessionOf, TestData } from "./support/fixtures";

after(closeDatabase);

const forbidden = (err: unknown) => err instanceof AuthError && err.code === "FORBIDDEN";
const failsWith = (code: string) => (err: unknown) => err instanceof Error && err.message === code;

const KEY_MANAGER: Permission[] = ["keys:read", "keys:read-all", "keys:manage", "tenancy:read", "tenancy:manage"];

async function twoCompanies(data: TestData) {
  const home = await data.org();
  const away = await data.org();
  const homeTeam = await data.team(home.id);
  return {
    home,
    away,
    homeTeam,
    homeProject: await data.project(home.id, homeTeam.id),
    homeMember: await data.member(home.id, homeTeam.id),
    awayProject: await data.project(away.id),
    awayMember: await data.member(away.id),
  };
}

function keyInput(overrides: Record<string, unknown> = {}) {
  return { alias: uniqueName("key"), ...overrides };
}

function updateInput(id: string, overrides: Record<string, unknown> = {}) {
  return { id, alias: uniqueName("key"), blocked: false, ...overrides };
}

test("a key binds to a project or a person, never both", async () => {
  const data = new TestData();
  try {
    const world = await twoCompanies(data);
    const admin = sessionOf(await data.user(), { permissions: KEY_MANAGER });
    await assert.rejects(
      runAsPrincipal(admin, () =>
        createKey(keyInput({ projectId: world.homeProject.id, memberId: world.homeMember.id })),
      ),
      failsWith("KEY_BINDING_CONFLICT"),
    );

    const { key } = await runAsPrincipal(admin, () => createKey(keyInput({ projectId: world.homeProject.id })));
    const stored = await prisma.virtualKey.findUniqueOrThrow({ where: { id: key.token_id } });
    assert.equal(stored.projectId, world.homeProject.id);
    assert.equal(stored.teamId, world.homeTeam.id);
    assert.equal(stored.orgId, world.home.id);
    assert.equal(stored.memberId, null);
    assert.equal(stored.hash, digest(key.key ?? ""));

    await assert.rejects(
      runAsPrincipal(admin, () =>
        updateKey(updateInput(stored.id, { projectId: world.homeProject.id, memberId: world.homeMember.id })),
      ),
      failsWith("KEY_BINDING_CONFLICT"),
    );
  } finally {
    await data.cleanup();
  }
});

test("company users can only bind keys to projects and people of their own company", async () => {
  const data = new TestData();
  try {
    const world = await twoCompanies(data);
    const manager = sessionOf(await data.user({ orgId: world.home.id }), { permissions: KEY_MANAGER });

    await assert.rejects(
      runAsPrincipal(manager, () => createKey(keyInput({ projectId: world.awayProject.id }))),
      failsWith("PROJECT_NOT_FOUND"),
    );
    await assert.rejects(
      runAsPrincipal(manager, () => createKey(keyInput({ memberId: world.awayMember.id }))),
      failsWith("MEMBER_NOT_FOUND"),
    );

    const { key: personal } = await runAsPrincipal(manager, () => createKey(keyInput()));
    assert.equal(personal.org_id, world.home.id);
    const { key: personKey } = await runAsPrincipal(manager, () => createKey(keyInput({ memberId: world.homeMember.id })));
    assert.equal(personKey.member_id, world.homeMember.id);
    assert.equal(personKey.team_id, world.homeTeam.id);

    await assert.rejects(
      runAsPrincipal(manager, () => updateKey(updateInput(personKey.token_id, { projectId: world.awayProject.id }))),
      failsWith("PROJECT_NOT_FOUND"),
    );
    const unchanged = await prisma.virtualKey.findUniqueOrThrow({ where: { id: personKey.token_id } });
    assert.equal(unchanged.memberId, world.homeMember.id);
  } finally {
    await data.cleanup();
  }
});

test("binding or rebinding a key needs tenancy:manage, keeping a binding does not", async () => {
  const data = new TestData();
  try {
    const world = await twoCompanies(data);
    const admin = sessionOf(await data.user(), { permissions: KEY_MANAGER });
    const keyOnly = sessionOf(await data.user(), { permissions: ["keys:read", "keys:read-all", "keys:manage"] });

    await assert.rejects(
      runAsPrincipal(keyOnly, () => createKey(keyInput({ projectId: world.homeProject.id }))),
      failsWith("FORBIDDEN"),
    );
    const { key } = await runAsPrincipal(admin, () => createKey(keyInput({ projectId: world.homeProject.id })));

    const renamed = await runAsPrincipal(keyOnly, () =>
      updateKey(updateInput(key.token_id, { projectId: world.homeProject.id, rpm: 7 })),
    );
    assert.equal(renamed.key.project_id, world.homeProject.id);
    assert.equal(renamed.key.rpm_limit, 7);

    await assert.rejects(
      runAsPrincipal(keyOnly, () => updateKey(updateInput(key.token_id, { memberId: world.homeMember.id }))),
      failsWith("FORBIDDEN"),
    );
    await assert.rejects(runAsPrincipal(keyOnly, () => updateKey(updateInput(key.token_id))), failsWith("FORBIDDEN"));
    assert.equal((await prisma.virtualKey.findUniqueOrThrow({ where: { id: key.token_id } })).projectId, world.homeProject.id);
  } finally {
    await data.cleanup();
  }
});

test("key services need keys:manage and only reach keys the caller may see", async () => {
  const data = new TestData();
  try {
    const world = await twoCompanies(data);
    const reader = sessionOf(await data.user(), { permissions: ["keys:read", "keys:read-all"] });
    const own = sessionOf(await data.user({ orgId: world.home.id }), { permissions: ["keys:read", "keys:manage"] });
    const colleague = await data.user({ orgId: world.home.id });
    const outsider = await data.user({ orgId: world.away.id });
    const colleagueKey = await data.key({ userId: colleague.id, orgId: world.home.id });
    const awayKey = await data.key({ userId: outsider.id, orgId: world.away.id });

    const calls: (() => Promise<unknown>)[] = [
      () => createKey(keyInput()),
      () => updateKey(updateInput(colleagueKey.id)),
      () => rotateKey(colleagueKey.id),
      () => revokeKey(colleagueKey.id),
    ];
    for (const call of calls) {
      await assert.rejects(runAsPrincipal(reader, call), forbidden);
    }
    for (const id of [colleagueKey.id, awayKey.id]) {
      await assert.rejects(runAsPrincipal(own, () => updateKey(updateInput(id))), failsWith("NOT_FOUND"));
      await assert.rejects(runAsPrincipal(own, () => rotateKey(id)), failsWith("NOT_FOUND"));
      await assert.rejects(runAsPrincipal(own, () => revokeKey(id)), failsWith("NOT_FOUND"));
    }
    assert.equal(await prisma.virtualKey.count({ where: { id: { in: [colleagueKey.id, awayKey.id] } } }), 2);

    const page = await runAsPrincipal(own, () => loadKeysPage());
    assert.deepEqual(page.keys, []);
    assert.deepEqual(page.orgs.map((org) => org.id), [world.home.id]);
    assert.equal(page.canBind, false);

    const companyAdmin = sessionOf(await data.user({ orgId: world.home.id }), { permissions: [...permissions] });
    const visible = await runAsPrincipal(companyAdmin, () => loadKeysPage());
    assert.deepEqual(visible.keys.map((key) => key.token_id), [colleagueKey.id]);
    const rotated = await runAsPrincipal(companyAdmin, () => rotateKey(colleagueKey.id));
    const rotatedRow = await prisma.virtualKey.findUniqueOrThrow({ where: { id: colleagueKey.id } });
    assert.equal(rotatedRow.prevHash, colleagueKey.hash);
    assert.equal(rotatedRow.hash, digest(rotated.key.key ?? ""));
  } finally {
    await data.cleanup();
  }
});

test("PATCH /api/mgmt/keys replaces the whole binding when either reference is sent", async () => {
  const data = new TestData();
  try {
    const world = await twoCompanies(data);
    const owner = await data.user({ isOwner: true });
    const secret = `sk-mgmt-${uniqueName("secret")}`;
    await prisma.managementKey.create({
      data: {
        userId: owner.id,
        name: "integration",
        prefix: secret.slice(0, 16),
        hash: digest(secret),
        permissions: ["keys:read", "keys:read-all", "keys:manage", "tenancy:manage"],
      },
    });
    const key = await data.key({ userId: owner.id, orgId: world.home.id, teamId: world.homeTeam.id, memberId: world.homeMember.id });
    const patch = async (body: unknown) => {
      const res = await patchKey(
        new Request(`http://hub.local/api/mgmt/keys/${key.id}`, {
          method: "PATCH",
          headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
        { params: Promise.resolve({ id: key.id }) },
      );
      assert.equal(res.status, 200);
      return res.json();
    };

    const renamed = await patch({ alias: "renamed" });
    assert.equal(renamed.member_id, world.homeMember.id);
    assert.equal(renamed.project_id, null);

    const moved = await patch({ project_id: world.homeProject.id });
    assert.equal(moved.project_id, world.homeProject.id);
    assert.equal(moved.member_id, null);
    assert.equal(moved.team_id, world.homeTeam.id);

    const person = await patch({ member_id: world.homeMember.id });
    assert.equal(person.member_id, world.homeMember.id);
    assert.equal(person.project_id, null);

    const unbound = await patch({ member_id: null });
    assert.equal(unbound.member_id, null);
    assert.equal(unbound.project_id, null);
    assert.equal(unbound.user_id, owner.id);
  } finally {
    await data.cleanup();
  }
});
