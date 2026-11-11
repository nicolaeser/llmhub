import assert from "node:assert/strict";
import test from "node:test";
import { Prisma } from "@/generated/prisma/client";
import { GateError } from "@/lib/gateway/errors";
import { allowUnpaused } from "@/lib/gateway/access/gate";
import { sessionPrincipal } from "@/lib/gateway/access/principal";
import {
  heldPause,
  isPaused,
  keyPause,
  keyState,
  longestPause,
  MAX_PAUSE_HOURS,
  pauseActive,
  pauseEnd,
  pauseSnapshot,
  rowPause,
  stillHeld,
} from "@/lib/keys/pause";
import { toKeyView } from "@/lib/keys/view";
import { serializeApiKey } from "@/lib/management/serialize";
import { apiPauseSchema } from "@/schemas/management";
import { pauseKeySchema } from "@/schemas/keys";
import { pauseNodeSchema, resumeNodeSchema } from "@/schemas/tenancy";
import type { Principal } from "@/types/gateway";

const NOW = new Date("2026-10-28T12:00:00Z");
const HOUR_MS = 3_600_000;

function keyRow(pause: { paused: boolean; pausedUntil: Date | null }) {
  return {
    id: "k1",
    prefix: "sk-hub-abcde",
    keyAlias: "ci",
    userId: null,
    teamId: null,
    orgId: null,
    projectId: null,
    memberId: null,
    models: [],
    maxBudget: new Prisma.Decimal(0),
    spend: new Prisma.Decimal(0),
    rpmLimit: 0,
    tpmLimit: 0,
    maxRequestCost: new Prisma.Decimal(0),
    budgetDuration: "",
    expiresAt: null,
    allowedIps: [],
    allowedEndpoints: [],
    accessWindows: [],
    accessTimeZone: "UTC",
    blocked: false,
    logContent: true,
    createdAt: NOW,
    templates: [],
    ...pause,
  };
}

function principalOf(pause: { paused: boolean; pausedUntil: Date | null }): Principal {
  const key = toKeyView(keyRow(pause));
  return { actor: key.key_name, key, teamId: "", orgId: "", userId: "", memberId: "", models: [], routeLimits: {} };
}

test("a pause holds until its end and an open pause holds until it is resumed", () => {
  assert.equal(pauseActive(false, null, NOW), false);
  assert.equal(pauseActive(true, null, NOW), true);
  assert.equal(pauseActive(true, new Date(NOW.getTime() + 1), NOW), true);
  assert.equal(pauseActive(true, NOW, NOW), false);
  assert.equal(pauseEnd(0, NOW), null);
  assert.deepEqual(pauseEnd(24, NOW), new Date(NOW.getTime() + 24 * HOUR_MS));

  const until = new Date(NOW.getTime() + HOUR_MS).toISOString();
  assert.equal(isPaused({ paused: true, pausedUntil: until }, NOW), true);
  assert.equal(isPaused({ paused: true, pausedUntil: until }, new Date(NOW.getTime() + 2 * HOUR_MS)), false);
  assert.equal(keyState({ blocked: false, paused: true, pausedUntil: "" }, NOW), "paused");
  assert.equal(keyState({ blocked: true, paused: true, pausedUntil: "" }, NOW), "blocked");
  assert.equal(keyState({ blocked: false, paused: false, pausedUntil: "" }, NOW), "active");
});

test("key views report only a pause that still holds", () => {
  const open = toKeyView(keyRow({ paused: true, pausedUntil: null }));
  assert.equal(open.paused, true);
  assert.equal(open.paused_until, "");

  const until = new Date(Date.now() + HOUR_MS);
  const timed = toKeyView(keyRow({ paused: true, pausedUntil: until }));
  assert.equal(timed.paused, true);
  assert.equal(timed.paused_until, until.toISOString());
  assert.equal(serializeApiKey(timed).paused, true);
  assert.equal(serializeApiKey(timed).paused_until, until.toISOString());

  const ended = toKeyView(keyRow({ paused: true, pausedUntil: new Date(Date.now() - 1000) }));
  assert.equal(ended.paused, false);
  assert.equal(ended.paused_until, "");
  assert.equal(serializeApiKey(ended).paused_until, null);
});

