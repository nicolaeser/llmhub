import { API_KEY, chatReply, gateway, gatewayRequest, groupRow, MODEL, resetGateway, UPSTREAM, type UpstreamCall } from "./support/gateway-harness";
import { recordedPrisma } from "./support/recorded-prisma";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { signingSecret } from "@/lib/crypto";
import { PII_CATALOG, redactPii } from "@/lib/gateway/safety/pii";
import { MCP_LEGACY_PROTOCOL_VERSION, MCP_LEGACY_PROTOCOL_VERSIONS, MCP_PROTOCOL_VERSION, McpClient } from "@/lib/mcp/client";
import { McpError } from "@/lib/mcp/errors";
import {
  audioFilename,
  callMedia,
  MEDIA_LINK_TTL_MS,
  MEDIA_SERVER_URL,
  MEDIA_TOOL_TIMEOUT_MS,
  mediaLink,
  mediaLinkValid,
  mediaKindsOf,
  mediaSpec,
  mediaToolSpecs,
  mediaType,
} from "@/lib/mcp/media";
import {
  GENERATE_IMAGE_TOOL,
  GENERATE_VIDEO_TOOL,
  GET_VIDEO_TOOL,
  MEDIA_KIND_TOOLS,
  mediaToolsAt,
  TEXT_TO_SPEECH_TOOL,
  TRANSCRIBE_AUDIO_TOOL,
} from "@/lib/mcp/media-tools";
import type { JsonMap, Principal } from "@/types/gateway";
import type { KeyEndpoint } from "@/types/keys";
import type { McpConnection, McpFetch, McpMediaSpec } from "@/types/mcp";

const IMAGE_MODEL = "image-test";
const SPEECH_MODEL = "tts-test";
const VIDEO_MODEL = "video-test";
const STT_MODEL = "stt-test";
const FULL_SPEC = {
  image: { model: IMAGE_MODEL },
  speech: { model: SPEECH_MODEL, voice: "nova" },
  video: { model: VIDEO_MODEL },
  transcription: { model: STT_MODEL },
};
const PIXEL = Buffer.from("fake-png-bytes");

type StoredRow = JsonMap & { id: string; payload: Uint8Array | null };

function mediaServerRow(raw: JsonMap = FULL_SPEC) {
  const spec = mediaSpec(raw);
  return {
    id: "media1",
    name: "media",
    url: MEDIA_SERVER_URL,
    authType: "none",
    authHeader: "",
    authSecret: "",
    oauthGrant: "authorization_code",
    oauthClientId: "",
    oauthScopes: "",
    transport: "streamable_http",
    protocolVersion: MCP_PROTOCOL_VERSION,
    kind: "media",
    spec,
    internal: false,
    enabled: true,
    global: true,
    template: false,
    toolsRestricted: false,
    allowedTools: [],
    tools: mediaToolSpecs(mediaSpec(spec)),
    toolActions: {},
    oauthLogin: null,
    installations: [],
    assignments: [],
  };
}

function setup(reply: (call: UpstreamCall) => Response) {
  resetGateway();
  for (const model of [IMAGE_MODEL, SPEECH_MODEL, VIDEO_MODEL, STT_MODEL]) gateway.groups.set(model, groupRow(model));
  gateway.reply = reply;
  const stored: StoredRow[] = [];
  recordedPrisma.handlers = {
    mcpServer: { findMany: () => [mediaServerRow()] },
    storedObject: {
      create: ({ data }: { data: JsonMap }) => {
        const row = { id: `obj${stored.length + 1}`, createdAt: new Date(0), payload: null, ...data } as StoredRow;
        stored.push(row);
        return row;
      },
      findUnique: ({ where }: { where: { id: string } }) => stored.find((row) => row.id === where.id) ?? null,
      update: ({ where, data }: { where: { id: string }; data: JsonMap }) => {
        const row = stored.find((item) => item.id === where.id);
        if (row) Object.assign(row, data);
        return row;
      },
    },
  };
  return stored;
}

async function toolNames(): Promise<Map<string, string>> {
  const listed = await hub({ method: "tools/list" });
  const names = ((listed.result as JsonMap).tools as JsonMap[]).map((tool) => String(tool.name));
  return new Map(names.map((name) => [name.replace(/^.*?(generate_image|text_to_speech|generate_video|get_video|transcribe_audio)$/, "$1"), name]));
}

async function callTool(tool: string, args: JsonMap): Promise<{ isError: boolean; text: string; json: JsonMap }> {
  const name = (await toolNames()).get(tool) ?? tool;
  const result = (await hub({ method: "tools/call", params: { name, arguments: args } })).result as JsonMap;
  const text = String(((result.content as JsonMap[])[0] as JsonMap).text);
  return { isError: result.isError === true, text, json: (JSON.parse(text.startsWith("{") ? text : "{}") as JsonMap) };
}

async function download(url: string, id: string): Promise<Response> {
  const { GET } = await import("@/app/api/media/[id]/route");
  return GET(new Request(url), { params: Promise.resolve({ id }) });
}

async function hub(body: JsonMap): Promise<JsonMap> {
  const { POST } = await import("@/app/api/v1/mcp/route");
  const res = await POST(gatewayRequest("/api/v1/mcp", { jsonrpc: "2.0", id: 1, ...body }));
  assert.equal(res.status, 200);
  return (await res.json()) as JsonMap;
}

function imageReply(call: UpstreamCall): Response {
  if (!call.url.endsWith("/images/generations")) return Response.json({});
  return Response.json({ created: 1, data: [{ b64_json: PIXEL.toString("base64"), revised_prompt: "a red fox" }] });
}

test("media servers offer only the tools that have a model", () => {
  assert.deepEqual(mediaToolSpecs(mediaSpec({})), []);
  assert.deepEqual(mediaSpec({ image: { model: " img " } }), {
    image: { model: "img" },
    speech: { model: "", voice: "" },
    video: { model: "" },
    transcription: { model: "" },
  });
  const names = (spec: JsonMap) => mediaToolSpecs(mediaSpec(spec)).map((tool) => tool.name);
  assert.deepEqual(names({ image: { model: "img" } }), [GENERATE_IMAGE_TOOL]);
  assert.deepEqual(names({ video: { model: "v" } }), [GENERATE_VIDEO_TOOL, GET_VIDEO_TOOL]);
  assert.deepEqual(names(FULL_SPEC), [GENERATE_IMAGE_TOOL, TEXT_TO_SPEECH_TOOL, GENERATE_VIDEO_TOOL, GET_VIDEO_TOOL, TRANSCRIBE_AUDIO_TOOL]);
  for (const tool of mediaToolSpecs(mediaSpec(FULL_SPEC))) assert.equal((tool.inputSchema as JsonMap).type, "object", tool.name);
});

