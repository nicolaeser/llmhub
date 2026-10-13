import assert from "node:assert/strict";
import test from "node:test";
import {
  applyScimPatch,
  parseScimFilter,
  parseScimPatch,
  parseScimPut,
  parseScimUserBody,
  scimEmail,
  scimError,
  scimRoleKey,
  scimUserUpdate,
  toScimUser,
  SCIM_USER_SCHEMA,
} from "@/lib/auth/scim";
import {
  applyGroupOperations,
  parseScimGroupBody,
  parseScimGroupPatch,
  toScimGroup,
} from "@/lib/auth/scim-groups";
import type { ScimPatchOperation } from "@/types/scim";

const PATCH_OP = "urn:ietf:params:scim:api:messages:2.0:PatchOp";

function patch(...Operations: unknown[]) {
  return parseScimPatch({ schemas: [PATCH_OP], Operations });
}

function scimFailure(status: number, scimType?: string) {
  return (err: unknown) => {
    const failure = err as { status?: number; scimType?: string };
    return failure.status === status && failure.scimType === scimType;
  };
}

test("scimEmail prefers emails then userName", () => {
  assert.equal(
    scimEmail({
      userName: "fallback@ex.com",
      emails: [{ value: "Ada@Ex.com" }],
    }),
    "ada@ex.com",
  );
  assert.equal(scimEmail({ userName: "User@Ex.com" }), "user@ex.com");
});

test("scimRoleKey maps IdP roles onto role templates", () => {
  assert.equal(scimRoleKey({ roles: [{ value: "admin" }] }), "admin");
  assert.equal(scimRoleKey({ roles: [{ value: "proxy_admin" }] }), "viewer");
  assert.equal(scimRoleKey({ roles: [{ value: "operator" }] }), "operator");
  assert.equal(scimRoleKey({ roles: [{ value: "Finance" }] }), "finance");
  assert.equal(scimRoleKey({ roles: [{ value: "root" }] }), "viewer");
  assert.equal(scimRoleKey({}), "viewer");
});

test("toScimUser maps Prisma user to SCIM 2.0", () => {
  const resource = toScimUser({
    id: "u1",
    email: "ada@ex.com",
    blocked: false,
    role: { templateKey: "admin", name: null },
  });
  assert.deepEqual(resource.schemas, [SCIM_USER_SCHEMA]);
  assert.equal(resource.userName, "ada@ex.com");
  assert.equal(resource.active, true);
  assert.equal(resource.roles?.[0]?.value, "admin");
  assert.equal(toScimUser({ id: "u2", email: "b@ex.com", blocked: true }).active, false);
  assert.deepEqual(toScimUser({ id: "u3", email: "c@ex.com", blocked: false, role: null }).roles, []);
});

test("parseScimFilter reads eq filters on supported attributes only", () => {
  const attributes = ["userName", "emails.value", "externalId"];
  assert.deepEqual(parseScimFilter('userName eq "ada@ex.com"', attributes), {
    attribute: "userName",
    value: "ada@ex.com",
  });
  assert.deepEqual(parseScimFilter('emails.value EQ "Ada@Ex.com"', attributes), {
    attribute: "emails.value",
    value: "Ada@Ex.com",
  });
  assert.deepEqual(parseScimFilter('externalid eq "a\\"b"', attributes), { attribute: "externalId", value: 'a"b' });
  assert.equal(parseScimFilter(null, attributes), null);
  assert.equal(parseScimFilter("  ", attributes), null);
  assert.throws(() => parseScimFilter('title eq "x"', attributes), scimFailure(400, "invalidFilter"));
  assert.throws(() => parseScimFilter('userName co "x"', attributes), scimFailure(400, "invalidFilter"));
  assert.throws(
    () => parseScimFilter('userName eq "a" or userName eq "b"', attributes),
    scimFailure(400, "invalidFilter"),
  );
});

