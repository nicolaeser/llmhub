import assert from "node:assert/strict";
import { after, test } from "node:test";
import prisma from "@/lib/db/prisma";
import { runAsPrincipal } from "@/lib/auth/delegation";
import { AuthError } from "@/lib/auth/errors";
import { permissions } from "@/lib/auth/permissions";
import { digest } from "@/lib/crypto";
import { issueScimToken, revokeScimToken, saveAdminSettings } from "@/lib/settings/admin";
import { GET as listScimUsers } from "@/app/scim/v2/Users/route";
import { closeDatabase } from "./support/database";
import { enrollTotp, totpCode, wrongTotpCode } from "./support/factors";
import { preserveSetting, sessionOf, TestData } from "./support/fixtures";

after(closeDatabase);

const authError = (code: string) => (err: unknown) => err instanceof AuthError && err.code === code;

async function scimStatus(token: string) {
  const res = await listScimUsers(
    new Request("http://hub.local/scim/v2/Users?count=1", { headers: { authorization: `Bearer ${token}` } }),
  );
  return res.status;
}

test("SCIM tokens need settings:manage, every permission, and a step-up code", async () => {
  const data = new TestData();
  const restore = await preserveSetting("scim_token_hash");
  try {
    const before = await prisma.setting.findUnique({ where: { key: "scim_token_hash" } });
    const reader = sessionOf(await data.user(), { permissions: ["settings:read"] });
    const settingsOnly = sessionOf(await data.user(), { permissions: ["settings:read", "settings:manage"] });
    const adminUser = await data.user();
    const { secret } = await enrollTotp(adminUser.id);
    const admin = sessionOf(adminUser, { permissions: [...permissions] });

    await assert.rejects(runAsPrincipal(reader, () => issueScimToken({ code: "123456" })), authError("FORBIDDEN"));
    await assert.rejects(
      runAsPrincipal(settingsOnly, () => issueScimToken({ code: "123456" })),
      authError("INVALID_SCOPE"),
    );
    await assert.rejects(
      runAsPrincipal(admin, async () => issueScimToken({ code: await wrongTotpCode(secret) })),
      authError("INVALID_SECOND_FACTOR"),
    );
    assert.deepEqual(await prisma.setting.findUnique({ where: { key: "scim_token_hash" } }), before);

    const { scimToken } = await runAsPrincipal(admin, async () => issueScimToken({ code: await totpCode(secret) }));
    assert.equal((await prisma.setting.findUniqueOrThrow({ where: { key: "scim_token_hash" } })).value, digest(scimToken));
    assert.equal(await scimStatus(scimToken), 200);

    await assert.rejects(
      runAsPrincipal(admin, async () => revokeScimToken({ code: await wrongTotpCode(secret) })),
      authError("INVALID_SECOND_FACTOR"),
    );
    assert.equal(await scimStatus(scimToken), 200);
    await runAsPrincipal(admin, async () => revokeScimToken({ code: await totpCode(secret, 1) }));
    assert.equal(await scimStatus(scimToken), 401);
  } finally {
    await restore();
    await data.cleanup();
  }
});

test("admin settings are validated and need settings:manage", async () => {
  const data = new TestData();
  const restore = await preserveSetting("enterprise");
  try {
    const before = await prisma.setting.findUnique({ where: { key: "enterprise" } });
    const reader = sessionOf(await data.user(), { permissions: ["settings:read"] });
    const admin = sessionOf(await data.user(), { permissions: ["settings:read", "settings:manage"] });
    await assert.rejects(runAsPrincipal(reader, () => saveAdminSettings({})), authError("FORBIDDEN"));
    await assert.rejects(
      runAsPrincipal(admin, () => saveAdminSettings({ registration_enabled: "yes" })),
      (err: unknown) => err instanceof Error && err.message === "VALIDATION",
    );
    assert.deepEqual(await prisma.setting.findUnique({ where: { key: "enterprise" } }), before);
  } finally {
    await restore();
    await data.cleanup();
  }
});