test("media links verify their signature and expire", () => {
  const now = 1_800_000_000_000;
  const url = new URL(mediaLink("obj1", now));
  const expires = String(url.searchParams.get("expires"));
  const signature = String(url.searchParams.get("signature"));
  assert.equal(url.pathname, "/api/media/obj1");
  assert.equal(parseInt(expires, 36) * 1000, now + MEDIA_LINK_TTL_MS);
  assert.match(signature, /^[0-9A-F]{64}$/);
  assert.equal(mediaLinkValid("obj1", expires, signature, now), true);
  assert.equal(mediaLinkValid("obj2", expires, signature, now), false);
  assert.equal(mediaLinkValid("obj1", (parseInt(expires, 36) + 1).toString(36), signature, now), false);
  assert.equal(mediaLinkValid("obj1", expires, `${signature}x`, now), false);
  assert.equal(mediaLinkValid("obj1", expires, signature.toLowerCase(), now), false);
  assert.equal(mediaLinkValid("obj1", expires, signature, now + MEDIA_LINK_TTL_MS + 1), false);
  assert.equal(mediaLinkValid("obj1", null, signature, now), false);
});

test("media links issued with millisecond expiry stay valid until they expire", () => {
  const now = 1_800_000_000_000;
  const expires = String(now + MEDIA_LINK_TTL_MS);
  const signature = createHmac("sha256", signingSecret()).update(`media-link:obj1:${expires}`).digest("base64url");
  assert.equal(mediaLinkValid("obj1", expires, signature, now), true);
  assert.equal(mediaLinkValid("obj2", expires, signature, now), false);
  assert.equal(mediaLinkValid("obj1", expires, signature, now + MEDIA_LINK_TTL_MS + 1), false);
  assert.equal(mediaLinkValid("obj1", (now + MEDIA_LINK_TTL_MS).toString(36), signature, now), false);
});

test("media links pass every PII detector except URL unchanged", () => {
  const entities = PII_CATALOG.map((entity) => entity.id).filter((id) => id !== "URL");
  const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";
  let seed = 7;
  const next = () => (seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648);
  for (let i = 0; i < 3000; i++) {
    const id = `c${Array.from({ length: 24 }, () => alphabet[next() % 36]).join("")}`;
    const link = mediaLink(id, 1_764_000_000_000 + next() * 977);
    const text = JSON.stringify({ images: [{ url: link, file_id: id }], video_id: id }) + `\n![image](${link})`;
    assert.equal(redactPii(text, entities), text, link);
  }
});

test("generate_image runs the image model as the caller and returns a working link", async () => {
  const stored = setup(imageReply);
  const names = [...(await toolNames()).values()];
  assert.equal(names.length, 5);
  const image = (await toolNames()).get(GENERATE_IMAGE_TOOL);

  const called = await hub({ method: "tools/call", params: { name: image, arguments: { prompt: "a fox", size: "1024x1024", count: 9 } } });
  const result = called.result as JsonMap;
  assert.equal(result.isError, false);
  const upstream = gateway.upstream.find((call) => call.url.endsWith("/images/generations"));
  const { model, prompt, n, size } = upstream?.body ?? {};
  assert.deepEqual({ model, prompt, n, size }, { model: IMAGE_MODEL, prompt: "a fox", n: 4, size: "1024x1024" });
  assert.notEqual(upstream?.headers.authorization, `Bearer ${API_KEY}`);

  const payload = JSON.parse(String(((result.content as JsonMap[])[0] as JsonMap).text)) as { images: JsonMap[] };
  assert.equal(payload.images.length, 1);
  assert.equal(payload.images[0]?.revised_prompt, "a red fox");
  assert.equal(stored.length, 1);
  assert.equal(stored[0]?.purpose, "media");
  assert.equal(stored[0]?.owner, gateway.key.id);

  const { GET } = await import("@/app/api/media/[id]/route");
  const link = new URL(String(payload.images[0]?.url));
  const params = { params: Promise.resolve({ id: "obj1" }) };
  const res = await GET(new Request(link), params);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/png");
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), PIXEL);

  link.searchParams.set("signature", "forged");
  assert.equal((await GET(new Request(link), params)).status, 403);
});

test("generate_image reports missing prompts and upstream failures as tool errors", async () => {
  setup(() => Response.json({ error: { message: "content policy" } }, { status: 400 }));
  const name = (await toolNames()).get(GENERATE_IMAGE_TOOL);
  const empty = (await hub({ method: "tools/call", params: { name, arguments: { prompt: " " } } })).result as JsonMap;
  assert.equal(empty.isError, true);
  assert.equal(gateway.upstream.length, 0);
  const failed = (await hub({ method: "tools/call", params: { name, arguments: { prompt: "a fox" } } })).result as JsonMap;
  assert.equal(failed.isError, true);
  assert.match(String(((failed.content as JsonMap[])[0] as JsonMap).text), /generate_image failed/);
});

test("the media download route refuses unsigned requests before reading data", async () => {
  setup(imageReply);
  const { GET } = await import("@/app/api/media/[id]/route");
  const res = await GET(new Request("https://hub.test/api/media/obj1"), { params: Promise.resolve({ id: "obj1" }) });
  assert.equal(res.status, 403);
  assert.equal(recordedPrisma.called("storedObject").length, 0);
});

test("text_to_speech stores the audio and uses the configured voice", async () => {
  const stored = setup((call) =>
    call.url.endsWith("/audio/speech") ? new Response(PIXEL, { headers: { "content-type": "audio/mpeg" } }) : Response.json({}),
  );
  const result = await callTool(TEXT_TO_SPEECH_TOOL, { text: "Hallo Welt" });
  assert.equal(result.isError, false, result.text);
  const upstream = gateway.upstream.find((call) => call.url.endsWith("/audio/speech"));
  assert.equal(upstream?.body?.model, SPEECH_MODEL);
  assert.equal(upstream?.body?.input, "Hallo Welt");
  assert.equal(upstream?.body?.voice, "nova");
  assert.equal(upstream?.body?.response_format, "mp3");
  const audio = result.json.audio as JsonMap;
  assert.equal(stored[0]?.filename, "speech.mp3");
  const res = await download(String(audio.url), String(audio.file_id));
  assert.equal(res.headers.get("content-type"), "audio/mpeg");
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), PIXEL);
  const tooLong = await callTool(TEXT_TO_SPEECH_TOOL, { text: "x".repeat(5000) });
  assert.equal(tooLong.isError, true);
});

