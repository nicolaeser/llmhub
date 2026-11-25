import assert from "node:assert/strict";
import { after, test } from "node:test";
import prisma from "@/lib/db/prisma";
import { runAsPrincipal } from "@/lib/auth/delegation";
import { stopLocalCatalogTasks } from "@/lib/gateway/catalog/catalog-tasks";
import { createKey } from "@/lib/keys/manage";
import { MCP_PROTOCOL_VERSION } from "@/lib/mcp/client";
import { loadKeyMcpAccess, saveKeyMcpAccess } from "@/lib/mcp/key-access";
import {
  createMediaMcpServer,
  deleteMcpServer,
  loadMcpServerList,
  saveMcpAssignments,
  setMcpServerEnabled,
  updateMediaMcpServer,
} from "@/lib/mcp/servers";
import { createProvider } from "@/lib/providers/connections";
import { GET as downloadMedia } from "@/app/api/media/[id]/route";
import { POST as chatCompletions } from "@/app/api/v1/chat/completions/route";
import { POST as hubMcp } from "@/app/api/v1/mcp/route";
import type { JsonMap } from "@/types/gateway";
import { closeDatabase, ownerSession, uniqueName } from "./support/database";
import { preserveSetting, TestData } from "./support/fixtures";

after(closeDatabase);

const UPSTREAM = "https://media-upstream.test/v1";
const PNG = Buffer.from("integration-png-bytes");
const upstream: { url: string; body: JsonMap | null }[] = [];

function chatTurn(body: JsonMap | null): Response {
  const messages = (body?.messages as JsonMap[] | undefined) ?? [];
  const offered = ((body?.tools as JsonMap[] | undefined) ?? []).map((tool) => String((tool.function as JsonMap).name));
  const tool = offered.find((name) => name.endsWith("__generate_image")) ?? "missing";
  const result = messages.findLast((message) => message.role === "tool");
  const message = result
    ? { role: "assistant", content: `![fox](${String((JSON.parse(String(result.content)) as { images: JsonMap[] }).images[0]?.url)})` }
    : {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_1", type: "function", function: { name: tool, arguments: '{"prompt":"a fox"}' } }],
      };
  return Response.json({
    id: "chatcmpl-it",
    object: "chat.completion",
    created: 1,
    model: "gpt-4o-mini",
    choices: [{ index: 0, message, finish_reason: result ? "stop" : "tool_calls" }],
    usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
  });
}

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = input instanceof Request ? input.url : String(input);
  const body = typeof init?.body === "string" ? (JSON.parse(init.body) as JsonMap) : null;
  upstream.push({ url, body });
  if (url === `${UPSTREAM}/images/generations`) return Response.json({ created: 1, data: [{ b64_json: PNG.toString("base64") }] });
  if (url === `${UPSTREAM}/chat/completions`) return chatTurn(body);
  return Response.json({ error: { message: "offline" } }, { status: 404 });
}) as typeof fetch;

