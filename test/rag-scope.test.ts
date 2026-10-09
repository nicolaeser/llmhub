import assert from "node:assert/strict";
import test from "node:test";
import { companyStores, ownedStores, ownsStore, readableStores, readsStore, scopeOf, storeOwner } from "@/lib/rag/scope";
import type { Principal, VirtualKeyView } from "@/types/gateway";
import type { VectorStoreOwner } from "@/types/rag";

function principal(input: { orgId?: string; userId?: string; memberId?: string; projectId?: string; keyed?: boolean }): Principal {
  const key = input.keyed === false
    ? undefined
    : ({ token_id: "key-1", project_id: input.projectId ?? "", member_id: input.memberId ?? "" } as VirtualKeyView);
  return {
    actor: "sk-test",
    key,
    teamId: "",
    orgId: input.orgId ?? "",
    userId: input.userId ?? "",
    memberId: input.memberId ?? "",
    models: [],
    routeLimits: {},
  };
}

const store = (owner: Partial<VectorStoreOwner>): VectorStoreOwner => ({
  orgId: null,
  projectId: null,
  memberId: null,
  userId: null,
  ...owner,
});

test("stores are owned by the caller's project, person, or console user and always carry the company", () => {
  assert.deepEqual(storeOwner(principal({ orgId: "acme", projectId: "p1" })), {
    orgId: "acme",
    projectId: "p1",
    memberId: null,
    userId: null,
  });
  assert.deepEqual(storeOwner(principal({ orgId: "acme", memberId: "m1" })), {
    orgId: "acme",
    projectId: null,
    memberId: "m1",
    userId: null,
  });
  assert.deepEqual(storeOwner(principal({ userId: "u1" })), { orgId: null, projectId: null, memberId: null, userId: "u1" });
  assert.deepEqual(storeOwner(principal({ keyed: false, orgId: "acme", userId: "u2" })), {
    orgId: "acme",
    projectId: null,
    memberId: null,
    userId: "u2",
  });
  assert.throws(() => storeOwner(principal({ orgId: "acme" })), /no project, person, or owner/);
});

test("project keys share their project's stores but never another project's or company's", () => {
  const caller = principal({ orgId: "acme", projectId: "p1" });
  assert.equal(readsStore(caller, store({ orgId: "acme", projectId: "p1" })), true);
  assert.equal(ownsStore(caller, store({ orgId: "acme", projectId: "p1" })), true);
  assert.equal(readsStore(caller, store({ orgId: "acme", projectId: "p2" })), false);
  assert.equal(readsStore(caller, store({ orgId: "acme", memberId: "m1" })), false);
  assert.equal(readsStore(caller, store({ orgId: "globex", projectId: "p1" })), false);
  assert.equal(readsStore(caller, store({ orgId: "globex" })), false);
});

test("company-wide stores are readable by every key of that company and writable by none", () => {
  const companyStore = store({ orgId: "acme" });
  assert.equal(scopeOf(companyStore), "organization");
  for (const caller of [
    principal({ orgId: "acme", projectId: "p1" }),
    principal({ orgId: "acme", memberId: "m1" }),
    principal({ orgId: "acme", userId: "u1" }),
  ]) {
    assert.equal(readsStore(caller, companyStore), true);
    assert.equal(ownsStore(caller, companyStore), false);
  }
  assert.equal(readsStore(principal({ userId: "u1" }), store({ orgId: null })), false);
  assert.equal(readsStore(principal({ orgId: "globex", projectId: "p9" }), companyStore), false);
});

test("a console user who changes company loses access to stores of the old company", () => {
  const old = store({ orgId: "acme", userId: "u1" });
  assert.equal(readsStore(principal({ orgId: "acme", userId: "u1" }), old), true);
  assert.equal(readsStore(principal({ orgId: "globex", userId: "u1" }), old), false);
  assert.equal(readsStore(principal({ userId: "u1" }), old), false);
});

test("Prisma filters mirror the in-memory access rules", () => {
  assert.deepEqual(ownedStores(principal({ orgId: "acme", projectId: "p1" })), { orgId: "acme", projectId: "p1" });
  assert.deepEqual(ownedStores(principal({ userId: "u1" })), {
    orgId: null,
    userId: "u1",
    projectId: null,
    memberId: null,
  });
  assert.deepEqual(readableStores(principal({ orgId: "acme", memberId: "m1" })), {
    OR: [{ orgId: "acme", memberId: "m1" }, companyStores("acme")],
  });
  assert.deepEqual(readableStores(principal({ userId: "u1" })), ownedStores(principal({ userId: "u1" })));
});