test("videos start, report progress, and become a stored download once", async () => {
  let status = "in_progress";
  const stored = setup((call) => {
    if (call.url.endsWith("/videos") && call.body) return Response.json({ id: "vid_up", object: "video", status: "queued" });
    if (call.url.endsWith("/videos/vid_up")) return Response.json({ id: "vid_up", status, progress: status === "completed" ? 100 : 40 });
    if (call.url.endsWith("/videos/vid_up/content")) return new Response(PIXEL, { headers: { "content-type": "video/mp4" } });
    return Response.json({});
  });
  const started = await callTool(GENERATE_VIDEO_TOOL, { prompt: "a fox running", seconds: "4", size: "1280x720" });
  assert.equal(started.isError, false, started.text);
  const start = gateway.upstream.find((call) => call.url.endsWith("/videos"));
  assert.equal(start?.body?.model, VIDEO_MODEL);
  assert.equal(start?.body?.seconds, "4");
  const videoId = String(started.json.video_id);
  assert.equal(stored.find((row) => row.id === videoId)?.kind, "video");

  const pending = await callTool(GET_VIDEO_TOOL, { video_id: videoId });
  assert.equal(pending.isError, false);
  assert.equal(pending.json.status, "in_progress");
  assert.equal(pending.json.progress, 40);
  assert.equal(pending.json.video, undefined);

  status = "completed";
  const done = await callTool(GET_VIDEO_TOOL, { video_id: videoId });
  const video = done.json.video as JsonMap;
  assert.equal(done.json.status, "completed");
  const res = await download(String(video.url), String(video.file_id));
  assert.equal(res.headers.get("content-type"), "video/mp4");
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), PIXEL);

  const contentCalls = gateway.upstream.filter((call) => call.url.endsWith("/content")).length;
  const again = await callTool(GET_VIDEO_TOOL, { video_id: videoId });
  assert.equal((again.json.video as JsonMap).file_id, video.file_id);
  assert.equal(gateway.upstream.filter((call) => call.url.endsWith("/content")).length, contentCalls);

  status = "failed";
  const missing = await callTool(GET_VIDEO_TOOL, { video_id: "nope" });
  assert.equal(missing.isError, true);
});

test("transcribe_audio reads own files and media links and refuses private urls", async () => {
  const stored = setup((call) =>
    call.url.endsWith("/audio/transcriptions") ? Response.json({ text: "Hallo Welt", language: "de" }) : new Response(PIXEL, { headers: { "content-type": "audio/mpeg" } }),
  );
  const speech = await callTool(TEXT_TO_SPEECH_TOOL, { text: "Hallo Welt" });
  const audio = speech.json.audio as JsonMap;

  const fromLink = await callTool(TRANSCRIBE_AUDIO_TOOL, { url: audio.url, language: "de" });
  assert.equal(fromLink.isError, false, fromLink.text);
  assert.deepEqual(fromLink.json, { text: "Hallo Welt", language: "de" });
  const fromFile = await callTool(TRANSCRIBE_AUDIO_TOOL, { file_id: audio.file_id });
  assert.equal(fromFile.json.text, "Hallo Welt");

  stored[0]!.owner = "someone-else";
  assert.equal((await callTool(TRANSCRIBE_AUDIO_TOOL, { file_id: audio.file_id })).isError, true);
  assert.equal((await callTool(TRANSCRIBE_AUDIO_TOOL, {})).isError, true);
  const blocked = await callTool(TRANSCRIBE_AUDIO_TOOL, { url: "http://127.0.0.1/secret.mp3" });
  assert.equal(blocked.isError, true);
  assert.match(blocked.text, /cannot be fetched/);
});

test("transcribe_audio fetches public urls with a size limit", async () => {
  setup((call) => (call.url.endsWith("/audio/transcriptions") ? Response.json({ text: "hi" }) : Response.json({})));
  const { gateRequest } = await import("@/lib/gateway/access/gate");
  const principal = await gateRequest(gatewayRequest("/api/v1/mcp", {}));
  const spec: McpMediaSpec = mediaSpec(FULL_SPEC);
  const fetched: string[] = [];
  const small = async (url: string) => {
    fetched.push(url);
    return new Response(PIXEL, { headers: { "content-type": "audio/wav" } });
  };
  const big = async () => new Response(PIXEL, { headers: { "content-length": String(26 * 1024 * 1024) } });
  const ok = await callMedia(spec, TRANSCRIBE_AUDIO_TOOL, { url: "https://cdn.example.com/a.wav" }, principal, small);
  assert.equal(ok.isError, false, ok.text);
  assert.deepEqual(fetched, ["https://cdn.example.com/a.wav"]);
  const tooBig = await callMedia(spec, TRANSCRIBE_AUDIO_TOOL, { url: "https://cdn.example.com/b.wav" }, principal, big);
  assert.equal(tooBig.isError, true);
  assert.match(tooBig.text, /25 MB/);
});

test("media tools without a configured model are refused", async () => {
  const outcome = await callMedia(mediaSpec({ image: { model: IMAGE_MODEL } }), TEXT_TO_SPEECH_TOOL, { text: "hi" }, {} as Principal);
  assert.equal(outcome.isError, true);
  assert.equal(await callMedia(mediaSpec(FULL_SPEC), GENERATE_IMAGE_TOOL, {}, null).then((o) => o.isError), true);
});

