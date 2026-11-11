import assert from "node:assert/strict";
import { after, test } from "node:test";
import pg from "pg";

type QueryCallback = (error: unknown, result?: unknown) => void;

const driverQuery = pg.Client.prototype.query as unknown as (this: pg.Client, ...args: unknown[]) => unknown;
const inFlight = new WeakMap<pg.Client, number>();
const probe = { calls: 0, overlaps: 0 };

function track(client: pg.Client): () => void {
  const running = inFlight.get(client) ?? 0;
  probe.calls += 1;
  if (running > 0) probe.overlaps += 1;
  inFlight.set(client, running + 1);
  let finished = false;
  return () => {
    if (finished) return;
    finished = true;
    inFlight.set(client, (inFlight.get(client) ?? 1) - 1);
  };
}

pg.Client.prototype.query = function (this: pg.Client, ...args: unknown[]) {
  const finish = track(this);
  const callbackIndex = args.findIndex((arg, index) => index > 0 && typeof arg === "function");
  if (callbackIndex > 0) {
    const callback = args[callbackIndex] as QueryCallback;
    args[callbackIndex] = (error: unknown, result: unknown) => {
      finish();
      callback(error, result);
    };
  }
  try {
    const result = driverQuery.apply(this, args);
    if (callbackIndex < 0 && result instanceof Promise) result.then(finish, finish);
    else if (callbackIndex < 0) finish();
    return result;
  } catch (error) {
    finish();
    throw error;
  }
} as unknown as pg.Client["query"];

after(async () => {
  const { closeDatabase } = await import("./support/database");
  await closeDatabase();
});

function resetProbe() {
  probe.calls = 0;
  probe.overlaps = 0;
}

type Fixtures = typeof import("./support/fixtures");

async function seedOrganization(data: InstanceType<Fixtures["TestData"]>) {
  const org = await data.org();
  const team = await data.team(org.id);
  const project = await data.project(org.id, team.id);
  const member = await data.member(org.id, team.id);
  const user = await data.user({ orgId: org.id });
  const select = {
    teams: { select: { id: true, projects: { select: { id: true } }, members: { select: { id: true } } } },
    projects: { select: { id: true } },
    members: { select: { id: true } },
    users: { select: { id: true } },
    keys: { select: { id: true } },
  };
  const expected = {
    teams: [{ id: team.id, projects: [{ id: project.id }], members: [{ id: member.id }] }],
    projects: [{ id: project.id }],
    members: [{ id: member.id }],
    users: [{ id: user.id }],
    keys: [],
  };
  return { org, select, expected };
}

test("a transaction that loads several relations at once sends one query at a time on its connection", async () => {
  const { default: prisma } = await import("@/lib/db/prisma");
  const { withSerializableRetry } = await import("@/lib/db/serializable");
  const { TestData } = await import("./support/fixtures");
  const data = new TestData();
  try {
    const { org, select, expected } = await seedOrganization(data);
    resetProbe();
    const interactive = await prisma.$transaction((tx) => tx.organization.findUnique({ where: { id: org.id }, select }));
    const serializable = await withSerializableRetry((tx) =>
      tx.organization.findUnique({ where: { id: org.id }, select }),
    );
    assert.deepEqual(interactive, expected);
    assert.deepEqual(serializable, expected);
    assert.ok(probe.calls > 2 * Object.keys(select).length);
    assert.equal(probe.overlaps, 0);
  } finally {
    await data.cleanup();
  }
});

test("a transaction that fails after loading relations rolls back and later transactions still run", async () => {
  const { default: prisma } = await import("@/lib/db/prisma");
  const { TestData } = await import("./support/fixtures");
  const data = new TestData();
  try {
    const { org, select, expected } = await seedOrganization(data);
    resetProbe();
    await assert.rejects(
      prisma.$transaction(async (tx) => {
        const loaded = await tx.organization.findUnique({ where: { id: org.id }, select });
        assert.deepEqual(loaded, expected);
        await tx.team.create({ data: { alias: `${org.alias}-rolled-back`, orgId: org.id } });
        await tx.organization.create({ data: { id: org.id, alias: org.alias } });
      }),
      (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "P2002",
    );
    const attempts = await Promise.all(
      Array.from({ length: 3 }, () =>
        prisma.$transaction((tx) => tx.organization.findUnique({ where: { id: org.id }, select })),
      ),
    );
    assert.deepEqual(attempts, [expected, expected, expected]);
    assert.equal(await prisma.team.count({ where: { alias: `${org.alias}-rolled-back` } }), 0);
    assert.equal(probe.overlaps, 0);
  } finally {
    await data.cleanup();
  }
});
