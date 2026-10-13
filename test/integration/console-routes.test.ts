import assert from "node:assert/strict";
import { after, afterEach, beforeEach, test } from "node:test";
import { cookies } from "next/headers";
import prisma from "@/lib/db/prisma";
import { env } from "@/lib/env";
import { SESSION_COOKIE } from "@/lib/auth/cookie";
import { createSession } from "@/lib/auth/session";
import { authenticateBearer } from "@/lib/gateway/access/principal";
import { POST as tryRoute } from "@/app/internal-api/api-ref/try/route";
import { POST as assistantChat } from "@/app/internal-api/assistant/chat/route";
import type { Permission } from "@/types/auth";
import { closeDatabase, uniqueName } from "./support/database";
import { TestData } from "./support/fixtures";
import { setRequestHeaders } from "./support/next-request.mjs";

after(closeDatabase);

const ORIGIN = new URL(env.NEXT_PUBLIC_APP_URL).origin;
const realFetch = globalThis.fetch;
let outbound: { url: string; init: RequestInit; body: Record<string, unknown> }[] = [];

beforeEach(() => {
  outbound = [];
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    outbound.push({ url: String(input), init, body: init.body ? JSON.parse(String(init.body)) : {} });
    return new Response(
      JSON.stringify({
        id: "chatcmpl-test",
        object: "list",
        data: [],
        choices: [{ index: 0, message: { role: "assistant", content: "Done." }, finish_reason: "stop" }],
        usage: { prompt_tokens: 3, completion_tokens: 2 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

async function signedIn(data: TestData, permissions: Permission[], toolsOff: string[] = []) {
  const role = await prisma.role.create({
    data: { name: uniqueName("role"), permissions, assistantToolsDisabled: toolsOff },
  });
  const user = await data.user();
  await prisma.user.update({ where: { id: user.id }, data: { roleId: role.id } });
  const { cookie } = await createSession(user.id, "TOTP", { ipAddress: null, userAgent: null });
  setRequestHeaders({});
  (await cookies()).set(SESSION_COOKIE, cookie);
  return { user, role };
}

function post(path: string, body: unknown) {
  return new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { origin: ORIGIN, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function cleanup(data: TestData, roleIds: string[], userIds: string[], alias?: string) {
  await prisma.requestLog.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.spendEvent.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.usageDaily.deleteMany({ where: { userId: { in: userIds } } });
  await data.cleanup();
  await prisma.role.deleteMany({ where: { id: { in: roleIds } } });
  if (alias) await prisma.modelGroup.deleteMany({ where: { alias } });
}

test("the API reference try route needs playground access and calls only catalog gateway paths", async () => {
  const data = new TestData();
  const roles: string[] = [];
  const users: string[] = [];
  try {
    setRequestHeaders({});
    const anonymous = post("/internal-api/api-ref/try", { method: "GET", path: "/api/v1/models" });
    assert.equal((await tryRoute(anonymous)).status, 401);
    assert.equal(anonymous.bodyUsed, false);

    const viewer = await signedIn(data, ["keys:read"]);
    roles.push(viewer.role.id);
    assert.equal((await tryRoute(post("/internal-api/api-ref/try", { method: "GET", path: "/api/v1/models" }))).status, 403);

    const tester = await signedIn(data, ["playground:use"]);
    roles.push(tester.role.id);
    users.push(tester.user.id);
    for (const path of ["/internal-api/setup", "/api/mgmt/keys", "/api/v1/models/{id}"]) {
      const res = await tryRoute(post("/internal-api/api-ref/try", { method: "GET", path, params: { id: "../../internal-api" } }));
      assert.ok(res.status >= 400, path);
    }
    assert.equal(outbound.length, 0);

    const res = await tryRoute(post("/internal-api/api-ref/try", { method: "GET", path: "/api/v1/models" }));
    assert.equal(res.status, 200);
    assert.equal((await res.json()).status, 200);
    assert.equal(outbound.length, 1);
    const [call] = outbound;
    assert.equal(call.url, `${ORIGIN}/api/v1/models`);
    assert.equal(call.init.redirect, "manual");
    const bearer = new Headers(call.init.headers).get("authorization")?.replace(/^Bearer /, "") ?? "";
    const principal = await authenticateBearer(bearer);
    assert.equal(principal.userId, tester.user.id);
  } finally {
    await cleanup(data, roles, users);
  }
});

test("the assistant chat route admits only assistant:use sessions and forwards the model, write flag, and role switches", async () => {
  const data = new TestData();
  const roles: string[] = [];
  const users: string[] = [];
  const alias = uniqueName("model");
  try {
    await prisma.modelGroup.create({
      data: {
        alias,
        strategy: "priority",
        deployments: {
          create: { kind: "openai_compat", baseUrl: `https://${alias}.upstream.test/v1`, model: `${alias}-upstream` },
        },
      },
    });
    const chat = (body: Record<string, unknown>) =>
      assistantChat(post("/internal-api/assistant/chat", { messages: [{ role: "user", content: "hi" }], model: alias, ...body }));

    setRequestHeaders({});
    assert.equal((await chat({})).status, 401);
    const playground = await signedIn(data, ["playground:use"]);
    roles.push(playground.role.id);
    assert.equal((await chat({})).status, 403);

    const operator = await signedIn(data, ["assistant:use", "keys:read", "keys:manage"], ["list_keys"]);
    roles.push(operator.role.id);
    users.push(operator.user.id);
    const invalid = await assistantChat(
      post("/internal-api/assistant/chat", { messages: [{ role: "assistant", content: "hi" }], model: alias }),
    );
    assert.equal((await invalid.json()).code, "VALIDATION");
    assert.equal(outbound.length, 0);

    for (const write of [true, false]) {
      outbound = [];
      const res = await chat({ write });
      assert.match(res.headers.get("content-type") ?? "", /^text\/event-stream/);
      const events = (await res.text())
        .split("\n\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line.replace(/^data: /, "")));
      assert.deepEqual(events.at(-1), { type: "done" });
      assert.equal(outbound[0].url, `https://${alias}.upstream.test/v1/chat/completions`);
      assert.equal(outbound[0].body.model, `${alias}-upstream`);
      const tools = (outbound[0].body.tools as { function: { name: string } }[]).map((tool) => tool.function.name);
      const [system] = outbound[0].body.messages as { content: string }[];
      assert.equal(tools.includes("list_keys"), false);
      assert.equal(tools.includes("create_key"), write);
      assert.match(system.content, write ? /Write access is on/ : /Read-only mode/);
    }
    assert.ok((await prisma.requestLog.count({ where: { userId: operator.user.id } })) >= 2);
  } finally {
    await cleanup(data, roles, users, alias);
  }
});
