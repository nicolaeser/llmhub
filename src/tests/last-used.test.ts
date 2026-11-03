import { recordedPrisma } from "./support/recorded-prisma";
import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import { LAST_USED_WRITE_MS, markUsed } from "@/lib/gateway/billing/last-used";
import type { Principal } from "@/types/gateway";
import type { VirtualKeyView } from "@/types/keys";
import type { Deployment } from "@/types/routing";

let sequence = 0;

function keyPrincipal(keyId: string, change: Partial<Principal> = {}): Principal {
  return {
    actor: "sk-test",
    key: { token_id: keyId } as VirtualKeyView,
    teamId: "",
    orgId: "",
    userId: "",
    memberId: "",
    models: [],
    routeLimits: {},
    ...change,
  };
}

function deployment(kind: string, providerId: string): Deployment {
  return {
    id: `dep-${providerId}`,
    kind,
    base_url: "",
    model: "m",
    weight: 1,
    cost_input_per_1k: 0,
    cost_output_per_1k: 0,
    provider_id: providerId,
  };
}

function uniqueId(prefix: string): string {
  sequence += 1;
  return `${prefix}-${sequence}`;
}

beforeEach(() => recordedPrisma.reset());

test("marks the key and the subscription login with a stale-only condition", async () => {
  const keyId = uniqueId("key");
  const providerId = uniqueId("provider");
  const now = Date.UTC(2026, 10, 3, 12, 0, 0);
  await markUsed(keyPrincipal(keyId), deployment("claude", providerId), now);
  const [keyWrite] = recordedPrisma.called("virtualKey", "updateMany");
  const [loginWrite] = recordedPrisma.called("providerLogin", "updateMany");
  const stale = { OR: [{ lastUsedAt: null }, { lastUsedAt: { lt: new Date(now - LAST_USED_WRITE_MS) } }] };
  assert.deepEqual(keyWrite?.args, { where: { id: keyId, ...stale }, data: { lastUsedAt: new Date(now) } });
  assert.deepEqual(loginWrite?.args, { where: { providerId, ...stale }, data: { lastUsedAt: new Date(now) } });
});

test("writes each id at most once per window in a process", async () => {
  const keyId = uniqueId("key");
  const providerId = uniqueId("provider");
  const now = Date.UTC(2026, 10, 3, 12, 0, 0);
  await markUsed(keyPrincipal(keyId), deployment("codex", providerId), now);
  await markUsed(keyPrincipal(keyId), deployment("codex", providerId), now + LAST_USED_WRITE_MS - 1);
  assert.equal(recordedPrisma.called("virtualKey", "updateMany").length, 1);
  assert.equal(recordedPrisma.called("providerLogin", "updateMany").length, 1);
  await markUsed(keyPrincipal(keyId), deployment("codex", providerId), now + LAST_USED_WRITE_MS);
  assert.equal(recordedPrisma.called("virtualKey", "updateMany").length, 2);
  assert.equal(recordedPrisma.called("providerLogin", "updateMany").length, 2);
});

test("skips API providers, keyless callers, and system callers", async () => {
  const now = Date.UTC(2026, 10, 3, 12, 0, 0);
  await markUsed(keyPrincipal(uniqueId("key")), deployment("anthropic", uniqueId("provider")), now);
  assert.equal(recordedPrisma.called("providerLogin").length, 0);
  assert.equal(recordedPrisma.called("virtualKey").length, 1);

  recordedPrisma.reset();
  await markUsed(keyPrincipal("", { key: undefined }), deployment("claude", uniqueId("provider")), now);
  assert.equal(recordedPrisma.called("virtualKey").length, 0);
  assert.equal(recordedPrisma.called("providerLogin").length, 1);

  recordedPrisma.reset();
  await markUsed(keyPrincipal("", { key: undefined, system: "kickoff" }), deployment("claude", uniqueId("provider")), now);
  assert.equal(recordedPrisma.calls.length, 0);
});

test("a failed write never fails metering", async () => {
  recordedPrisma.reset({
    virtualKey: {
      updateMany: () => {
        throw new Error("connection lost");
      },
    },
  });
  await assert.doesNotReject(markUsed(keyPrincipal(uniqueId("key")), null, Date.UTC(2026, 10, 3, 12, 0, 0)));
});