async function bookedLogs(count: number) {
  for (let wait = 0; wait < 400 && recordedPrisma.called("requestLog", "create").length < count; wait++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return recordedPrisma.called("requestLog", "create").map((call) => (call.args as { data: JsonMap }).data);
}

test("transcribe_audio checks ownership of file_id even when a valid media link is passed too", async () => {
  const stored = setup((call) =>
    call.url.endsWith("/audio/transcriptions") ? Response.json({ text: "secret" }) : new Response(PIXEL, { headers: { "content-type": "audio/mpeg" } }),
  );
  const own = (await callTool(TEXT_TO_SPEECH_TOOL, { text: "mine" })).json.audio as JsonMap;
  const other = (await callTool(TEXT_TO_SPEECH_TOOL, { text: "theirs" })).json.audio as JsonMap;
  stored.find((row) => row.id === other.file_id)!.owner = "someone-else";
  const before = gateway.upstream.filter((call) => call.url.endsWith("/audio/transcriptions")).length;
  const mixed = await callTool(TRANSCRIBE_AUDIO_TOOL, { file_id: other.file_id, url: own.url });
  assert.equal(mixed.isError, true);
  assert.equal(gateway.upstream.filter((call) => call.url.endsWith("/audio/transcriptions")).length, before);
  const broken = await callTool(TRANSCRIBE_AUDIO_TOOL, { url: String(own.url).replace(/\/api\/media\/[^?]+/, "/api/media/%E0%A4%A") });
  assert.equal(broken.isError, true);
});

test("media tools keep the caller's trace intact and log under their own endpoint", async () => {
  setup(imageReply);
  const { gateRequest } = await import("@/lib/gateway/access/gate");
  const principal = await gateRequest(gatewayRequest("/api/v1/chat/completions", {}));
  const outer = principal.trace!;
  outer.request = { model: "chat", messages: [] };
  const outcome = await callMedia(mediaSpec(FULL_SPEC), GENERATE_IMAGE_TOOL, { prompt: "a fox" }, principal);
  assert.equal(outcome.isError, false, outcome.text);
  assert.equal(principal.trace, outer);
  assert.deepEqual(outer.request, { model: "chat", messages: [] });
  assert.equal(outer.endpoint, "/api/v1/chat/completions");
  const [log] = await bookedLogs(1);
  assert.equal(log?.endpoint, "/api/v1/images/generations");
  assert.equal(log?.model, IMAGE_MODEL);
});

test("media tools respect the key's endpoint allow list", async () => {
  setup(imageReply);
  const { gateRequest } = await import("@/lib/gateway/access/gate");
  const principal = await gateRequest(gatewayRequest("/api/v1/chat/completions", {}));
  const allowed: KeyEndpoint[] = ["chat", "images", "mcp"];
  const limited = { ...principal, key: { ...principal.key!, allowed_endpoints: allowed } };
  const speech = await callMedia(mediaSpec(FULL_SPEC), TEXT_TO_SPEECH_TOOL, { text: "hi" }, limited);
  assert.equal(speech.isError, true);
  assert.match(speech.text, /endpoint not allowed/);
  assert.equal(gateway.upstream.some((call) => call.url.endsWith("/audio/speech")), false);
  const image = await callMedia(mediaSpec(FULL_SPEC), GENERATE_IMAGE_TOOL, { prompt: "a fox" }, limited);
  assert.equal(image.isError, false, image.text);
});

test("stored media types come only from valid audio and video tokens", () => {
  assert.equal(mediaType("audio/mpeg; charset=binary", "audio/", "audio/wav"), "audio/mpeg");
  assert.equal(mediaType("video/MP4", "video/", "video/webm"), "video/mp4");
  assert.equal(mediaType("text/html", "audio/", "audio/mpeg"), "audio/mpeg");
  assert.equal(mediaType("audio/<script>", "audio/", "audio/mpeg"), "audio/mpeg");
  assert.equal(mediaType("video/mp4", "audio/", "audio/mpeg"), "audio/mpeg");
  assert.equal(mediaType("", "video/", "video/mp4"), "video/mp4");
});

test("transcribe_audio rejects invalid or expired own-origin media links without fetching", async () => {
  setup(() => Response.json({ text: "nope" }));
  const { gateRequest } = await import("@/lib/gateway/access/gate");
  const principal = await gateRequest(gatewayRequest("/api/v1/mcp", {}));
  const spec = mediaSpec(FULL_SPEC);
  let fetches = 0;
  const countFetch = async () => {
    fetches += 1;
    return new Response(PIXEL, { headers: { "content-type": "audio/mpeg" } });
  };
  const valid = new URL(mediaLink("obj1"));
  const forged = new URL(valid);
  forged.searchParams.set("signature", "forged");
  const expired = mediaLink("obj1", Date.now() - MEDIA_LINK_TTL_MS - 1_000);

  const forgedOutcome = await callMedia(spec, TRANSCRIBE_AUDIO_TOOL, { url: forged.toString() }, principal, countFetch);
  assert.equal(forgedOutcome.isError, true);
  assert.match(forgedOutcome.text, /invalid or expired/);

  const expiredOutcome = await callMedia(spec, TRANSCRIBE_AUDIO_TOOL, { url: expired }, principal, countFetch);
  assert.equal(expiredOutcome.isError, true);
  assert.match(expiredOutcome.text, /invalid or expired/);
  assert.equal(fetches, 0);
});

test("transcribe_audio cancels response bodies on non-OK status or oversized content-length", async () => {
  setup(() => Response.json({ text: "nope" }));
  const { gateRequest } = await import("@/lib/gateway/access/gate");
  const principal = await gateRequest(gatewayRequest("/api/v1/mcp", {}));
  const spec = mediaSpec(FULL_SPEC);
  const trackedResponse = (status: number, headers: Record<string, string>) => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(PIXEL);
      },
      cancel() {
        cancelled = true;
      },
    });
    return { res: new Response(body, { status, headers }), wasCancelled: () => cancelled };
  };

  const notOk = trackedResponse(404, { "content-type": "text/plain" });
  const notOkOutcome = await callMedia(
    spec,
    TRANSCRIBE_AUDIO_TOOL,
    { url: "https://cdn.example.com/missing.wav" },
    principal,
    async () => notOk.res,
  );
  assert.equal(notOkOutcome.isError, true);
  assert.match(notOkOutcome.text, /404/);
  assert.equal(notOk.wasCancelled(), true);

  const oversized = trackedResponse(200, { "content-length": String(26 * 1024 * 1024) });
  const oversizedOutcome = await callMedia(
    spec,
    TRANSCRIBE_AUDIO_TOOL,
    { url: "https://cdn.example.com/huge.wav" },
    principal,
    async () => oversized.res,
  );
  assert.equal(oversizedOutcome.isError, true);
  assert.match(oversizedOutcome.text, /25 MB/);
  assert.equal(oversized.wasCancelled(), true);
});

test("transcribe_audio logs plain-text upstream responses", async () => {
  setup((call) =>
    call.url.endsWith("/audio/transcriptions")
      ? new Response("plain transcript", { headers: { "content-type": "text/plain" } })
      : new Response(PIXEL, { headers: { "content-type": "audio/wav" } }),
  );
  gateway.key = { ...gateway.key, logContent: true };
  recordedPrisma.handlers.user = {
    findUnique: ({ where }: { where: { id: string } }) =>
      where.id === gateway.key.userId
        ? { id: where.id, blocked: false, orgId: null, spend: 0, maxBudget: 0, budgetDuration: "", spendResetAt: null, createdAt: new Date(0), logContent: true }
        : null,
  };
  const { gateRequest } = await import("@/lib/gateway/access/gate");
  const principal = await gateRequest(gatewayRequest("/api/v1/mcp", {}));
  const outcome = await callMedia(
    mediaSpec(FULL_SPEC),
    TRANSCRIBE_AUDIO_TOOL,
    { url: "https://cdn.example.com/a.wav" },
    principal,
    async () => new Response(PIXEL, { headers: { "content-type": "audio/wav" } }),
  );
  assert.equal(outcome.isError, false, outcome.text);
  assert.deepEqual(JSON.parse(outcome.text), { text: "plain transcript" });
  const [log] = await bookedLogs(1);
  assert.equal(((log?.contents as JsonMap)?.create as JsonMap)?.response, "plain transcript");
});

