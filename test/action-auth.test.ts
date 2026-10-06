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

test("company actions gate tenancy and budget writes", async () => {
  const source = await readFile(
    new URL("../src/app/(app)/companies/_action.ts", import.meta.url),
    "utf8",
  );
  for (const name of ["saveOrgAction", "saveTeamAction", "saveProjectAction", "saveMemberAction", "deleteNodeAction"]) {
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

test("departments, projects, and people stay inside one company", async () => {
  const source = await readFile(
    new URL("../src/app/(app)/companies/_action.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /if \(team\.orgId !== orgId\) throw new Error\("TEAM_NOT_IN_ORG"\)/);
  for (const name of ["saveTeamAction", "saveProjectAction", "saveMemberAction"]) {
    const start = source.indexOf(`export async function ${name}`);
    const fn = source.slice(start, source.indexOf("\nexport ", start + 1));
    assert.match(fn, /await companyFor\(session, input\.orgId\)/, name);
    assert.match(fn, /throw new Error\("ORG_LOCKED"\)/, name);
  }
  const org = source.slice(source.indexOf("export async function saveOrgAction"));
  assert.match(org.slice(0, org.indexOf("\nexport ", 1)), /assertPlatform\(session\)/);
  assert.match(source, /PLATFORM_BUDGETS: readonly BudgetKind\[\] = \["org", "user"\]/);
  assert.match(source, /inCompany\(session, record\.orgId\)/);
});

test("keys bind to one project or one person inside the caller's company", async () => {
  const source = await readFile(
    new URL("../src/app/(app)/_action.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /if \(projectId && memberId\) throw new Error\("KEY_BINDING_CONFLICT"\)/);
  assert.match(source, /!inCompany\(session, project\.orgId\)/);
  assert.match(source, /!inCompany\(session, member\.orgId\)/);
  assert.doesNotMatch(source, /TEAM_NOT_MEMBER/);
  assert.match(
    source,
    /if \(\(projectId \|\| memberId\) && !unchanged && !hasPerm\(session\.permissions, PERMISSIONS\.TENANCY_MANAGE\)\) \{\n\s+throw new Error\("FORBIDDEN"\);/,
  );
  assert.match(source, /await keyBinding\(session, input\.projectId, input\.memberId, existing\)/);
});

test("PATCH /api/keys replaces the whole binding when either reference is sent", async () => {
  const source = await readFile(new URL("../src/app/api/keys/[id]/route.ts", import.meta.url), "utf8");
  assert.match(source, /const rebinds = body\.project_id !== undefined \|\| body\.member_id !== undefined;/);
  assert.match(source, /projectId: rebinds \? \(body\.project_id \?\? ""\) : current\.project_id/);
  assert.match(source, /memberId: rebinds \? \(body\.member_id \?\? ""\) : current\.member_id/);
});

test("user console actions are permission-gated and protect the owner", async () => {
  const [actions, lib] = await Promise.all([
    readFile(new URL("../src/app/(app)/users/_action.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/lib/auth/users.ts", import.meta.url), "utf8"),
  ]);
  assert.match(actions, /USERS_READ/);
  assert.match(actions, /USERS_MANAGE/);
  assert.match(actions, /USERS_SECURITY/);
  for (const name of ["createUserAction", "deleteUserAction", "setUserPasswordAction", "assignUserAccessAction", "resetUserTwoFactorAction", "revokeUserSessionsAction"]) {
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
