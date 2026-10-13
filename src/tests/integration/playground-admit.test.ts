import assert from "node:assert/strict";
import { after, test } from "node:test";
import prisma from "@/lib/db/prisma";
import { POST } from "@/app/internal-api/playground/chat/route";
import { SESSION_COOKIE } from "@/lib/auth/cookie";
import { PERMISSIONS } from "@/lib/auth/permissions";
import { createSession } from "@/lib/auth/session";
import { incrementRateWindow } from "@/lib/rate-limit/shared";
import { closeDatabase, createUser, uniqueName } from "./support/database";
import { cookies, setRequestHeaders } from "./support/next-request.mjs";

after(closeDatabase);

test("the playground admits the signed-in user through their budget before it routes the request", async () => {
  const role = await prisma.role.create({
    data: { name: uniqueName("role"), permissions: [PERMISSIONS.PLAYGROUND_USE] },
  });
  const user = await createUser();
  const model = uniqueName("model");
  try {
    await prisma.user.update({ where: { id: user.id }, data: { roleId: role.id, maxBudget: 1, spend: 1 } });
    const { cookie } = await createSession(user.id, "TOTP", { ipAddress: null, userAgent: null });
    setRequestHeaders({});
    (await cookies()).set(SESSION_COOKIE, cookie);
    const chat = () =>
      POST(
        new Request("http://localhost:3000/internal-api/playground/chat", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model, messages: [{ role: "user", content: "hello" }] }),
        }),
      );

    const spent = await chat();
    assert.equal(spent.status, 429);
    assert.equal((await spent.json()).detail, "user budget exceeded");
    assert.equal((await incrementRateWindow(user.id, 0, 0)).rpm, 0);
    assert.equal(await prisma.requestLog.count({ where: { userId: user.id } }), 0);

    await prisma.user.update({ where: { id: user.id }, data: { spend: 0 } });
    const funded = await chat();
    assert.equal(funded.status, 404);
    assert.equal((await funded.json()).code, "MODEL_NOT_FOUND");
    assert.equal(await prisma.requestLog.count({ where: { userId: user.id } }), 1);
    assert.equal((await incrementRateWindow(user.id, 0, 0)).rpm, 1);
  } finally {
    await prisma.requestLog.deleteMany({ where: { userId: user.id } });
    await prisma.usageDaily.deleteMany({ where: { userId: user.id } });
    await prisma.spendEvent.deleteMany({ where: { userId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });
    await prisma.role.delete({ where: { id: role.id } });
  }
});
