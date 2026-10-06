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
} from "@/lib/gateway/scim";
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

test("parseScimFilter extracts userName eq", () => {
  assert.deepEqual(
    parseScimFilter('userName eq "ada@ex.com"'),
    { email: "ada@ex.com" },
  );
  assert.deepEqual(
    parseScimFilter('emails.value eq "Ada@Ex.com"'),
    { email: "ada@ex.com" },
  );
  assert.deepEqual(parseScimFilter(null), {});
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
