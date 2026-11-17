import { gateway, gatewayRequest, groupRow, MODEL, resetGateway, UPSTREAM, virtualKeyRow } from "./support/gateway-harness";
import { recordedPrisma } from "./support/recorded-prisma";
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { extraNamesOf, nameIndex, namedBody, namedModel } from "@/lib/gateway/catalog/model-names";
import { forgetModelNames } from "@/lib/gateway/routing/name-route";
import type { AuthenticatedSession } from "@/types/auth";
import type { JsonMap } from "@/types/gateway";

const EXTRA = "gpt-test-5.5";
const HEADERS = { authorization: "Bearer sk-hub-test" };

type GroupRow = { alias: string; extraNames?: string[]; variants?: string[] };

beforeEach(() => {
  resetGateway();
  forgetModelNames();
  gateway.groups.set(MODEL, groupRow(MODEL, { extraNames: [EXTRA] }));
});

afterEach(() => {
  gateway.groups.clear();
  gateway.groups.set(MODEL, groupRow(MODEL));
  forgetModelNames();
});

function rows(): GroupRow[] {
  return [...gateway.groups.values()] as GroupRow[];
}

function chat(model: string, text: string): JsonMap {
  return { model, messages: [{ role: "user", content: text }] };
}

function upstreamModel(path: string): unknown {
  return gateway.upstream.find((call) => call.url === `${UPSTREAM}${path}`)?.body?.model;
}

function loggedModels(): unknown[] {
  return recordedPrisma.called("requestLog", "create").map((call) => (call.args as { data: { model: string } }).data.model);
}

async function postChat(body: JsonMap, path = "/api/v1/chat/completions"): Promise<Response> {
  const { POST } = path.startsWith("/api/subscription")
    ? await import("@/app/api/subscription/v1/chat/completions/route")
    : await import("@/app/api/v1/chat/completions/route");
  return POST(gatewayRequest(path, body));
}

async function listIds(): Promise<string[]> {
  const { GET } = await import("@/app/api/v1/models/route");
  const list = (await (await GET(new Request("http://hub.local/api/v1/models", { headers: HEADERS }))).json()) as {
    data: JsonMap[];
  };
  return list.data.map((entry) => String(entry.id));
}

function operator(): AuthenticatedSession {
  return {
    error: false,
    sessionId: "",
    user: { id: "u1", username: "ops", orgId: null } as AuthenticatedSession["user"],
    isOwner: false,
    role: null,
    permissions: ["models:manage"],
    secondFactor: "TOTP",
    ipAddress: null,
    userAgent: null,
  };
}

function countGroups(): void {
  recordedPrisma.reset({
    modelGroup: {
      count: ({
        where,
      }: {
        where: {
          alias?: { in?: string[]; not?: string };
          extraNames?: { has: string };
          OR?: { alias?: { in: string[] }; extraNames?: { hasSome: string[] } }[];
        };
      }) =>
        rows().filter((row) => {
          if (where.alias?.in && !where.alias.in.includes(row.alias)) return false;
          if (where.alias?.not && row.alias === where.alias.not) return false;
          if (where.extraNames && !(row.extraNames ?? []).includes(where.extraNames.has)) return false;
          if (!where.OR) return true;
          return where.OR.some(
            (condition) =>
              condition.alias?.in.includes(row.alias) ||
              condition.extraNames?.hasSome.some((name) => (row.extraNames ?? []).includes(name)),
          );
        }).length,
    },
  });
}

test("additional names are normalized like aliases", () => {
  assert.deepEqual(extraNamesOf(" Claude-Haiku-5.5 , haiku,, claude-haiku-5.5 "), ["claude-haiku-5.5", "haiku"]);
  assert.deepEqual(extraNamesOf(["A", 3, "a", ""]), ["a"]);
  assert.deepEqual(extraNamesOf(null), []);
});

test("the name index skips real aliases, reserved names, and names another model claimed first", () => {
  const index = nameIndex(
    [
      { alias: "zeta", extraNames: ["shared", "zeta-short"] },
      { alias: "alpha", extraNames: ["alpha", "shared", "beta", "auto", "api/alpha"] },
      { alias: "beta" },
    ],
    new Set(["alpha", "beta", "zeta"]),
  );
  assert.deepEqual([...index], [
    ["shared", "alpha"],
    ["zeta-short", "zeta"],
  ]);
});