test("the gate rejects paused keys with key_paused and names the end of a timed pause", () => {
  assert.doesNotThrow(() => allowUnpaused(principalOf({ paused: false, pausedUntil: null })));
  assert.doesNotThrow(() => allowUnpaused(principalOf({ paused: true, pausedUntil: new Date(Date.now() - 1000) })));
  assert.doesNotThrow(() => allowUnpaused(sessionPrincipal({ id: "u1", orgId: null })));
  assert.throws(
    () => allowUnpaused(principalOf({ paused: true, pausedUntil: null })),
    (err: unknown) =>
      err instanceof GateError &&
      err.status === 403 &&
      err.code === "key_paused" &&
      err.type === "permission_error" &&
      err.message === "this key is paused",
  );
  const until = new Date(Date.now() + HOUR_MS);
  assert.throws(
    () => allowUnpaused(principalOf({ paused: true, pausedUntil: until })),
    (err: unknown) => err instanceof GateError && err.message === `this key is paused until ${until.toISOString()}`,
  );
});

test("pause inputs take whole hours up to a year, zero for an open pause", () => {
  assert.deepEqual(pauseKeySchema.parse({ id: "k1" }), { id: "k1", hours: 0 });
  assert.equal(pauseKeySchema.parse({ id: "k1", hours: 24 }).hours, 24);
  assert.equal(pauseKeySchema.safeParse({ id: "k1", hours: -1 }).success, false);
  assert.equal(pauseKeySchema.safeParse({ id: "k1", hours: 1.5 }).success, false);
  assert.equal(pauseKeySchema.safeParse({ id: "k1", hours: MAX_PAUSE_HOURS + 1 }).success, false);
  assert.equal(pauseKeySchema.safeParse({ id: "", hours: 1 }).success, false);
  assert.deepEqual(apiPauseSchema.parse({}), { hours: 0 });
  assert.equal(apiPauseSchema.parse({ hours: 168 }).hours, 168);
  assert.equal(apiPauseSchema.safeParse({ hours: 1, until: "2026-11-01" }).success, false);
});

function hoursFromNow(hours: number, from = NOW): string {
  return new Date(from.getTime() + hours * HOUR_MS).toISOString();
}

test("the longest pause wins and an open pause outlasts every timed one", () => {
  assert.equal(longestPause([]), null);
  assert.equal(longestPause([null, undefined]), null);
  assert.deepEqual(
    longestPause([
      null,
      { scope: "team", until: hoursFromNow(1) },
      { scope: "org", until: hoursFromNow(3) },
      { scope: "member", until: hoursFromNow(2) },
    ]),
    { scope: "org", until: hoursFromNow(3) },
  );
  assert.deepEqual(longestPause([{ scope: "key", until: hoursFromNow(5) }, { scope: "project", until: "" }]), {
    scope: "project",
    until: "",
  });
  assert.deepEqual(longestPause([{ scope: "key", until: "" }, { scope: "org", until: "" }]), { scope: "key", until: "" });
  assert.equal(heldPause("org", { paused: true, pausedUntil: hoursFromNow(-1) }, NOW), null);
  assert.equal(heldPause("org", undefined, NOW), null);
  assert.deepEqual(rowPause("team", { paused: true, pausedUntil: null }, NOW), { scope: "team", until: "" });
  assert.equal(rowPause("team", { paused: false, pausedUntil: null }, NOW), null);
  assert.equal(rowPause("team", null, NOW), null);
  assert.equal(stillHeld({ scope: "org", until: hoursFromNow(1) }, new Date(NOW.getTime() + 2 * HOUR_MS)), null);
  assert.deepEqual(pauseSnapshot({ paused: true, pausedUntil: new Date(NOW.getTime() - 1) }, NOW), {
    paused: false,
    pausedUntil: null,
  });
});