test("parseScimPatch and parseScimPut carry externalId", () => {
  assert.deepEqual(patch({ op: "add", path: "externalId", value: "00u1" }), [
    { op: "replace", attribute: "externalId", value: "00u1" },
  ]);
  assert.deepEqual(patch({ op: "remove", path: "externalId" }), [
    { op: "replace", attribute: "externalId", value: null },
  ]);
  assert.deepEqual(parseScimPut({ userName: "ada@ex.com", externalId: "00u1" }), [
    { op: "replace", attribute: "userName", value: "ada@ex.com" },
    { op: "replace", attribute: "externalId", value: "00u1" },
  ]);
  const current = { email: "ada@ex.com", username: "ada", blocked: false, roles: [], externalId: "00u1" };
  assert.deepEqual(scimUserUpdate(current, { externalId: "00u1" }), {});
  assert.deepEqual(scimUserUpdate(current, { externalId: null }), { externalId: null });
});

test("SCIM group PATCH adds, removes, and replaces members the way Entra and Okta send them", () => {
  const ops = (...Operations: unknown[]) => parseScimGroupPatch({ schemas: [PATCH_OP], Operations });
  assert.deepEqual(ops({ op: "Add", path: "members", value: [{ value: "u1" }, { value: "u2" }] }), [
    { kind: "addMembers", ids: ["u1", "u2"] },
  ]);
  assert.deepEqual(ops({ op: "Remove", path: 'members[value eq "u1"]' }), [{ kind: "removeMembers", ids: ["u1"] }]);
  assert.deepEqual(ops({ op: "remove", path: "members", value: [{ value: "u2" }] }), [
    { kind: "removeMembers", ids: ["u2"] },
  ]);
  assert.deepEqual(ops({ op: "remove", path: "members" }), [{ kind: "removeMembers", ids: null }]);
  assert.deepEqual(ops({ op: "replace", value: { displayName: "Admins", externalId: "g-1" } }), [
    { kind: "displayName", value: "Admins" },
    { kind: "externalId", value: "g-1" },
  ]);
  assert.throws(() => ops({ op: "remove", path: "displayName" }), scimFailure(400, "mutability"));
  assert.throws(() => ops({ op: "add", path: "members", value: "u1" }), scimFailure(400, "invalidValue"));
  const applied = applyGroupOperations(
    ["u1", "u2"],
    [
      { kind: "addMembers", ids: ["u3", "u1"] },
      { kind: "removeMembers", ids: ["u2"] },
      { kind: "displayName", value: "Ops" },
    ],
  );
  assert.deepEqual(applied, { members: ["u1", "u3"], displayName: "Ops", externalId: undefined });
  assert.deepEqual(applyGroupOperations(["u1"], [{ kind: "replaceMembers", ids: ["u9"] }]).members, ["u9"]);
  assert.deepEqual(applyGroupOperations(["u1"], [{ kind: "removeMembers", ids: null }]).members, []);
});

test("SCIM group resources need a display name", () => {
  assert.deepEqual(parseScimGroupBody({ displayName: "Admins", members: [{ value: "u1" }, { value: "u1" }] }), {
    displayName: "Admins",
    externalId: null,
    members: ["u1"],
  });
  assert.throws(() => parseScimGroupBody({ members: [] }), scimFailure(400, "invalidValue"));
  assert.throws(() => parseScimGroupBody(null), scimFailure(400, "invalidSyntax"));
  const group = toScimGroup({
    id: "g1",
    displayName: "Admins",
    externalId: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    members: [{ user: { id: "u1", email: "ada@ex.com" } }],
  });
  assert.deepEqual(group.members, [{ value: "u1", display: "ada@ex.com", type: "User" }]);
  assert.equal(group.meta.resourceType, "Group");
  assert.equal("externalId" in group, false);
});

test("parseScimUserBody reads SCIM POST payload", () => {
  const parsed = parseScimUserBody({
    userName: "ada@ex.com",
    emails: [{ value: "ada@ex.com", primary: true }],
    roles: [{ value: "viewer" }],
    active: true,
  });
  assert.equal(parsed.userName, "ada@ex.com");
  assert.equal(parsed.emails?.[0]?.value, "ada@ex.com");
  assert.equal(parsed.roles?.[0]?.value, "viewer");
  assert.equal(parsed.active, true);
});