test("named models keep their route prefix and leave unknown names alone", () => {
  const names = new Map([["claude-haiku-5.5", "claude-haiku-5-5"]]);
  assert.equal(namedModel("Claude-Haiku-5.5", names), "claude-haiku-5-5");
  assert.equal(namedModel("anthropic/claude-haiku-5.5", names), "anthropic/claude-haiku-5-5");
  assert.equal(namedModel("api/Claude-Haiku-5.5", names), "api/claude-haiku-5-5");
  assert.equal(namedModel("claude-opus-5.5", names), "claude-opus-5.5");
  assert.deepEqual(
    namedBody(
      { model: "claude-haiku-5.5", fallbacks: ["claude-haiku-5.5", { model: "claude-haiku-5.5" }], fallback: "other", messages: [] },
      names,
    ),
    { model: "claude-haiku-5-5", fallbacks: ["claude-haiku-5-5", { model: "claude-haiku-5-5" }], fallback: "other", messages: [] },
  );
});

test("a request with an additional name routes and counts toward the model", async () => {
  gateway.key = virtualKeyRow({ models: [MODEL] });
  const res = await postChat(chat("GPT-Test-5.5", "extra name"));
  assert.equal(res.status, 200);
  assert.equal(upstreamModel("/chat/completions"), MODEL);
  assert.deepEqual(loggedModels(), [MODEL]);
});

test("additional names work behind the anthropic/ and api/ prefixes", async () => {
  const direct = await postChat(chat(`anthropic/${EXTRA}`, "prefixed extra name"));
  assert.equal(direct.status, 200);
  const viaApi = await postChat(chat(`api/${EXTRA}`, "extra name via api"), "/api/subscription/v1/chat/completions");
  assert.equal(viaApi.status, 200);
  assert.equal(upstreamModel("/chat/completions"), MODEL);
});

test("media requests resolve additional names before routing", async () => {
  const { POST } = await import("@/app/api/v1/images/generations/route");
  const res = await POST(gatewayRequest("/api/v1/images/generations", { model: EXTRA, prompt: "a lighthouse" }));
  assert.equal(res.status, 200);
  assert.equal(upstreamModel("/images/generations"), MODEL);
});

test("fallback chains accept additional names", async () => {
  gateway.groups.set("broken", groupRow("broken", { deployments: [] }));
  const res = await postChat({ ...chat("broken", "fallback by extra name"), fallbacks: [EXTRA] });
  assert.equal(res.status, 200);
  assert.equal(upstreamModel("/chat/completions"), MODEL);
});

test("the models list shows each model once and still retrieves additional names by id", async () => {
  assert.deepEqual(await listIds(), [MODEL, "auto"]);
  const one = await import("@/app/api/v1/models/[id]/route");
  const found = await one.GET(new Request(`http://hub.local/api/v1/models/${EXTRA}`, { headers: HEADERS }), {
    params: Promise.resolve({ id: EXTRA }),
  });
  assert.equal(found.status, 200);
  assert.equal(((await found.json()) as JsonMap).id, EXTRA);
});

test("a real model named like an additional name wins", async () => {
  gateway.groups.set(EXTRA, groupRow(EXTRA));
  const res = await postChat(chat(EXTRA, "real alias"));
  assert.equal(res.status, 200);
  assert.equal(upstreamModel("/chat/completions"), EXTRA);
  assert.deepEqual(
    (await listIds()).filter((id) => id === EXTRA),
    [EXTRA],
  );
});

test("model groups reject additional names that clash or are reserved", async () => {
  const { runAsPrincipal } = await import("@/lib/auth/delegation");
  const { createModelGroup, updateModelGroup } = await import("@/lib/models/groups");
  countGroups();
  gateway.groups.set("other", groupRow("other"));
  const base = { strategy: "least_inflight", numRetries: 0, overflowGroup: "", fallbackGroups: [] };
  await runAsPrincipal(operator(), async () => {
    await assert.rejects(createModelGroup({ ...base, alias: EXTRA }), /ALIAS_EXISTS/);
    await assert.rejects(createModelGroup({ ...base, alias: "new", extraNames: [EXTRA] }), /EXTRA_NAME_TAKEN/);
    await assert.rejects(createModelGroup({ ...base, alias: "new", extraNames: ["other"] }), /EXTRA_NAME_TAKEN/);
    await assert.rejects(createModelGroup({ ...base, alias: "new", extraNames: ["anthropic/new"] }), /EXTRA_NAME_INVALID/);
    await assert.rejects(updateModelGroup({ ...base, alias: "other", extraNames: "auto" }), /EXTRA_NAME_INVALID/);
  });
});

const HAIKU = "claude-haiku-4-5";
const HAIKU_DATED = "claude-haiku-4-5-20251001";

function claudeGroup(alias: string) {
  const row = groupRow(alias);
  row.deployments[0]!.kind = "claude";
  return row;
}