test("a key counts as paused while its own pause or one of its person, project, department, or company holds", () => {
  const running = { blocked: false, paused: false, pausedUntil: "" };
  const company = { scope: "org", until: hoursFromNow(1) } as const;
  assert.equal(keyState(running, NOW), "active");
  assert.equal(keyState(running, NOW, company), "paused");
  assert.equal(keyState(running, new Date(NOW.getTime() + 2 * HOUR_MS), company), "active");
  assert.equal(keyState({ ...running, blocked: true }, NOW, company), "blocked");
  assert.deepEqual(keyPause({ paused: true, pausedUntil: hoursFromNow(2) }, company, NOW), {
    scope: "key",
    until: hoursFromNow(2),
  });
  assert.deepEqual(keyPause({ paused: true, pausedUntil: hoursFromNow(2) }, { scope: "member", until: "" }, NOW), {
    scope: "member",
    until: "",
  });
  assert.equal(keyPause(running, null, NOW), null);
});

test("the gate rejects keys whose person, project, department, or company is paused and names the longest pause", () => {
  const rejection = (principal: Principal) => {
    try {
      allowUnpaused(principal);
      return "";
    } catch (err) {
      assert.ok(err instanceof GateError);
      assert.equal(err.status, 403);
      assert.equal(err.code, "key_paused");
      return err.message;
    }
  };
  const running = principalOf({ paused: false, pausedUntil: null });
  const until = new Date(Date.now() + HOUR_MS).toISOString();
  const later = new Date(Date.now() + 3 * HOUR_MS).toISOString();
  assert.equal(rejection(running), "");
  assert.equal(rejection({ ...running, scopePause: { scope: "org", until: "" } }), "this key's company is paused");
  assert.equal(
    rejection({ ...running, scopePause: { scope: "team", until } }),
    `this key's department is paused until ${until}`,
  );
  assert.equal(rejection({ ...running, scopePause: { scope: "project", until } }), `this key's project is paused until ${until}`);
  assert.equal(rejection({ ...running, scopePause: { scope: "member", until: "" } }), "this key's person is paused");
  const ownOpen = principalOf({ paused: true, pausedUntil: null });
  assert.equal(rejection({ ...ownOpen, scopePause: { scope: "org", until: later } }), "this key is paused");
  const ownTimed = principalOf({ paused: true, pausedUntil: new Date(until) });
  assert.equal(
    rejection({ ...ownTimed, scopePause: { scope: "org", until: later } }),
    `this key's company is paused until ${later}`,
  );
});

test("pause inputs for companies, departments, projects, and people take the same hours as keys", () => {
  assert.deepEqual(pauseNodeSchema.parse({ kind: "org", id: "o1" }), { kind: "org", id: "o1", hours: 0 });
  assert.equal(pauseNodeSchema.parse({ kind: "member", id: "m1", hours: 168 }).hours, 168);
  assert.equal(pauseNodeSchema.parse({ kind: "team", id: " t1 " }).id, "t1");
  assert.equal(pauseNodeSchema.safeParse({ kind: "key", id: "k1" }).success, false);
  assert.equal(pauseNodeSchema.safeParse({ kind: "team", id: "t1", hours: MAX_PAUSE_HOURS + 1 }).success, false);
  assert.equal(pauseNodeSchema.safeParse({ kind: "project", id: "p1", hours: 2.5 }).success, false);
  assert.deepEqual(resumeNodeSchema.parse({ kind: "project", id: "p1" }), { kind: "project", id: "p1" });
  assert.equal(resumeNodeSchema.safeParse({ kind: "project", id: " " }).success, false);
});