test("scimEmail prefers the primary email", () => {
  assert.equal(
    scimEmail({
      emails: [{ value: "home@ex.com" }, { value: "Work@Ex.com", primary: true }],
    }),
    "work@ex.com",
  );
});

test("parseScimUserBody accepts SCIM string booleans and keeps absent roles absent", () => {
  const parsed = parseScimUserBody({ userName: "ada@ex.com", active: "False" });
  assert.equal(parsed.active, false);
  assert.equal(parsed.roles, undefined);
  assert.throws(() => parseScimUserBody(null), scimFailure(400, "invalidSyntax"));
  assert.throws(() => parseScimUserBody({ active: "maybe" }), scimFailure(400, "invalidValue"));
});

test("parseScimPatch reads path-based operations case-insensitively", () => {
  assert.deepEqual(patch({ op: "Replace", path: "active", value: "False" }), [
    { op: "replace", attribute: "active", value: false },
  ]);
  assert.deepEqual(patch({ op: "replace", path: "active", value: true }), [
    { op: "replace", attribute: "active", value: true },
  ]);
  assert.deepEqual(
    patch({ op: "replace", path: "urn:ietf:params:scim:schemas:core:2.0:User:userName", value: "ada@ex.com" }),
    [{ op: "replace", attribute: "userName", value: "ada@ex.com" }],
  );
  assert.deepEqual(
    patch({ op: "Add", path: 'emails[type eq "work"].value', value: "Ada@Ex.com" }),
    [{ op: "replace", attribute: "email", value: "Ada@Ex.com" }],
  );
  assert.deepEqual(
    patch({
      op: "replace",
      path: "emails",
      value: [{ value: "home@ex.com" }, { value: "work@ex.com", primary: true }],
    }),
    [{ op: "replace", attribute: "email", value: "work@ex.com" }],
  );
  assert.deepEqual(patch({ op: "add", path: "roles", value: [{ value: "operator" }] }), [
    { op: "replace", attribute: "roles", value: ["operator"] },
  ]);
  assert.deepEqual(patch({ op: "remove", path: 'roles[value eq "viewer"]' }), [
    { op: "remove", attribute: "roles", value: ["viewer"] },
  ]);
  assert.deepEqual(patch({ op: "remove", path: "roles" }), [
    { op: "remove", attribute: "roles", value: null },
  ]);
  assert.deepEqual(patch({ op: "replace", path: "displayName", value: "Ada" }), []);
});

test("parseScimPatch reads path-less operations", () => {
  assert.deepEqual(patch({ op: "replace", value: { active: false } }), [
    { op: "replace", attribute: "active", value: false },
  ]);
  assert.deepEqual(
    patch({
      op: "replace",
      value: { active: "True", userName: "ada@ex.com", "name.givenName": "Ada", roles: [{ value: "admin" }] },
    }),
    [
      { op: "replace", attribute: "active", value: true },
      { op: "replace", attribute: "userName", value: "ada@ex.com" },
      { op: "replace", attribute: "roles", value: ["admin"] },
    ],
  );
});

test("parseScimPatch rejects malformed messages with SCIM error types", () => {
  assert.throws(
    () => parseScimPatch({ Operations: [{ op: "replace", path: "active", value: false }] }),
    scimFailure(400, "invalidSyntax"),
  );
  assert.throws(() => patch({ op: "move", path: "active", value: false }), scimFailure(400, "invalidSyntax"));
  assert.throws(() => patch({ op: "remove" }), scimFailure(400, "noTarget"));
  assert.throws(() => patch({ op: "remove", path: "active" }), scimFailure(400, "invalidPath"));
  assert.throws(() => patch({ op: "remove", path: "emails" }), scimFailure(400, "invalidPath"));
  assert.throws(() => patch({ op: "replace", path: "active", value: "maybe" }), scimFailure(400, "invalidValue"));
  assert.throws(() => patch({ op: "replace", path: "userName", value: "" }), scimFailure(400, "invalidValue"));
  assert.throws(() => patch({ op: "replace", value: false }), scimFailure(400, "invalidValue"));
});