test("get_video stores filename extension derived from content-type", async () => {
  const stored = setup((call) => {
    if (call.url.endsWith("/videos") && call.body) return Response.json({ id: "vid_webm", object: "video", status: "queued" });
    if (call.url.endsWith("/videos/vid_webm")) return Response.json({ id: "vid_webm", status: "completed", progress: 100 });
    if (call.url.endsWith("/videos/vid_webm/content")) {
      return new Response(PIXEL, { headers: { "content-type": "video/webm; codecs=vp9" } });
    }
    return Response.json({});
  });
  const started = await callTool(GENERATE_VIDEO_TOOL, { prompt: "a fox running" });
  assert.equal(started.isError, false, started.text);
  const done = await callTool(GET_VIDEO_TOOL, { video_id: String(started.json.video_id) });
  assert.equal(done.isError, false, done.text);
  const video = done.json.video as JsonMap;
  const saved = stored.find((row) => row.id === video.file_id);
  assert.equal(saved?.filename, "video.webm");
  assert.equal(saved?.contentType, "video/webm");
});

test("media tools preserve caller per-request costCap from x-hub-max-cost", async () => {
  setup(imageReply);
  gateway.groups.set(
    IMAGE_MODEL,
    groupRow(IMAGE_MODEL, {
      deployments: [
        {
          id: `${IMAGE_MODEL}-route`,
          kind: "openai_compat",
          baseUrl: UPSTREAM,
          model: IMAGE_MODEL,
          weight: 1,
          costInput: 1000,
          costOutput: 1000,
          providerId: null,
          provider: null,
        },
      ],
    }),
  );
  const { gateRequest } = await import("@/lib/gateway/access/gate");
  const principal = await gateRequest(gatewayRequest("/api/v1/chat/completions", {}, { "x-hub-max-cost": "0.0001" }));
  assert.deepEqual(principal.trace?.costCap, { limit: 0.0001, budget: null });
  const outcome = await callMedia(mediaSpec(FULL_SPEC), GENERATE_IMAGE_TOOL, { prompt: "a fox" }, principal);
  assert.equal(outcome.isError, true);
  assert.match(outcome.text, /per-request limit/);
  assert.equal(gateway.upstream.length, 0);
});

function cardLikeExpiryMoment(): number {
  let moment = 1_800_000_000_000;
  while (redactPii(String(moment + MEDIA_LINK_TTL_MS), ["CREDIT_CARD"]) === String(moment + MEDIA_LINK_TTL_MS)) moment += 1;
  return moment;
}

const MEDIA_TOOL = "hub__media__generate_image";

function loopReply(call: UpstreamCall): Response {
  if (call.url.endsWith("/images/generations")) return imageReply(call);
  const messages = (call.body?.messages as JsonMap[] | undefined) ?? [];
  const tool = messages.findLast((message) => message.role === "tool");
  if (!tool) {
    return Response.json({
      id: "chatcmpl-tool",
      object: "chat.completion",
      created: 1,
      model: MODEL,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: null,
            tool_calls: [{ id: "call_1", type: "function", function: { name: MEDIA_TOOL, arguments: '{"prompt":"a fox"}' } }],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    });
  }
  const images = (JSON.parse(String(tool.content)) as { images: JsonMap[] }).images;
  return chatReply(`![fox](${String(images[0]?.url)})`);
}

async function postModel(path: string, body: JsonMap): Promise<Response> {
  const mod =
    path === "/api/v1/chat/completions"
      ? await import("@/app/api/v1/chat/completions/route")
      : path === "/api/v1/messages"
        ? await import("@/app/api/v1/messages/route")
        : await import("@/app/api/v1/responses/route");
  return mod.POST(gatewayRequest(path, body));
}

function answerText(path: string, json: JsonMap): string {
  if (path === "/api/v1/chat/completions") return String((((json.choices as JsonMap[])[0] as JsonMap).message as JsonMap).content);
  if (path === "/api/v1/messages") return String(((json.content as JsonMap[])[0] as JsonMap).text);
  return String(json.output_text);
}

test("the gateway MCP loop hands the model working media links under PII masking and blocking", async (t) => {
  t.mock.method(Date, "now", cardLikeExpiryMoment);
  const cases: [string, JsonMap, string][] = [
    ["/api/v1/chat/completions", { model: MODEL, messages: [{ role: "user", content: "Draw a fox" }] }, "mask"],
    ["/api/v1/chat/completions", { model: MODEL, messages: [{ role: "user", content: "Draw a fox" }] }, "block"],
    ["/api/v1/messages", { model: MODEL, max_tokens: 64, messages: [{ role: "user", content: "Draw a fox" }] }, "mask"],
    ["/api/v1/responses", { model: MODEL, input: "Draw a fox", store: false }, "mask"],
  ];
  for (const [path, body, mode] of cases) {
    const stored = setup(loopReply);
    gateway.enterprise = { pii: { enabled: true, mode, output: true, entities: [] } };
    const res = await postModel(path, body);
    assert.equal(res.status, 200, `${path} ${mode}`);
    const answer = answerText(path, (await res.json()) as JsonMap);
    const link = /\((https?:\/\/[^)]+)\)/.exec(answer)?.[1];
    assert.ok(link, `${path} ${mode}: ${answer}`);
    const sent = gateway.upstream.find((call) => call.url.endsWith("/images/generations"));
    assert.equal(sent?.body?.prompt, "a fox");
    const file = stored.find((row) => row.purpose === "media");
    assert.ok(file);
    const served = await download(link, file.id);
    assert.equal(served.status, 200, `${path} ${mode}: ${link}`);
    assert.deepEqual(Buffer.from(await served.arrayBuffer()), PIXEL);
  }
});

