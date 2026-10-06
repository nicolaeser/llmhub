import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("key server actions require permission checks", async () => {
  const source = await readFile(
    new URL("../src/app/(app)/_action.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /requirePermission/);
  assert.match(source, /KEYS_MANAGE/);
  assert.match(source, /keyVisibleTo/);
});

test("role management actions are gated on roles:manage", async () => {
  const source = await readFile(
    new URL("../src/app/(app)/roles/_action.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /requirePermission/);
  assert.match(source, /ROLES_MANAGE/);
  assert.doesNotMatch(source, /revalidatePath|router\.refresh/);
});

test("structure actions gate tenancy and budget writes", async () => {
  const source = await readFile(
    new URL("../src/app/(app)/structure/_action.ts", import.meta.url),
    "utf8",
  );
  for (const name of ["saveOrgAction", "saveTeamAction", "saveProjectAction", "deleteNodeAction", "placeMemberAction"]) {
    const start = source.indexOf(`export async function ${name}`);
    assert.notEqual(start, -1, name);
    const next = source.indexOf("\nexport ", start + 1);
    assert.match(source.slice(start, next === -1 ? undefined : next), /PERMISSIONS\.TENANCY_MANAGE/, name);
  }
  for (const name of ["setBudgetAction", "addBoostAction", "removeBoostAction", "saveBudgetAlertsAction"]) {
    const start = source.indexOf(`export async function ${name}`);
    assert.notEqual(start, -1, name);
    const next = source.indexOf("\nexport ", start + 1);
    assert.match(source.slice(start, next === -1 ? undefined : next), /PERMISSIONS\.BUDGETS_MANAGE/, name);
  }
  assert.match(source, /keyVisibleTo/);
  assert.match(source, /capConflict/);
  assert.match(source, /HAS_CHILDREN/);
  assert.doesNotMatch(source, /revalidatePath|router\.refresh/);
});

test("joining a team places the user in the team's organization", async () => {
  const source = await readFile(
    new URL("../src/app/(app)/structure/_action.ts", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("export async function placeMemberAction");
  const fn = source.slice(start, source.indexOf("\nexport ", start + 1));
  assert.match(fn, /const orgId = team\?\.orgId \?\? wantedOrg/);
  assert.match(fn, /team\.orgId !== wantedOrg/);
});

test("keys can only bind to the creator's own team without tenancy:manage", async () => {
  const source = await readFile(
    new URL("../src/app/(app)/_action.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /TEAM_NOT_MEMBER/);
  assert.match(source, /team\.id !== session\.user\.teamId/);
  assert.match(source, /PERMISSIONS\.TENANCY_MANAGE/);
});

test("user console actions are permission-gated and protect the owner", async () => {
  const [actions, lib] = await Promise.all([
    readFile(new URL("../src/app/(app)/users/_action.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/lib/auth/users.ts", import.meta.url), "utf8"),
  ]);
  assert.match(actions, /USERS_READ/);
  assert.match(actions, /USERS_MANAGE/);
  assert.match(actions, /USERS_SECURITY/);
  for (const name of ["createUserAction", "deleteUserAction", "setUserPasswordAction", "assignUserRoleAction", "resetUserTwoFactorAction", "revokeUserSessionsAction"]) {
    assert.match(actions, new RegExp(name));
  }
  assert.doesNotMatch(actions, /revalidatePath/);
  assert.match(lib, /OWNER_PROTECTED/);
  assert.match(lib, /CANNOT_SELF/);
  assert.match(lib, /USER_PROTECTED/);
  assert.match(lib, /USER_EXISTS/);
  assert.match(lib, /assertCanGrant/);
  assert.match(lib, /sessions: \{ deleteMany: \{\} \}/);
});
