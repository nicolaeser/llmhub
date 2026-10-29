import assert from "node:assert/strict";
import { after, test } from "node:test";
import prisma from "@/lib/db/prisma";
import { runAsPrincipal } from "@/lib/auth/delegation";
import { AuthError } from "@/lib/auth/errors";
import { permissions } from "@/lib/auth/permissions";
import {
  createKey,
  loadKeyDetail,
  loadKeysPage,
  pauseKey,
  resumeKey,
  revokeKey,
  rotateKey,
  updateKey,
} from "@/lib/keys/manage";
import { digest } from "@/lib/crypto";
import { gateRequest } from "@/lib/gateway/access/gate";
import { authenticateBearer, keyPrincipal } from "@/lib/gateway/access/principal";
import { GateError } from "@/lib/gateway/errors";
import { PATCH as patchKey } from "@/app/api/mgmt/keys/[id]/route";
import { POST as pauseRoute } from "@/app/api/mgmt/keys/[id]/pause/route";
import { POST as resumeRoute } from "@/app/api/mgmt/keys/[id]/resume/route";
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
      () => pauseKey({ id: colleagueKey.id }),
      () => resumeKey(colleagueKey.id),
    ];
    for (const call of calls) {
      await assert.rejects(runAsPrincipal(reader, call), forbidden);
    }
    for (const id of [colleagueKey.id, awayKey.id]) {
      await assert.rejects(runAsPrincipal(own, () => updateKey(updateInput(id))), failsWith("NOT_FOUND"));
      await assert.rejects(runAsPrincipal(own, () => rotateKey(id)), failsWith("NOT_FOUND"));
      await assert.rejects(runAsPrincipal(own, () => revokeKey(id)), failsWith("NOT_FOUND"));
      await assert.rejects(runAsPrincipal(own, () => pauseKey({ id })), failsWith("NOT_FOUND"));
      await assert.rejects(runAsPrincipal(own, () => resumeKey(id)), failsWith("NOT_FOUND"));
    }
    assert.equal(await prisma.virtualKey.count({ where: { id: { in: [colleagueKey.id, awayKey.id] }, paused: true } }), 0);
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

