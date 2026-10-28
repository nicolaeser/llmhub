import assert from "node:assert/strict";
import test from "node:test";
import { Prisma } from "@/generated/prisma/client";
import { GateError } from "@/lib/gateway/errors";
import { allowUnpaused } from "@/lib/gateway/access/gate";
import { sessionPrincipal } from "@/lib/gateway/access/principal";
import { isKeyPaused, keyState, MAX_KEY_PAUSE_HOURS, pauseActive, pauseEnd } from "@/lib/keys/pause";
import { toKeyView } from "@/lib/keys/view";
import { serializeApiKey } from "@/lib/management/serialize";
import { apiKeyPauseSchema } from "@/schemas/management";
import { pauseKeySchema } from "@/schemas/keys";
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
  assert.equal(isKeyPaused({ paused: true, pausedUntil: until }, NOW), true);
  assert.equal(isKeyPaused({ paused: true, pausedUntil: until }, new Date(NOW.getTime() + 2 * HOUR_MS)), false);
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
  assert.equal(pauseKeySchema.safeParse({ id: "k1", hours: MAX_KEY_PAUSE_HOURS + 1 }).success, false);
  assert.equal(pauseKeySchema.safeParse({ id: "", hours: 1 }).success, false);
  assert.deepEqual(apiKeyPauseSchema.parse({}), { hours: 0 });
  assert.equal(apiKeyPauseSchema.parse({ hours: 168 }).hours, 168);
  assert.equal(apiKeyPauseSchema.safeParse({ hours: 1, until: "2026-11-01" }).success, false);
});
