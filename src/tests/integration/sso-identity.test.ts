import "./support/oidc-env";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import prisma from "@/lib/db/prisma";
import { templateRoleId } from "@/lib/auth/roles";
import { issueScimToken } from "@/lib/auth/scim";
import { signInWithSso, SsoError } from "@/lib/auth/sso-user";
import { ensureSystemCatalog } from "@/lib/bootstrap/system-catalog";
import { normalizeOidc, patchEnterprise } from "@/lib/settings/enterprise";
import { POST as createGroup } from "@/app/scim/v2/Groups/route";
import { DELETE as deleteGroup, PATCH as patchGroup } from "@/app/scim/v2/Groups/[id]/route";
import { POST as createScimUser } from "@/app/scim/v2/Users/route";
import { GET as listScimUsers } from "@/app/scim/v2/Users/route";
import type { OidcIdentity, OidcSettings } from "@/types/auth";
import { closeDatabase, uniqueName } from "./support/database";
import { preserveSetting, TestData } from "./support/fixtures";

const ISSUER = "https://id.integration.test";
const PATCH_OP = "urn:ietf:params:scim:api:messages:2.0:PatchOp";
let restoreEnterprise: () => Promise<void>;
let restoreToken: () => Promise<void>;
let scimToken = "";
let roles: { admin: string; operator: string; viewer: string; finance: string };

before(async () => {
  restoreEnterprise = await preserveSetting("enterprise");
  restoreToken = await preserveSetting("scim_token_hash");
  await ensureSystemCatalog();
  scimToken = await issueScimToken();
  roles = {
    admin: (await templateRoleId("admin"))!,
    operator: (await templateRoleId("operator"))!,
    viewer: (await templateRoleId("viewer"))!,
    finance: (await templateRoleId("finance"))!,
  };
});

after(async () => {
  await restoreEnterprise();
  await restoreToken();
  await closeDatabase();
});

function identity(patch: Partial<OidcIdentity> = {}): OidcIdentity {
  const subject = patch.subject ?? uniqueName("sub");
  return {
    issuer: ISSUER,
    subject,
    email: `${uniqueName("sso")}@example.test`,
    groups: [],
    externalIds: [subject],
    ...patch,
  };
}

function settings(patch: Partial<OidcSettings> = {}): OidcSettings {
  return normalizeOidc({ enabled: true, issuer: ISSUER, client_id: "hub", ...patch });
}

function scim(method: string, path: string, body?: unknown) {
  return new Request(`http://hub.local/scim/v2${path}`, {
    method,
    headers: { authorization: `Bearer ${scimToken}`, "content-type": "application/scim+json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

test("SSO links issuer and subject once and finds the account again after an email change", async () => {
  const data = new TestData();
  try {
    await data.user();
    const first = identity();
    const created = await signInWithSso(first, settings(), null);
    data.ownUser(created.id);
    const link = await prisma.userIdentity.findUniqueOrThrow({
      where: { issuer_subject: { issuer: ISSUER, subject: first.subject } },
    });
    assert.equal(link.userId, created.id);

    const again = await signInWithSso({ ...first, email: `${uniqueName("renamed")}@example.test` }, settings(), null);
    assert.equal(again.id, created.id);
    assert.equal(await prisma.user.count({ where: { id: created.id } }), 1);
    assert.equal(await prisma.userIdentity.count({ where: { userId: created.id } }), 1);
  } finally {
    await data.cleanup();
  }
});

test("a verified email links an existing account but never a second subject of the same issuer", async () => {
  const data = new TestData();
  try {
    const user = await data.user();
    const linked = await signInWithSso(identity({ email: user.email }), settings(), null);
    assert.equal(linked.id, user.id);
    await assert.rejects(
      signInWithSso(identity({ email: user.email }), settings(), null),
      (err: unknown) => err instanceof SsoError && err.reason === "conflict",
    );
    await assert.rejects(
      signInWithSso(identity({ email: "" }), settings(), null),
      (err: unknown) => err instanceof SsoError && err.reason === "email",
    );
    const owner = await data.user({ isOwner: true });
    await assert.rejects(
      signInWithSso(identity({ email: owner.email }), settings(), null),
      (err: unknown) => err instanceof SsoError && err.reason === "owner",
    );
  } finally {
    await data.cleanup();
  }
});

test("allowed domains refuse other email domains and new accounts get the default role and company", async () => {
  const data = new TestData();
  try {
    await data.user();
    const org = await data.org();
    const scoped = settings({ allowed_domains: ["allowed.test"], default_role_id: roles.finance, default_org_id: org.id });
    await assert.rejects(
      signInWithSso(identity({ email: `${uniqueName("x")}@example.test` }), scoped, null),
      (err: unknown) => err instanceof SsoError && err.reason === "domain",
    );
    const created = await signInWithSso(identity({ email: `${uniqueName("x")}@allowed.test` }), scoped, null);
    data.ownUser(created.id);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: created.id } });
    assert.equal(user.roleId, roles.finance);
    assert.equal(user.orgId, org.id);
  } finally {
    await data.cleanup();
  }
});

test("group rules set the role at every sign-in and leave roles alone without rules", async () => {
  const data = new TestData();
  try {
    await data.user();
    const rules = settings({
      groups_claim: "groups",
      role_mappings: [
        { group: "LLM-Admins", role_id: roles.admin },
        { group: "llm-ops", role_id: roles.operator },
      ],
    });
    const person = identity({ groups: ["llm-ops", "llm-admins"] });
    const created = await signInWithSso(person, rules, "198.51.100.7");
    data.ownUser(created.id);
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: created.id } })).roleId, roles.admin);

    await signInWithSso({ ...person, groups: ["llm-ops"] }, rules, "198.51.100.7");
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: created.id } })).roleId, roles.operator);
    const events = await prisma.userSecurityEvent.findMany({ where: { userId: created.id, action: "role.changed" } });
    assert.equal(events.length, 1);
    assert.equal(events[0].actor, "sso");

    await signInWithSso({ ...person, groups: [] }, rules, null);
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: created.id } })).roleId, roles.viewer);

    await prisma.user.update({ where: { id: created.id }, data: { roleId: roles.finance } });
    await signInWithSso({ ...person, groups: ["llm-admins"] }, settings(), null);
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: created.id } })).roleId, roles.finance);
  } finally {
    await data.cleanup();
  }
});