test("generate_image keeps images that the model only links as stored media files", async () => {
  const stored = setup((call) =>
    call.url.endsWith("/images/generations")
      ? Response.json({ created: 1, data: [{ url: "https://cdn.example.com/a.png", revised_prompt: "a red fox" }] })
      : Response.json({}),
  );
  const { gateRequest } = await import("@/lib/gateway/access/gate");
  const principal = await gateRequest(gatewayRequest("/api/v1/mcp", {}));
  const spec = mediaSpec(FULL_SPEC);
  const fetched: string[] = [];
  const png = async (url: string) => {
    fetched.push(url);
    return new Response(PIXEL, { headers: { "content-type": "image/png" } });
  };
  const kept = await callMedia(spec, GENERATE_IMAGE_TOOL, { prompt: "a fox" }, principal, png);
  assert.equal(kept.isError, false, kept.text);
  assert.deepEqual(fetched, ["https://cdn.example.com/a.png"]);
  const image = (JSON.parse(kept.text) as { images: JsonMap[] }).images[0]!;
  assert.equal(image.revised_prompt, "a red fox");
  assert.equal(stored[0]?.filename, "image-1.png");
  const served = await download(String(image.url), String(image.file_id));
  assert.equal(served.status, 200);
  assert.equal(served.headers.get("content-type"), "image/png");
  assert.deepEqual(Buffer.from(await served.arrayBuffer()), PIXEL);

  const html = async () => new Response("<script>alert(1)</script>", { headers: { "content-type": "text/html" } });
  const blocked = async () => {
    throw new McpError("MCP_URL_BLOCKED");
  };
  for (const fetcher of [html, blocked]) {
    const linked = await callMedia(spec, GENERATE_IMAGE_TOOL, { prompt: "a fox" }, principal, fetcher);
    assert.equal(linked.isError, false, linked.text);
    assert.equal((JSON.parse(linked.text) as { images: JsonMap[] }).images[0]?.url, "https://cdn.example.com/a.png");
  }
  assert.equal(stored.length, 1);
});

function hubFetch(): McpFetch {
  return async (url, init) => {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${API_KEY}`);
    const req = new Request(url, { method: init.method, headers, body: init.body, signal: init.signal });
    const path = new URL(url).pathname;
    if (path === "/api/v1/mcp" && init.method === "POST") return (await import("@/app/api/v1/mcp/route")).POST(req);
    if (path === "/api/v1/mcp/sse" && init.method === "GET") return (await import("@/app/api/v1/mcp/sse/route")).GET(req);
    if (path === "/api/v1/mcp/messages" && init.method === "POST") return (await import("@/app/api/v1/mcp/messages/route")).POST(req);
    return new Response(null, { status: 405 });
  };
}

test("every MCP protocol era lists the media tools on the hub endpoint and gets working links", async () => {
  const expected = [GENERATE_IMAGE_TOOL, TEXT_TO_SPEECH_TOOL, GENERATE_VIDEO_TOOL, GET_VIDEO_TOOL, TRANSCRIBE_AUDIO_TOOL].map((name) => `mcp__media__${name}`);
  const negotiated: string[] = [];
  const eras: McpConnection[] = [
    { transport: "streamable_http", protocolVersion: MCP_PROTOCOL_VERSION },
    { transport: "streamable_http", protocolVersion: MCP_LEGACY_PROTOCOL_VERSION },
    { transport: "sse", protocolVersion: "2024-11-05" },
  ];
  for (const connection of eras) {
    const stored = setup(imageReply);
    const path = connection.transport === "sse" ? "/api/v1/mcp/sse" : "/api/v1/mcp";
    const client = new McpClient({ url: `http://hub.local${path}`, fetch: hubFetch(), connection });
    try {
      assert.equal(await client.discover(), "llmhub");
      assert.deepEqual((await client.listTools()).map((tool) => tool.name), expected);
      const outcome = await client.callTool(`mcp__media__${GENERATE_IMAGE_TOOL}`, { prompt: "a fox" });
      assert.equal(outcome.isError, false, outcome.text);
      negotiated.push(`${client.connection?.transport}:${client.connection?.protocolVersion}`);
      const image = (JSON.parse(outcome.text) as { images: JsonMap[] }).images[0]!;
      const served = await download(String(image.url), String(image.file_id));
      assert.equal(served.status, 200);
      assert.deepEqual(Buffer.from(await served.arrayBuffer()), PIXEL);
      assert.equal(stored.length, 1);
    } finally {
      await client.close();
    }
  }
  assert.deepEqual(negotiated, [`streamable_http:${MCP_PROTOCOL_VERSION}`, `streamable_http:${MCP_LEGACY_PROTOCOL_VERSION}`, `sse:${MCP_LEGACY_PROTOCOL_VERSION}`]);

  const { POST } = await import("@/app/api/v1/mcp/route");
  for (const version of MCP_LEGACY_PROTOCOL_VERSIONS) {
    setup(imageReply);
    const rpc = async (method: string, params: JsonMap) => {
      const headers: Record<string, string> = method === "initialize" ? {} : { "mcp-protocol-version": version };
      const res = await POST(gatewayRequest("/api/v1/mcp", { jsonrpc: "2.0", id: 1, method, params }, headers));
      assert.equal(res.status, 200, `${version} ${method}`);
      return ((await res.json()) as JsonMap).result as JsonMap;
    };
    const init = await rpc("initialize", { protocolVersion: version, capabilities: {}, clientInfo: { name: "lab", version: "1" } });
    assert.equal(init.protocolVersion, version);
    assert.deepEqual(((await rpc("tools/list", {})).tools as JsonMap[]).map((tool) => tool.name), expected);
    const called = await rpc("tools/call", { name: `mcp__media__${GENERATE_IMAGE_TOOL}`, arguments: { prompt: "a fox" } });
    assert.equal(called.isError, false, version);
  }
});

test("access levels reach the media tools by their read and write classes", async () => {
  const levels: [string, string[]][] = [
    ["read", [GET_VIDEO_TOOL, TRANSCRIBE_AUDIO_TOOL]],
    ["write", [GENERATE_IMAGE_TOOL, TEXT_TO_SPEECH_TOOL, GENERATE_VIDEO_TOOL, GET_VIDEO_TOOL, TRANSCRIBE_AUDIO_TOOL]],
    ["none", []],
  ];
  for (const [access, tools] of levels) {
    setup(imageReply);
    const rule = { serverId: "media1", orgId: null, teamId: null, projectId: null, memberId: null, keyId: gateway.key.id, access, extraTools: [], blockedTools: [] };
    recordedPrisma.handlers.mcpServer = { findMany: () => [{ ...mediaServerRow(), global: false, globalAccess: "all", assignments: [rule] }] };
    assert.deepEqual([...(await toolNames()).keys()], tools, access);
  }
  setup(imageReply);
  const rule = { serverId: "media1", orgId: null, teamId: null, projectId: null, memberId: null, keyId: gateway.key.id, access: "read", extraTools: [GENERATE_IMAGE_TOOL], blockedTools: [TRANSCRIBE_AUDIO_TOOL] };
  recordedPrisma.handlers.mcpServer = { findMany: () => [{ ...mediaServerRow(), global: false, globalAccess: "all", assignments: [rule] }] };
  assert.deepEqual([...(await toolNames()).keys()], [GENERATE_IMAGE_TOOL, GET_VIDEO_TOOL]);
  const blocked = await hub({ method: "tools/call", params: { name: `mcp__media__${TRANSCRIBE_AUDIO_TOOL}`, arguments: { url: "https://cdn.example.com/a.wav" } } });
  assert.match(String((blocked.error as JsonMap).message), /Unknown tool/);
  assert.equal(gateway.upstream.length, 0);
});