test("parseScimPut replaces the attributes of a full user resource", () => {
  assert.deepEqual(
    parseScimPut({
      schemas: [SCIM_USER_SCHEMA],
      userName: "ada",
      emails: [{ value: "Ada@Ex.com", primary: true }],
      active: "False",
      roles: [{ value: "finance" }],
    }),
    [
      { op: "replace", attribute: "userName", value: "ada" },
      { op: "replace", attribute: "email", value: "ada@ex.com" },
      { op: "replace", attribute: "active", value: false },
      { op: "replace", attribute: "roles", value: ["finance"] },
    ],
  );
  assert.deepEqual(parseScimPut({ userName: "ada@ex.com" }), [
    { op: "replace", attribute: "userName", value: "ada@ex.com" },
  ]);
  assert.throws(() => parseScimPut({ active: true }), scimFailure(400, "invalidValue"));
});

test("applyScimPatch keeps one role across remove and add in any order", () => {
  const removeViewer: ScimPatchOperation = { op: "remove", attribute: "roles", value: ["viewer"] };
  const addAdmin: ScimPatchOperation = { op: "replace", attribute: "roles", value: ["admin"] };
  assert.deepEqual(applyScimPatch([removeViewer, addAdmin], ["viewer"]).roles, ["admin"]);
  assert.deepEqual(applyScimPatch([addAdmin, removeViewer], ["viewer"]).roles, ["admin"]);
  assert.deepEqual(applyScimPatch([removeViewer], ["admin"]).roles, ["admin"]);
  assert.deepEqual(
    applyScimPatch([{ op: "remove", attribute: "roles", value: null }], ["admin"]).roles,
    [],
  );
  assert.deepEqual(applyScimPatch([], ["admin"]), {});
});

test("scimUserUpdate returns only real changes", () => {
  const current = { email: "ada@ex.com", username: "ada", blocked: false, roles: ["viewer"] };
  assert.deepEqual(
    scimUserUpdate(current, { userName: "ada@ex.com", email: "Ada@Ex.com", active: true, roles: ["Viewer"] }),
    {},
  );
  assert.deepEqual(scimUserUpdate(current, { active: false }), { blocked: true });
  assert.deepEqual(scimUserUpdate({ ...current, blocked: true }, { active: true }), { blocked: false });
  assert.deepEqual(scimUserUpdate(current, { userName: "new@ex.com" }), { email: "new@ex.com" });
  assert.deepEqual(scimUserUpdate(current, { userName: "Ada Lovelace" }), { username: "ada-lovelace" });
  assert.deepEqual(
    scimUserUpdate(current, { userName: "login@ex.com", email: "ada@ex.com" }),
    {},
  );
  assert.deepEqual(scimUserUpdate(current, { roles: ["Operator"] }), { roleKey: "operator" });
  assert.deepEqual(scimUserUpdate(current, { roles: ["proxy_admin"] }), {});
  assert.deepEqual(scimUserUpdate({ ...current, roles: ["admin"] }, { roles: ["proxy_admin"] }), {
    roleKey: "viewer",
  });
  assert.deepEqual(scimUserUpdate({ ...current, roles: ["admin"] }, { roles: [] }), {
    roleKey: "viewer",
  });
  assert.throws(() => scimUserUpdate(current, { email: "not-an-email" }), scimFailure(400, "invalidValue"));
});

test("scimError carries the SCIM error type", async () => {
  const res = scimError(409, "taken", "uniqueness");
  assert.equal(res.status, 409);
  assert.equal(res.headers.get("Content-Type"), "application/scim+json");
  const body = await res.json();
  assert.equal(body.scimType, "uniqueness");
  assert.equal(body.status, "409");
  assert.equal("scimType" in (await scimError(404, "not found").json()), false);
});