test("SCIM groups use the same rules and a provisioned user signs in on the same row", async () => {
  const data = new TestData();
  const groupIds: string[] = [];
  try {
    await data.user();
    await patchEnterprise({
      oidc: settings({ role_mappings: [{ group: "hub-admins", role_id: roles.admin }] }),
    });
    const subject = uniqueName("okta-user");
    const email = `${uniqueName("scim")}@example.test`;
    const created = await createScimUser(scim("POST", "/Users", { userName: email, externalId: subject, active: true }));
    assert.equal(created.status, 201);
    const user = await created.json();
    data.ownUser(user.id);
    assert.equal(user.externalId, subject);
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).roleId, roles.viewer);

    const listed = await (await listScimUsers(scim("GET", `/Users?filter=externalId%20eq%20%22${subject}%22`))).json();
    assert.equal(listed.totalResults, 1);
    assert.equal(listed.Resources[0].id, user.id);

    const groupRes = await createGroup(scim("POST", "/Groups", { displayName: "hub-admins", externalId: uniqueName("grp") }));
    assert.equal(groupRes.status, 201);
    const group = await groupRes.json();
    groupIds.push(group.id);
    const params = { params: Promise.resolve({ id: group.id }) };
    const added = await patchGroup(
      scim("PATCH", `/Groups/${group.id}`, {
        schemas: [PATCH_OP],
        Operations: [{ op: "Add", path: "members", value: [{ value: user.id }, { value: "unknown-user" }] }],
      }),
      params,
    );
    assert.equal(added.status, 200);
    assert.deepEqual((await added.json()).members.map((member: { value: string }) => member.value), [user.id]);
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).roleId, roles.admin);

    const signedIn = await signInWithSso(
      identity({ subject, email: "", externalIds: [subject] }),
      normalizeOidc({ enabled: true, issuer: ISSUER, role_mappings: [{ group: "hub-admins", role_id: roles.admin }] }),
      null,
    );
    assert.equal(signedIn.id, user.id);
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).roleId, roles.admin);

    const removed = await patchGroup(
      scim("PATCH", `/Groups/${group.id}`, {
        schemas: [PATCH_OP],
        Operations: [{ op: "Remove", path: `members[value eq "${user.id}"]` }],
      }),
      params,
    );
    assert.equal(removed.status, 200);
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).roleId, roles.viewer);

    const duplicate = await createGroup(scim("POST", "/Groups", { displayName: "HUB-admins-2" }));
    groupIds.push((await duplicate.json()).id);
    const clash = await patchGroup(
      scim("PATCH", `/Groups/${group.id}`, {
        schemas: [PATCH_OP],
        Operations: [{ op: "replace", path: "displayName", value: "HUB-admins-2" }],
      }),
      params,
    );
    assert.equal(clash.status, 409);

    assert.equal((await deleteGroup(scim("DELETE", `/Groups/${group.id}`), params)).status, 204);
    assert.equal(await prisma.scimGroupMember.count({ where: { groupId: group.id } }), 0);
  } finally {
    await prisma.scimGroup.deleteMany({ where: { id: { in: groupIds } } });
    await data.cleanup();
  }
});