test("key details open only keys the caller may see, with their template names", async () => {
  const data = new TestData();
  const templateName = uniqueName("template");
  try {
    const world = await twoCompanies(data);
    const template = await prisma.modelTemplate.create({ data: { name: templateName } });
    const colleague = await data.user({ orgId: world.home.id });
    const outsider = await data.user({ orgId: world.away.id });
    const homeKey = await data.key({
      userId: colleague.id,
      orgId: world.home.id,
      teamId: world.homeTeam.id,
      projectId: world.homeProject.id,
    });
    await prisma.virtualKeyTemplate.create({ data: { keyId: homeKey.id, templateId: template.id } });
    const awayKey = await data.key({ userId: outsider.id, orgId: world.away.id });

    const tenancyOnly = sessionOf(await data.user(), { permissions: ["tenancy:read"] });
    await assert.rejects(runAsPrincipal(tenancyOnly, () => loadKeyDetail(homeKey.id)), forbidden);

    const platformReader = sessionOf(await data.user(), { permissions: ["keys:read", "keys:read-all"] });
    const detail = await runAsPrincipal(platformReader, () => loadKeyDetail(homeKey.id));
    assert.equal(detail.key.token_id, homeKey.id);
    assert.equal(detail.key.project_id, world.homeProject.id);
    assert.equal(detail.key.org_id, world.home.id);
    assert.deepEqual(detail.key.templates, [template.id]);
    assert.deepEqual(detail.templates, [{ id: template.id, name: templateName }]);
    assert.equal("hash" in detail.key, false);
    assert.equal("key" in detail.key, false);
    assert.equal((await runAsPrincipal(platformReader, () => loadKeyDetail(awayKey.id))).key.token_id, awayKey.id);

    const companyReader = sessionOf(await data.user({ orgId: world.home.id }), {
      permissions: ["keys:read", "keys:read-all"],
    });
    assert.equal((await runAsPrincipal(companyReader, () => loadKeyDetail(homeKey.id))).key.token_id, homeKey.id);
    await assert.rejects(runAsPrincipal(companyReader, () => loadKeyDetail(awayKey.id)), failsWith("NOT_FOUND"));

    const ownKeysOnly = sessionOf(colleague, { permissions: ["keys:read"] });
    assert.equal((await runAsPrincipal(ownKeysOnly, () => loadKeyDetail(homeKey.id))).key.token_id, homeKey.id);
    const otherColleague = sessionOf(await data.user({ orgId: world.home.id }), { permissions: ["keys:read"] });
    await assert.rejects(runAsPrincipal(otherColleague, () => loadKeyDetail(homeKey.id)), failsWith("NOT_FOUND"));

    const ownerCompanyView = { ...sessionOf(await data.user({ isOwner: true })), workspaceOrgId: world.away.id };
    await assert.rejects(runAsPrincipal(ownerCompanyView, () => loadKeyDetail(homeKey.id)), failsWith("NOT_FOUND"));
    assert.equal((await runAsPrincipal(ownerCompanyView, () => loadKeyDetail(awayKey.id))).key.token_id, awayKey.id);

    await assert.rejects(runAsPrincipal(platformReader, () => loadKeyDetail("missing-key")), failsWith("NOT_FOUND"));
    await assert.rejects(runAsPrincipal(platformReader, () => loadKeyDetail(" ")), failsWith("MISSING_ID"));
  } finally {
    await data.cleanup();
    await prisma.modelTemplate.deleteMany({ where: { name: templateName } });
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

async function auditOf(action: string, objectId: string) {
  const row = await prisma.gatewayAuditLog.findFirstOrThrow({ where: { action, objectId }, orderBy: { createdAt: "desc" } });
  return { before: JSON.parse(row.beforeJson), after: JSON.parse(row.afterJson) };
}

test("a paused key is refused at the gateway until it is resumed or its pause ends", async () => {
  const data = new TestData();
  try {
    const world = await twoCompanies(data);
    const admin = sessionOf(await data.user(), { permissions: KEY_MANAGER });
    const created = await runAsPrincipal(admin, () => createKey(keyInput({ projectId: world.homeProject.id })));
    const id = created.key.token_id;
    const secret = created.key.key;
    const gate = () =>
      gateRequest(
        new Request("http://hub.local/api/v1/chat/completions", {
          method: "POST",
          headers: { authorization: `Bearer ${secret}` },
        }),
      );
    const refusedAsPaused = (message: string) => (err: unknown) =>
      err instanceof GateError && err.status === 403 && err.code === "key_paused" && err.message === message;

    assert.equal((await gate()).key?.token_id, id);

    const paused = await runAsPrincipal(admin, () => pauseKey({ id }));
    assert.equal(paused.key.paused, true);
    assert.equal(paused.key.paused_until, "");
    assert.deepEqual(await auditOf("key.pause", id), {
      before: { paused: false, pausedUntil: null },
      after: { paused: true, pausedUntil: null },
    });
    await assert.rejects(gate(), refusedAsPaused("this key is paused"));
    assert.equal((await authenticateBearer(secret)).key?.paused, true);
    assert.equal((await keyPrincipal(id))?.key?.token_id, id);

    const resumed = await runAsPrincipal(admin, () => resumeKey(id));
    assert.equal(resumed.key.paused, false);
    assert.deepEqual(await auditOf("key.resume", id), {
      before: { paused: true, pausedUntil: null },
      after: { paused: false, pausedUntil: null },
    });
    assert.equal((await gate()).key?.token_id, id);

    const before = Date.now();
    const timed = await runAsPrincipal(admin, () => pauseKey({ id, hours: 24 }));
    const until = Date.parse(timed.key.paused_until);
    assert.ok(until >= before + 24 * 3_600_000 && until <= Date.now() + 24 * 3_600_000);
    await assert.rejects(gate(), refusedAsPaused(`this key is paused until ${timed.key.paused_until}`));

    await prisma.virtualKey.update({ where: { id }, data: { pausedUntil: new Date(Date.now() - 1000) } });
    assert.equal((await gate()).key?.paused, false);
    const listed = (await runAsPrincipal(admin, () => loadKeysPage())).keys.find((key) => key.token_id === id);
    assert.equal(listed?.paused, false);
    assert.equal(listed?.paused_until, "");

    await assert.rejects(runAsPrincipal(admin, () => pauseKey({ id, hours: -1 })), failsWith("VALIDATION"));
  } finally {
    await data.cleanup();
  }
});

test("POST /api/mgmt/keys/{id}/pause and /resume switch the pause and return the key", async () => {
  const data = new TestData();
  try {
    const owner = await data.user({ isOwner: true });
    const secret = `sk-mgmt-${uniqueName("secret")}`;
    await prisma.managementKey.create({
      data: {
        userId: owner.id,
        name: "integration",
        prefix: secret.slice(0, 16),
        hash: digest(secret),
        permissions: ["keys:read", "keys:read-all", "keys:manage"],
      },
    });
    const key = await data.key({ userId: owner.id });
    const post = async (handler: typeof pauseRoute, action: string, body?: unknown) => {
      const res = await handler(
        new Request(`http://hub.local/api/mgmt/keys/${key.id}/${action}`, {
          method: "POST",
          headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
        { params: Promise.resolve({ id: key.id }) },
      );
      return { status: res.status, body: await res.json() };
    };

    const open = await post(pauseRoute, "pause");
    assert.equal(open.status, 200);
    assert.equal(open.body.object, "api_key");
    assert.equal(open.body.paused, true);
    assert.equal(open.body.paused_until, null);

    const timed = await post(pauseRoute, "pause", { hours: 1 });
    assert.equal(timed.body.paused, true);
    assert.ok(Date.parse(timed.body.paused_until) > Date.now());

    assert.equal((await post(pauseRoute, "pause", { hours: 1, until: "tomorrow" })).status, 422);

    const resumed = await post(resumeRoute, "resume");
    assert.equal(resumed.status, 200);
    assert.equal(resumed.body.paused, false);
    assert.equal(resumed.body.paused_until, null);
    const stored = await prisma.virtualKey.findUniqueOrThrow({ where: { id: key.id } });
    assert.equal(stored.paused, false);
    assert.equal(stored.pausedUntil, null);
  } finally {
    await data.cleanup();
  }
});