test("media kinds come from aliases, display names, and upstream model ids", () => {
  assert.deepEqual(mediaKindsOf(["company-images", "", "gpt-image-1"]), ["image"]);
  assert.deepEqual(mediaKindsOf(["dall-e-3"]), ["image"]);
  assert.deepEqual(mediaKindsOf(["imagen-4.0-generate-001"]), ["image"]);
  assert.deepEqual(mediaKindsOf(["black-forest-labs/FLUX.1-schnell"]), ["image"]);
  assert.deepEqual(mediaKindsOf(["gpt-4o-mini-tts"]), ["speech"]);
  assert.deepEqual(mediaKindsOf(["tts-1-hd"]), ["speech"]);
  assert.deepEqual(mediaKindsOf(["sora-2"]), ["video"]);
  assert.deepEqual(mediaKindsOf(["veo-3.0-generate-001"]), ["video"]);
  assert.deepEqual(mediaKindsOf(["whisper-1"]), ["transcription"]);
  assert.deepEqual(mediaKindsOf(["gpt-4o-mini-transcribe"]), ["transcription"]);
  assert.deepEqual(mediaKindsOf(["gpt-4o-mini", "Fluxion", "claude-sonnet-4-5"]), []);
});

test("the media download route serves safe headers, byte ranges, and refuses expired links", async () => {
  setup((call) =>
    call.url.endsWith("/audio/speech") ? new Response(PIXEL, { headers: { "content-type": "audio/mpeg" } }) : Response.json({}),
  );
  const audio = (await callTool(TEXT_TO_SPEECH_TOOL, { text: "Hallo" })).json.audio as JsonMap;
  const { GET } = await import("@/app/api/media/[id]/route");
  const fetchRange = (range?: string) =>
    GET(new Request(String(audio.url), { headers: range ? { range } : {} }), { params: Promise.resolve({ id: String(audio.file_id) }) });

  const full = await fetchRange();
  assert.equal(full.status, 200);
  assert.deepEqual(
    ["content-type", "x-content-type-options", "referrer-policy", "content-disposition", "accept-ranges"].map((name) => full.headers.get(name)),
    ["audio/mpeg", "nosniff", "no-referrer", 'inline; filename="speech.mp3"', "bytes"],
  );
  const size = PIXEL.byteLength;
  const cases: [string, number, string | null, Buffer | null][] = [
    ["bytes=0-1", 206, `bytes 0-1/${size}`, PIXEL.subarray(0, 2)],
    ["bytes=4-", 206, `bytes 4-${size - 1}/${size}`, PIXEL.subarray(4)],
    ["bytes=-3", 206, `bytes ${size - 3}-${size - 1}/${size}`, PIXEL.subarray(size - 3)],
    ["bytes=2-999", 206, `bytes 2-${size - 1}/${size}`, PIXEL.subarray(2)],
    [`bytes=${size}-`, 416, `bytes */${size}`, null],
    ["bytes=5-2", 200, null, PIXEL],
    ["bytes=0-1,4-5", 200, null, PIXEL],
  ];
  for (const [range, status, contentRange, body] of cases) {
    const res = await fetchRange(range);
    assert.equal(res.status, status, range);
    assert.equal(res.headers.get("content-range"), contentRange, range);
    if (body) assert.deepEqual(Buffer.from(await res.arrayBuffer()), body, range);
  }

  const expired = new URL(mediaLink(String(audio.file_id), Date.now() - MEDIA_LINK_TTL_MS - 1_000));
  const refused = await GET(new Request(expired), { params: Promise.resolve({ id: String(audio.file_id) }) });
  assert.equal(refused.status, 403);
  const other = await GET(new Request(String(audio.url)), { params: Promise.resolve({ id: "obj999" }) });
  assert.equal(other.status, 403);
});

test("media tools report forbidden and removed models as tool errors without calling upstream", async () => {
  setup(imageReply);
  gateway.key = { ...gateway.key, models: [MODEL] };
  const forbidden = await callTool(GENERATE_IMAGE_TOOL, { prompt: "a fox" });
  assert.equal(forbidden.isError, true);
  assert.equal(
    forbidden.text,
    "generate_image failed: this API key may not use the image model image-test (model not allowed for this key). Ask an administrator for access to it.",
  );

  setup(imageReply);
  gateway.groups.delete(IMAGE_MODEL);
  try {
    const removed = await callTool(GENERATE_IMAGE_TOOL, { prompt: "a fox" });
    assert.equal(removed.isError, true);
    assert.match(removed.text, /^generate_image failed with the image model image-test: /);
  } finally {
    gateway.groups.set(IMAGE_MODEL, groupRow(IMAGE_MODEL));
  }
  assert.equal(gateway.upstream.some((call) => call.url.endsWith("/images/generations")), false);
});

test("the media tool catalogue matches the served tools and the access levels that reach them", () => {
  assert.deepEqual(
    mediaToolSpecs(mediaSpec(FULL_SPEC)).map((tool) => [tool.name, tool.action]),
    Object.values(MEDIA_KIND_TOOLS).flat().map((tool) => [tool.name, tool.action]),
  );
  const kinds = ["image", "speech", "video", "transcription"] as const;
  assert.deepEqual(mediaToolsAt("none", kinds), []);
  assert.deepEqual(mediaToolsAt("read", kinds), [GET_VIDEO_TOOL, TRANSCRIBE_AUDIO_TOOL]);
  assert.deepEqual(mediaToolsAt("write", ["image", "transcription"]), [GENERATE_IMAGE_TOOL, TRANSCRIBE_AUDIO_TOOL]);
  assert.deepEqual(mediaToolsAt("all", ["speech"]), [TEXT_TO_SPEECH_TOOL]);
});

test("transcription uploads carry a file extension the upstream recognizes", () => {
  assert.equal(audioFilename("speech.mp3", "audio/mpeg"), "speech.mp3");
  assert.equal(audioFilename("audio", "audio/mpeg"), "audio.mp3");
  assert.equal(audioFilename("download.bin", "audio/wav; codecs=1"), "download.wav");
  assert.equal(audioFilename("voice", "audio/x-m4a"), "voice.m4a");
  assert.equal(audioFilename("clip.aac", "audio/aac"), "clip.aac");
  assert.equal(audioFilename("", "audio/ogg"), "audio.ogg");
});

function hangingFetch(path: string, delivered: { signal: AbortSignal | null }) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.endsWith(path)) return original(input, init);
    delivered.signal = init?.signal ?? null;
    gateway.upstream.push({ url, body: null, headers: {} });
    return new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
    });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

