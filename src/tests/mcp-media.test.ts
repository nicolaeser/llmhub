import { API_KEY, gateway, gatewayRequest, groupRow, resetGateway, UPSTREAM, type UpstreamCall } from "./support/gateway-harness";
import { recordedPrisma } from "./support/recorded-prisma";
import assert from "node:assert/strict";
import test from "node:test";
import { MCP_PROTOCOL_VERSION } from "@/lib/mcp/client";
import {
  callMedia,
  GENERATE_IMAGE_TOOL,
  GENERATE_VIDEO_TOOL,
  GET_VIDEO_TOOL,
  MEDIA_LINK_TTL_MS,
  MEDIA_SERVER_URL,
  mediaLink,
  mediaLinkValid,
  mediaSpec,
  mediaToolSpecs,
  mediaType,
  TEXT_TO_SPEECH_TOOL,
  TRANSCRIBE_AUDIO_TOOL,
} from "@/lib/mcp/media";
import type { JsonMap, Principal } from "@/types/gateway";
import type { KeyEndpoint } from "@/types/keys";
import type { McpMediaSpec } from "@/types/mcp";

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
  const expires = url.searchParams.get("expires");
  const signature = url.searchParams.get("signature");
  assert.equal(url.pathname, "/api/media/obj1");
  assert.equal(Number(expires), now + MEDIA_LINK_TTL_MS);
  assert.equal(mediaLinkValid("obj1", expires, signature, now), true);
  assert.equal(mediaLinkValid("obj2", expires, signature, now), false);
  assert.equal(mediaLinkValid("obj1", String(Number(expires) + 1), signature, now), false);
  assert.equal(mediaLinkValid("obj1", expires, `${signature}x`, now), false);
  assert.equal(mediaLinkValid("obj1", expires, signature, now + MEDIA_LINK_TTL_MS + 1), false);
  assert.equal(mediaLinkValid("obj1", null, signature, now), false);
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