function bearer(secret: string, path: string, body: JsonMap, headers: Record<string, string> = {}): Request {
  return new Request(`http://hub.local${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function hubTools(secret: string): Promise<string[]> {
  const res = await hubMcp(bearer(secret, "/api/v1/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list" }));
  assert.equal(res.status, 200);
  return (((await res.json()) as { result: { tools: JsonMap[] } }).result.tools).map((tool) => String(tool.name));
}

async function fetchLink(link: string): Promise<Response> {
  const id = decodeURIComponent(new URL(link).pathname.split("/").pop() ?? "");
  return downloadMedia(new Request(link), { params: Promise.resolve({ id }) });
}

test("media tools work from the console through the hub endpoint and the gateway loop to the download link", async () => {
  const owner = await ownerSession();
  const data = new TestData();
  const restoreEnterprise = await preserveSetting("enterprise");
  const stem = uniqueName("media");
  const aliases = { image: `${stem}-img`, speech: `${stem}-voice`, video: `${stem}-vid`, transcription: `${stem}-stt`, chat: `${stem}-chat` };
  const upstreamModels = { image: "gpt-image-1", speech: "gpt-4o-mini-tts", video: "sora-2", transcription: "whisper-1", chat: "gpt-4o-mini" };
  const providerIds: string[] = [];
  let serverId = "";
  let keyId = "";
  try {
    const created = await runAsPrincipal(owner, () =>
      createProvider({ name: uniqueName("upstream"), kind: "openai_compat", baseUrl: UPSTREAM, apiKey: "sk-upstream" }),
    );
    stopLocalCatalogTasks();
    providerIds.push(created.provider.id);
    for (const [kind, alias] of Object.entries(aliases) as [keyof typeof aliases, string][]) {
      await prisma.modelGroup.create({
        data: { alias, deployments: { create: [{ kind: "openai_compat", providerId: created.provider.id, model: upstreamModels[kind] }] } },
      });
    }

    const list = await runAsPrincipal(owner, () => loadMcpServerList());
    const kinds = new Map(list.mediaModels.map((model) => [model.alias, model.kinds]));
    assert.deepEqual(
      Object.values(aliases).map((alias) => kinds.get(alias)),
      [["image"], ["speech"], ["video"], ["transcription"], []],
    );

    const input = {
      name: `media-${stem.slice(-6)}`,
      description: "",
      imageModel: aliases.image,
      speechModel: aliases.speech,
      speechVoice: "nova",
      videoModel: aliases.video,
      transcriptionModel: aliases.transcription,
      enabled: true,
      defaultAccess: "none" as const,
    };
    await assert.rejects(
      runAsPrincipal(owner, () => createMediaMcpServer({ ...input, imageModel: `${stem}-missing` })),
      (err: unknown) => err instanceof Error && err.message === "VALIDATION",
    );
    const { server } = await runAsPrincipal(owner, () => createMediaMcpServer(input));
    serverId = server.id;
    assert.deepEqual(
      [server.kind, server.status, server.url, server.global, server.defaultAccess],
      ["media", "connected", "", false, "none"],
    );
    assert.deepEqual(server.tools.map((tool) => [tool.name, tool.action]), [
      ["generate_image", "write"],
      ["text_to_speech", "write"],
      ["generate_video", "write"],
      ["get_video", "read"],
      ["transcribe_audio", "read"],
    ]);
    assert.ok((await runAsPrincipal(owner, () => loadMcpServerList())).servers.some((row) => row.id === serverId));

    const org = await data.org();
    const project = await data.project(org.id);
    const key = await runAsPrincipal(owner, () => createKey({ alias: uniqueName("key"), projectId: project.id }));
    keyId = key.key.token_id;
    const secret = key.key.key;
    const named = (tools: string[]) => tools.map((tool) => `mcp__${input.name}__${tool}`);

    assert.deepEqual(await hubTools(secret), []);
    const readable = await runAsPrincipal(owner, () => updateMediaMcpServer({ id: serverId, ...input, defaultAccess: "read" }));
    assert.deepEqual([readable.server.global, readable.server.defaultAccess], [true, "read"]);
    assert.deepEqual(await hubTools(secret), named(["get_video", "transcribe_audio"]));
    await runAsPrincipal(owner, () => updateMediaMcpServer({ id: serverId, ...input }));
    assert.deepEqual(await hubTools(secret), []);
    await runAsPrincipal(owner, () =>
      saveMcpAssignments({ serverId, defaultAccess: "none", assignments: [{ scope: "org", id: org.id, access: "all" }] }),
    );
    assert.deepEqual(await hubTools(secret), named(["generate_image", "text_to_speech", "generate_video", "get_video", "transcribe_audio"]));

    await runAsPrincipal(owner, () =>
      saveKeyMcpAccess({ keyId, servers: [{ serverId, access: "read", extraTools: [], blockedTools: [] }] }),
    );
    const keyAccess = await runAsPrincipal(owner, () => loadKeyMcpAccess(keyId));
    const entry = keyAccess.servers.find((row) => row.serverId === serverId);
    assert.deepEqual([entry?.kind, entry?.rule?.access, entry?.inherited.map((rule) => rule.access)], ["media", "read", ["all"]]);
    assert.deepEqual(await hubTools(secret), named(["get_video", "transcribe_audio"]));

    await runAsPrincipal(owner, () =>
      saveKeyMcpAccess({ keyId, servers: [{ serverId, access: "inherit", extraTools: [], blockedTools: [] }] }),
    );
    const meta = { "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_VERSION, "io.modelcontextprotocol/clientCapabilities": {} };
    const toolName = named(["generate_image"])[0]!;
    const called = await hubMcp(
      bearer(
        secret,
        "/api/v1/mcp",
        { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: toolName, arguments: { prompt: "a fox" }, _meta: meta } },
        { "MCP-Protocol-Version": MCP_PROTOCOL_VERSION, "Mcp-Method": "tools/call", "Mcp-Name": toolName },
      ),
    );
    assert.equal(called.status, 200);
    const result = ((await called.json()) as { result: { isError: boolean; content: { text: string }[] } }).result;
    assert.equal(result.isError, false, result.content[0]?.text);
    const image = (JSON.parse(result.content[0]!.text) as { images: JsonMap[] }).images[0]!;
    const sent = upstream.find((call) => call.url === `${UPSTREAM}/images/generations`);
    assert.deepEqual([sent?.body?.model, sent?.body?.prompt], ["gpt-image-1", "a fox"]);
    const served = await fetchLink(String(image.url));
    assert.equal(served.status, 200);
    assert.equal(served.headers.get("content-type"), "image/png");
    assert.deepEqual(Buffer.from(await served.arrayBuffer()), PNG);
    const stored = await prisma.storedObject.findUniqueOrThrow({ where: { id: String(image.file_id) } });
    assert.deepEqual([stored.kind, stored.purpose, stored.owner], ["file", "media", keyId]);
    const logged = await prisma.requestLog.findMany({ where: { model: aliases.image } });
    assert.deepEqual(logged.map((row) => [row.endpoint, row.keyId, row.status]), [["/api/v1/images/generations", keyId, 200]]);

    const pii = JSON.stringify({ pii: { enabled: true, mode: "block", output: true, entities: [] } });
    await prisma.setting.upsert({ where: { key: "enterprise" }, update: { value: pii }, create: { key: "enterprise", value: pii } });
    const chat = await chatCompletions(
      bearer(secret, "/api/v1/chat/completions", { model: aliases.chat, messages: [{ role: "user", content: "Draw a fox" }] }),
    );
    assert.equal(chat.status, 200, await chat.clone().text());
    const answer = String(((await chat.json()) as { choices: { message: { content: string } }[] }).choices[0]?.message.content);
    const link = /\((https?:\/\/[^)]+)\)/.exec(answer)?.[1];
    assert.ok(link, answer);
    assert.equal((await fetchLink(link)).status, 200);
    const offered = upstream.find((call) => call.url === `${UPSTREAM}/chat/completions`)?.body?.tools as JsonMap[];
    assert.ok(offered.some((tool) => (tool.function as JsonMap).name === `hub__${input.name}__generate_image`));

    const updated = await runAsPrincipal(owner, () => updateMediaMcpServer({ id: serverId, ...input, videoModel: "", transcriptionModel: "" }));
    assert.deepEqual(updated.server.tools.map((tool) => tool.name), ["generate_image", "text_to_speech"]);
    assert.deepEqual(await hubTools(secret), named(["generate_image", "text_to_speech"]));
    await runAsPrincipal(owner, () => setMcpServerEnabled({ id: serverId, enabled: false }));
    assert.deepEqual(await hubTools(secret), []);
  } finally {
    stopLocalCatalogTasks();
    await restoreEnterprise();
    if (serverId) await runAsPrincipal(owner, () => deleteMcpServer(serverId)).catch(() => undefined);
    const models = Object.values(aliases);
    if (keyId) await prisma.storedObject.deleteMany({ where: { owner: keyId } });
    await prisma.usageDaily.deleteMany({ where: { model: { in: models } } });
    await prisma.requestLog.deleteMany({ where: { model: { in: models } } });
    await prisma.spendEvent.deleteMany({ where: { model: { in: models } } });
    await prisma.modelGroup.deleteMany({ where: { alias: { in: models } } });
    await prisma.providerConnection.deleteMany({ where: { id: { in: providerIds } } });
    await data.cleanup();
    await prisma.gatewayAuditLog.deleteMany({ where: { actor: owner.user.id } });
    await prisma.user.deleteMany({ where: { id: owner.user.id } });
  }
});