test("a caller that hangs up aborts the media upstream request and books it as cancelled", async () => {
  setup(imageReply);
  const delivered = { signal: null as AbortSignal | null };
  const restore = hangingFetch("/images/generations", delivered);
  try {
    const { gateRequest } = await import("@/lib/gateway/access/gate");
    const { hubMcpTools } = await import("@/lib/mcp/hub");
    const principal = await gateRequest(gatewayRequest("/api/v1/mcp", {}));
    const caller = new AbortController();
    const pending = hubMcpTools(principal).call(`mcp__media__${GENERATE_IMAGE_TOOL}`, { prompt: "a fox" }, caller.signal);
    for (let wait = 0; wait < 200 && !delivered.signal; wait++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(delivered.signal, "the upstream request started");
    caller.abort();
    const result = await pending;
    assert.equal(result.isError, true);
    assert.match(String((result.content as JsonMap[])[0]?.text), /stopped because the request ended/);
    assert.equal(delivered.signal.aborted, true);
    const [log] = await bookedLogs(1);
    assert.deepEqual([log?.status, log?.outcome, log?.endpoint], [499, "cancelled", "/api/v1/images/generations"]);
    assert.equal(gateway.upstream.filter((call) => call.url.endsWith("/images/generations")).length, 1);
  } finally {
    restore();
  }
});

test("media calls get their own longer timeout and report a timeout as an upstream timeout", async () => {
  setup(imageReply);
  const { createExecutor, serverRecord } = await import("@/lib/mcp/toolset");
  const media = serverRecord({ ...mediaServerRow(), id: "media1" });
  const remote = serverRecord({ ...mediaServerRow(), id: "remote1", kind: "remote", url: "https://mcp.example.com/mcp" });
  const executor = createExecutor(new Map([["media1", media], ["remote1", remote]]));
  const bound = (serverId: string) => ({ serverId, serverName: "x", name: "x", tool: { name: GENERATE_IMAGE_TOOL, inputSchema: {} } });
  assert.equal(executor.timeoutMs(bound("media1") as never), MEDIA_TOOL_TIMEOUT_MS);
  assert.equal(executor.timeoutMs(bound("remote1") as never), 30_000);

  const delivered = { signal: null as AbortSignal | null };
  const restore = hangingFetch("/images/generations", delivered);
  try {
    const { gateRequest } = await import("@/lib/gateway/access/gate");
    const principal = await gateRequest(gatewayRequest("/api/v1/mcp", {}));
    const outcome = await callMedia(mediaSpec(FULL_SPEC), GENERATE_IMAGE_TOOL, { prompt: "a fox" }, principal, async () => new Response(null), AbortSignal.timeout(50));
    assert.equal(outcome.isError, true);
    assert.equal(outcome.text, "generate_image failed with the image model image-test: upstream request timed out");
    const [log] = await bookedLogs(1);
    assert.deepEqual([log?.status, log?.outcome], [504, "error"]);
  } finally {
    restore();
  }
});

test("a caller that is already gone starts no media work", async () => {
  setup(imageReply);
  const { gateRequest } = await import("@/lib/gateway/access/gate");
  const principal = await gateRequest(gatewayRequest("/api/v1/mcp", {}));
  const gone = new AbortController();
  gone.abort();
  const outcome = await callMedia(mediaSpec(FULL_SPEC), GENERATE_IMAGE_TOOL, { prompt: "a fox" }, principal, async () => new Response(null), gone.signal);
  assert.equal(outcome.isError, true);
  assert.equal(gateway.upstream.length, 0);
});

test("generate_video keeps the job it started when the caller hangs up during the create call", async () => {
  let release = () => {};
  const created = new Promise<void>((resolve) => {
    release = resolve;
  });
  const stored = setup(() => Response.json({}));
  gateway.reply = async (call) => {
    if (!call.url.endsWith("/videos")) return Response.json({});
    await created;
    return Response.json({ id: "vid_late", object: "video", status: "queued" });
  };
  const { gateRequest } = await import("@/lib/gateway/access/gate");
  const principal = await gateRequest(gatewayRequest("/api/v1/mcp", {}));
  const caller = new AbortController();
  const pending = callMedia(mediaSpec(FULL_SPEC), GENERATE_VIDEO_TOOL, { prompt: "a fox" }, principal, async () => new Response(null), caller.signal);
  for (let wait = 0; wait < 200 && !gateway.upstream.length; wait++) await new Promise((resolve) => setTimeout(resolve, 5));
  caller.abort();
  release();
  const outcome = await pending;
  assert.equal(outcome.isError, false, outcome.text);
  const job = stored.find((row) => row.kind === "video");
  assert.equal((job?.meta as JsonMap | undefined)?.upstream_id, "vid_late");
  assert.equal(JSON.parse(outcome.text).video_id, job?.id);
});

test("get_video passes on string errors from providers that report them that way", async () => {
  const stored = setup((call) => {
    if (call.url.endsWith("/videos") && call.body) return Response.json({ id: "vid_or", status: "pending" });
    if (call.url.endsWith("/videos/vid_or")) return Response.json({ id: "vid_or", status: "failed", error: "content policy violation" });
    return Response.json({});
  });
  const started = await callTool(GENERATE_VIDEO_TOOL, { prompt: "a fox" });
  assert.equal(started.json.status, "pending");
  const failed = await callTool(GET_VIDEO_TOOL, { video_id: String(started.json.video_id) });
  assert.equal(failed.isError, true);
  assert.deepEqual(JSON.parse(failed.text), { video_id: started.json.video_id, status: "failed", error: "content policy violation" });
  assert.equal(stored.filter((row) => row.kind === "file").length, 0);
});

test("OpenRouter video requests send the length as an integer duration", async () => {
  const { prepareBody } = await import("@/lib/gateway/dispatch/upstream");
  const dep = (kind: string) => ({ ...(groupRow(VIDEO_MODEL) as { deployments: JsonMap[] }).deployments[0], kind, model: "openai/sora-2" }) as never;
  const body = { model: VIDEO_MODEL, prompt: "a fox", seconds: "8", size: "1280x720" };
  assert.deepEqual(prepareBody(dep("openrouter"), "/videos", body), { model: "openai/sora-2", prompt: "a fox", duration: 8, size: "1280x720" });
  assert.deepEqual(prepareBody(dep("openrouter_eu"), "/videos", { ...body, seconds: "long" }), { ...body, seconds: "long", model: "openai/sora-2" });
  assert.deepEqual(prepareBody(dep("openai"), "/videos", body), { ...body, model: "openai/sora-2" });
});