test("a dated Anthropic id routes, bills, and logs as the catalog model", async () => {
  gateway.groups.set(HAIKU, groupRow(HAIKU));
  gateway.key = virtualKeyRow({ models: [HAIKU] });
  for (const id of [HAIKU_DATED, "claude-haiku-4-5@20251001", "us.anthropic.claude-haiku-4-5-20251001-v1:0", `${HAIKU}[1m]`]) {
    gateway.upstream.length = 0;
    const res = await postChat(chat(id, "native"));
    assert.equal(res.status, 200, id);
    assert.equal(upstreamModel("/chat/completions"), HAIKU, id);
  }
  assert.deepEqual(loggedModels(), [HAIKU, HAIKU, HAIKU, HAIKU]);
});

test("claude-sonnet-5 is not silently served as sonnet 5.5", async () => {
  gateway.groups.set("claude-sonnet-5-5", groupRow("claude-sonnet-5-5"));
  const res = await postChat(chat("claude-sonnet-5", "auto mode"));
  assert.equal(res.status, 404);
  assert.equal(gateway.upstream.length, 0);
});

test("a key allowed only the catalog model can call its native id and no other release", async () => {
  gateway.groups.set(HAIKU, groupRow(HAIKU));
  gateway.groups.set("claude-sonnet-5-5", groupRow("claude-sonnet-5-5"));
  gateway.key = virtualKeyRow({ models: ["claude-sonnet-5-5"] });
  const denied = await postChat(chat(HAIKU_DATED, "denied"));
  assert.equal(denied.status, 403);
  gateway.key = virtualKeyRow({ models: [HAIKU] });
  gateway.upstream.length = 0;
  const allowed = await postChat(chat(HAIKU_DATED, "allowed"));
  assert.equal(allowed.status, 200);
  assert.equal(upstreamModel("/chat/completions"), HAIKU);
});

test("an additional name and a real model win over the native spelling", async () => {
  gateway.groups.set(MODEL, groupRow(MODEL, { extraNames: [HAIKU_DATED] }));
  gateway.groups.set(HAIKU, claudeGroup(HAIKU));
  const named = await postChat(chat(HAIKU_DATED, "operator name"));
  assert.equal(named.status, 200);
  assert.equal(upstreamModel("/chat/completions"), MODEL);
  gateway.groups.set(MODEL, groupRow(MODEL));
  gateway.groups.set(HAIKU_DATED, groupRow(HAIKU_DATED));
  forgetModelNames();
  gateway.upstream.length = 0;
  const exact = await postChat(chat(HAIKU_DATED, "real alias"));
  assert.equal(exact.status, 200);
  assert.equal(upstreamModel("/chat/completions"), HAIKU_DATED);
});

test("gateway discovery lists the native id and the console list does not", async () => {
  gateway.groups.set(HAIKU, claudeGroup(HAIKU));
  const { GET } = await import("@/app/api/subscription/v1/models/route");
  const ids = async (url: string) => {
    const body = (await (await GET(new Request(url, { headers: HEADERS }))).json()) as { data: { id: string }[] };
    return body.data.map((entry) => entry.id);
  };
  const consoleList = await ids("http://hub.local/api/subscription/v1/models");
  assert.ok(consoleList.includes(HAIKU));
  assert.equal(consoleList.includes(HAIKU_DATED), false);
  const discovered = await ids("http://hub.local/api/subscription/v1/models?limit=1000");
  assert.ok(discovered.includes(HAIKU));
  assert.ok(discovered.includes(HAIKU_DATED));
  assert.equal((await listIds()).includes(HAIKU_DATED), false);
  const one = await import("@/app/api/subscription/v1/models/[id]/route");
  const found = await one.GET(new Request(`http://hub.local/api/subscription/v1/models/${HAIKU_DATED}`, { headers: HEADERS }), {
    params: Promise.resolve({ id: HAIKU_DATED }),
  });
  assert.equal(found.status, 200);
  assert.equal(((await found.json()) as JsonMap).id, HAIKU_DATED);
});

test("updating a model keeps its additional names unless they are sent", async () => {
  const { runAsPrincipal } = await import("@/lib/auth/delegation");
  const { updateModelGroup } = await import("@/lib/models/groups");
  countGroups();
  const base = { alias: MODEL, strategy: "least_inflight", numRetries: 0, overflowGroup: "", fallbackGroups: [] };
  await runAsPrincipal(operator(), async () => {
    await updateModelGroup(base);
    await updateModelGroup({ ...base, extraNames: `${MODEL}, Gpt-Test-Latest` });
  });
  const updates = recordedPrisma
    .called("modelGroup", "update")
    .map((call) => (call.args as { data: { extraNames: string[] } }).data.extraNames);
  assert.deepEqual(updates, [[EXTRA], ["gpt-test-latest"]]);
});
