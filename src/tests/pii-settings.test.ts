import assert from "node:assert/strict";
import test from "node:test";
import { runAsPrincipal } from "@/lib/auth/delegation";
import type { AuthenticatedSession, Permission } from "@/types/auth";

const settings = new Map<string, string>();
const audits: unknown[] = [];

(globalThis as { prisma?: unknown }).prisma = {
  setting: {
    findUnique: async ({ where }: { where: { key: string } }) =>
      settings.has(where.key) ? { key: where.key, value: settings.get(where.key) } : null,
    upsert: async ({ where, create }: { where: { key: string }; create: { value: string } }) => {
      settings.set(where.key, create.value);
      return { key: where.key, value: create.value };
    },
  },
  gatewayAuditLog: {
    create: async ({ data }: { data: unknown }) => {
      audits.push(data);
      return data;
    },
  },
};

function operator(permissions: Permission[]): AuthenticatedSession {
  return {
    error: false,
    sessionId: "",
    user: { id: "u1", username: "ops", email: "ops@example.com" } as AuthenticatedSession["user"],
    isOwner: false,
    role: null,
    permissions,
    secondFactor: "MANAGEMENT_KEY",
    ipAddress: null,
    userAgent: null,
  };
}

test("the global PII policy is validated before it is stored", async () => {
  const { savePii } = await import("@/lib/settings/guardrail-policies");
  const manager = operator(["settings:manage"]);
  for (const invalid of [
    { enabled: true, mode: "redact", output: true, entities: [] },
    { enabled: true, mode: "mask", output: true, entities: Array.from({ length: 101 }, (_, i) => `E${i}`) },
    { enabled: true, mode: "mask", output: true, entities: ["x".repeat(65)] },
    null,
  ]) {
    await assert.rejects(runAsPrincipal(manager, () => savePii(invalid)), /VALIDATION/);
  }
  assert.equal(audits.length, 0);
  const saved = await runAsPrincipal(manager, () =>
    savePii({ enabled: true, mode: "block", output: false, entities: ["EMAIL_ADDRESS"] }),
  );
  assert.deepEqual(saved.pii, {
    enabled: true,
    mode: "block",
    output: false,
    entities: ["EMAIL_ADDRESS"],
    detector: "patterns",
    failure: "patterns",
  });
  assert.equal(audits.length, 1);
});

test("saving the global PII policy needs settings:manage", async () => {
  const { savePii } = await import("@/lib/settings/guardrail-policies");
  await assert.rejects(
    runAsPrincipal(operator(["settings:read"]), () =>
      savePii({ enabled: true, mode: "mask", output: true, entities: [] }),
    ),
    /FORBIDDEN/,
  );
});
