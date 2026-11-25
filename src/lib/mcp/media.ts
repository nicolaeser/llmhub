import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { signingSecret } from "@/lib/crypto";
import { env } from "@/lib/env";
import { allowEndpoint, allowModel, applyGuardrails, modelChain, withTrace } from "@/lib/gateway/access/gate";
import { gatewayPath } from "@/lib/gateway/api-paths";
import { assertBudget, usageFromUnknown } from "@/lib/gateway/billing/billing";
import { capRequestCost } from "@/lib/gateway/billing/cost-cap";
import { meter } from "@/lib/gateway/billing/meter";
import { estimateTokens } from "@/lib/gateway/billing/tokens";
import { asRecord, ownerId } from "@/lib/gateway/core";
import { forwardToModel } from "@/lib/gateway/dispatch/upstream";
import { refreshVideo, storeVideo, videoRecord } from "@/lib/gateway/endpoints/videos";
import { clientClosedError, GateError, isClientClosed } from "@/lib/gateway/errors";
import { canReadObject, getObject, putObject } from "@/lib/gateway/storage/objects";
import { errorFields } from "@/lib/logging/format";
import { logger } from "@/lib/logging/logger";
import { McpError } from "@/lib/mcp/errors";
import {
  GENERATE_IMAGE_TOOL,
  GENERATE_VIDEO_TOOL,
  GET_VIDEO_TOOL,
  TEXT_TO_SPEECH_TOOL,
  TRANSCRIBE_AUDIO_TOOL,
} from "@/lib/mcp/media-tools";
import { guardedFetch } from "@/lib/mcp/transport";
import { parseJsonOrNull } from "@/lib/utils/json";
import { cancelQuietly } from "@/lib/utils/streams";
import type { JsonMap, Principal, StoredObjectRecord } from "@/types/gateway";
import type { McpFetch, McpMediaKind, McpMediaSpec, McpToolOutcome, McpToolSpec } from "@/types/mcp";

export const MEDIA_SERVER_URL = "llmhub:media";
export const MEDIA_KINDS = ["image", "speech", "video", "transcription"] as const satisfies readonly McpMediaKind[];
export const MEDIA_LINK_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const MEDIA_TOOL_TIMEOUT_MS = 180_000;
export const MAX_IMAGES_PER_CALL = 4;
export const MAX_SPEECH_CHARS = 4096;
export const MAX_REMOTE_BYTES = 25 * 1024 * 1024;
export const IMAGE_SIZES = ["auto", "1024x1024", "1536x1024", "1024x1536"] as const;
export const SPEECH_FORMATS = ["mp3", "wav", "opus", "aac", "flac"] as const;
export const DEFAULT_VOICE = "alloy";

const MEDIA_PURPOSE = "media";
const MAX_PROMPT_CHARS = 8000;
const REMOTE_FETCH_MS = 60_000;
const IMAGE_TYPES: Record<string, string> = { png: "image/png", jpeg: "image/jpeg", jpg: "image/jpeg", webp: "image/webp" };
const IMAGE_EXTENSIONS: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };
const AUDIO_TYPES: Record<string, string> = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  opus: "audio/ogg",
  aac: "audio/aac",
  flac: "audio/flac",
};
const TRANSCRIBABLE_EXTENSIONS = new Set(["flac", "mp3", "mp4", "mpeg", "mpga", "m4a", "ogg", "wav", "webm"]);
const TRANSCRIBABLE_TYPES: Record<string, string> = {
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
  "audio/ogg": "ogg",
  "audio/opus": "ogg",
  "audio/webm": "webm",
  "video/webm": "webm",
  "audio/flac": "flac",
  "audio/x-flac": "flac",
  "audio/mp4": "m4a",
  "audio/m4a": "m4a",
  "audio/x-m4a": "m4a",
  "video/mp4": "mp4",
};
const VIDEO_DONE = "completed";
const VIDEO_EXTENSIONS: Record<string, string> = {
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
  "video/ogg": "ogv",
  "video/x-matroska": "mkv",
  "video/mpeg": "mpeg",
};
const MEDIA_TYPE = /^(?:audio|video)\/[a-z0-9][a-z0-9.+-]{0,63}$/;
const VIDEO_FAILED = new Set(["failed", "cancelled", "expired"]);
const LINK_NOTE = "Links open without an API key and expire after 7 days.";
const PII_SAFE_EXPIRY = /^[0-9a-z]{1,10}$/;
const PII_SAFE_SIGNATURE = /^[0-9A-F]{64}$/;
const DECIMAL_MS_EXPIRY = /^\d{1,16}$/;
const BYTE_RANGE = /^bytes=(\d{0,15})-(\d{0,15})$/;

type MediaContext = { spec: McpMediaSpec; args: JsonMap; principal: Principal; fetchRemote: McpFetch; signal: AbortSignal };

class ToolInputError extends Error {}

function modelOf(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function mediaSpec(raw: unknown): McpMediaSpec {
  const spec = asRecord(raw);
  const speech = asRecord(spec?.speech);
  return {
    image: { model: modelOf(asRecord(spec?.image)?.model) },
    speech: { model: modelOf(speech?.model), voice: modelOf(speech?.voice) },
    video: { model: modelOf(asRecord(spec?.video)?.model) },
    transcription: { model: modelOf(asRecord(spec?.transcription)?.model) },
  };
}

function schema(properties: JsonMap, required: string[]): JsonMap {
  return { type: "object", properties, required, additionalProperties: false };
}

const IMAGE_TOOL: McpToolSpec = {
  name: GENERATE_IMAGE_TOOL,
  title: "Generate image",
  description:
    "Creates images from a text description and returns download links. Write a detailed prompt in English. Show each returned url to the user as a Markdown image.",
  inputSchema: schema(
    {
      prompt: { type: "string", description: "Detailed description of the image to create." },
      size: { type: "string", enum: [...IMAGE_SIZES], description: "Image size. Defaults to auto." },
      count: { type: "integer", minimum: 1, maximum: MAX_IMAGES_PER_CALL, description: "Number of images. Defaults to 1." },
    },
    ["prompt"],
  ),
  action: "write",
};

function speechTool(voice: string): McpToolSpec {
  return {
    name: TEXT_TO_SPEECH_TOOL,
    title: "Text to speech",
    description: "Reads text aloud and returns a link to the audio file. Give the link to the user.",
    inputSchema: schema(
      {
        text: { type: "string", description: `Text to speak, at most ${MAX_SPEECH_CHARS} characters.` },
        voice: { type: "string", description: `Voice name supported by the speech model. Defaults to ${voice || DEFAULT_VOICE}.` },
        format: { type: "string", enum: [...SPEECH_FORMATS], description: "Audio format. Defaults to mp3." },
        instructions: { type: "string", description: "Optional guidance for tone, pace, or accent." },
      },
      ["text"],
    ),
    action: "write",
  };
}

const VIDEO_TOOLS: McpToolSpec[] = [
  {
    name: GENERATE_VIDEO_TOOL,
    title: "Generate video",
    description:
      "Starts creating a video from a text description and returns a video_id. Videos take minutes; call get_video with the video_id until it reports a url.",
    inputSchema: schema(
      {
        prompt: { type: "string", description: "Detailed description of the video, including subject, motion, and camera." },
        seconds: { type: "string", description: "Length in seconds as supported by the video model, for example 4, 8, or 12." },
        size: { type: "string", description: "Resolution as supported by the video model, for example 1280x720 or 720x1280." },
      },
      ["prompt"],
    ),
    action: "write",
  },
  {
    name: GET_VIDEO_TOOL,
    title: "Get video",
    description: "Checks a video started with generate_video. Returns its status and progress, and a download url once it is completed.",
    inputSchema: schema({ video_id: { type: "string", description: "The video_id returned by generate_video." } }, ["video_id"]),
    action: "read",
  },
];

const TRANSCRIBE_TOOL: McpToolSpec = {
  name: TRANSCRIBE_AUDIO_TOOL,
  title: "Transcribe audio",
  description:
    "Turns speech in an audio file into text. Pass a public https url or the file_id of an uploaded file. Media links from text_to_speech work too.",
  inputSchema: schema(
    {
      url: { type: "string", description: "Public https url of an audio file." },
      file_id: { type: "string", description: "Id of an audio file uploaded to this gateway." },
      language: { type: "string", description: "Optional ISO 639-1 language code of the audio, for example de or en." },
    },
    [],
  ),
  action: "read",
};

const KIND_PATTERNS: Record<McpMediaKind, RegExp> = {
  image:
    /dall-e|gpt-image|stable-diffusion|sdxl|seedream|ideogram|recraft|(?:^|[^a-z])(?:imagen|imagine|image|flux)(?:[^a-z]|$)/,
  speech: /text-to-speech|(?:^|[^a-z])tts(?:[^a-z]|$)/,
  video: /(?:^|[^a-z])(?:sora|veo|kling|video)(?:[^a-z]|$)/,
  transcription: /whisper|transcri|speech-to-text|(?:^|[^a-z])stt(?:[^a-z]|$)/,
};

export function mediaKindsOf(names: readonly string[]): McpMediaKind[] {
  const folded = names.map((name) => name.trim().toLowerCase()).filter(Boolean);
  return MEDIA_KINDS.filter((kind) => folded.some((name) => KIND_PATTERNS[kind].test(name)));
}

export function mediaToolSpecs(spec: McpMediaSpec): McpToolSpec[] {
  return [
    ...(spec.image.model ? [IMAGE_TOOL] : []),
    ...(spec.speech.model ? [speechTool(spec.speech.voice)] : []),
    ...(spec.video.model ? VIDEO_TOOLS : []),
    ...(spec.transcription.model ? [TRANSCRIBE_TOOL] : []),
  ];
}

function linkDigest(id: string, expires: string): Buffer {
  return createHmac("sha256", signingSecret()).update(`media-link:${id}:${expires}`).digest();
}

function hexSignature(digest: Buffer): string {
  return digest.toString("hex").toUpperCase();
}

export function mediaLink(id: string, now = Date.now()): string {
  const expires = Math.floor((now + MEDIA_LINK_TTL_MS) / 1000).toString(36);
  const url = new URL(`/api/media/${encodeURIComponent(id)}`, env.NEXT_PUBLIC_APP_URL);
  url.searchParams.set("expires", expires);
  url.searchParams.set("signature", hexSignature(linkDigest(id, expires)));
  return url.toString();
}

type LinkScheme = { at: number; encode: (digest: Buffer) => string };

function linkScheme(expires: string, signature: string): LinkScheme | null {
  if (PII_SAFE_EXPIRY.test(expires) && PII_SAFE_SIGNATURE.test(signature)) {
    return { at: parseInt(expires, 36) * 1000, encode: hexSignature };
  }
  if (DECIMAL_MS_EXPIRY.test(expires)) return { at: Number(expires), encode: (digest) => digest.toString("base64url") };
  return null;
}

export function mediaLinkValid(id: string, expires: string | null, signature: string | null, now = Date.now()): boolean {
  if (!expires || !signature) return false;
  const scheme = linkScheme(expires, signature);
  if (!scheme || !Number.isSafeInteger(scheme.at) || scheme.at < now) return false;
  const expected = Buffer.from(scheme.encode(linkDigest(id, expires)));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export type MediaRange = { start: number; end: number };

export function mediaRange(header: string | null, size: number): MediaRange | "unsatisfiable" | null {
  const match = header ? BYTE_RANGE.exec(header.trim()) : null;
  if (!match || (!match[1] && !match[2])) return null;
  if (!match[1]) {
    const suffix = Number(match[2]);
    return suffix && size ? { start: Math.max(0, size - suffix), end: size - 1 } : "unsatisfiable";
  }
  const start = Number(match[1]);
  const last = match[2] ? Number(match[2]) : size - 1;
  if (match[2] && last < start) return null;
  if (start >= size) return "unsatisfiable";
  return { start, end: Math.min(last, size - 1) };
}

export function isMediaObject(meta: unknown, purpose: string): boolean {
  return purpose === MEDIA_PURPOSE && asRecord(meta)?.media === true;
}

function ownMediaUrl(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const own = new URL(env.NEXT_PUBLIC_APP_URL);
  return url.origin === own.origin && url.pathname.startsWith("/api/media/") ? url : null;
}

function mediaIdOfLink(raw: string): string | null {
  const url = ownMediaUrl(raw);
  const match = url ? /^\/api\/media\/([^/]+)$/.exec(url.pathname) : null;
  if (!url || !match?.[1]) return null;
  const id = decodedSegment(match[1]);
  return id && mediaLinkValid(id, url.searchParams.get("expires"), url.searchParams.get("signature")) ? id : null;
}

function decodedSegment(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function text(args: JsonMap, key: string, max: number): string {
  const value = typeof args[key] === "string" ? (args[key] as string).trim() : "";
  if (value.length > max) throw new ToolInputError(`${key} must be at most ${max} characters.`);
  return value;
}

function required(args: JsonMap, key: string, max: number): string {
  const value = text(args, key, max);
  if (!value) throw new ToolInputError(`${key} is required.`);
  return value;
}

async function storeMedia(
  principal: Principal,
  model: string,
  file: { filename: string; contentType: string; payload: Uint8Array },
): Promise<JsonMap> {
  const stored = await putObject({
    kind: "file",
    owner: ownerId(principal),
    filename: file.filename,
    purpose: MEDIA_PURPOSE,
    contentType: file.contentType,
    payload: file.payload,
    meta: { media: true, model },
  });
  return { url: mediaLink(stored.id), file_id: stored.id, content_type: file.contentType };
}

async function guardedRequest(model: string, principal: Principal, body: JsonMap): Promise<{ aliases: string[]; clean: JsonMap }> {
  allowModel(principal, model);
  const clean = (await applyGuardrails(body, principal)).body;
  return { aliases: modelChain(principal, model, clean), clean };
}

type Meter = ReturnType<typeof meter>;

async function metered<T extends Parameters<Meter["ok"]>[0] & { json?: unknown }>(
  principal: Principal,
  model: string,
  body: JsonMap,
  run: () => Promise<T>,
  usageOf: (hit: T) => Parameters<Meter["ok"]>[1] = (hit) => usageFromUnknown(asRecord(hit.json)?.usage, hit.json),
  responseOf: (hit: T) => unknown = (hit) => hit.json,
): Promise<T> {
  const usage = meter(principal, model, body);
  try {
    const hit = await run();
    await usage.ok(hit, usageOf(hit), responseOf(hit));
    return hit;
  } catch (err) {
    await usage.fail(err);
    throw err;
  }
}

export function mediaType(header: string, family: "audio/" | "video/", fallback: string): string {
  const type = (header.split(";")[0] ?? "").trim().toLowerCase();
  return type.startsWith(family) && MEDIA_TYPE.test(type) ? type : fallback;
}

function videoFilename(contentType: string): string {
  return `video.${VIDEO_EXTENSIONS[contentType] ?? "mp4"}`;
}

function success(payload: JsonMap): McpToolOutcome {
  return { text: JSON.stringify(payload), isError: false };
}

function failure(message: string): McpToolOutcome {
  return { text: message, isError: true };
}

function gateFailure(tool: string, kind: McpMediaKind, model: string, err: GateError): string {
  if (err.code === "model_access_denied") {
    return `${tool} failed: this API key may not use the ${kind} model ${model} (${err.message}). Ask an administrator for access to it.`;
  }
  return `${tool} failed with the ${kind} model ${model}: ${err.message}`;
}

function remoteSignal(caller: AbortSignal): AbortSignal {
  return AbortSignal.any([AbortSignal.timeout(REMOTE_FETCH_MS), caller]);
}

async function keptImage(ctx: MediaContext, model: string, url: string, index: number): Promise<JsonMap | null> {
  try {
    const res = await ctx.fetchRemote(url, { method: "GET", headers: { accept: "image/*" }, signal: remoteSignal(ctx.signal) });
    const contentType = (res.headers.get("content-type")?.split(";")[0] ?? "").trim().toLowerCase();
    const extension = IMAGE_EXTENSIONS[contentType];
    if (!res.ok || !extension) {
      await cancelQuietly(res.body);
      return null;
    }
    const payload = await readLimited(res, "image");
    return await storeMedia(ctx.principal, model, { filename: `image-${index + 1}.${extension}`, contentType, payload });
  } catch (err) {
    logger.warn("mcp.media_image_kept_link", { ...(err instanceof McpError ? { code: err.code } : errorFields(err)) });
    return null;
  }
}

async function generateImage(ctx: MediaContext): Promise<McpToolOutcome> {
  const { spec, args, principal } = ctx;
  const model = spec.image.model;
  const body: JsonMap = { model, prompt: required(args, "prompt", MAX_PROMPT_CHARS) };
  const count = typeof args.count === "number" ? Math.trunc(args.count) : 1;
  body.n = Math.min(MAX_IMAGES_PER_CALL, Math.max(1, count || 1));
  if (typeof args.size === "string" && args.size !== "auto" && (IMAGE_SIZES as readonly string[]).includes(args.size)) {
    body.size = args.size;
  }
  const { aliases, clean } = await guardedRequest(model, principal, body);
  const hit = await metered(principal, model, body, () =>
    forwardToModel(aliases, principal, "/images/generations", clean, { signal: ctx.signal, timeoutMs: MEDIA_TOOL_TIMEOUT_MS }),
  );
  const response = asRecord(hit.json) ?? {};
  const format = typeof response.output_format === "string" ? response.output_format.toLowerCase() : "png";
  const contentType = IMAGE_TYPES[format] ?? "image/png";
  const extension = contentType === "image/jpeg" ? "jpg" : contentType.slice("image/".length);
  const images: JsonMap[] = [];
  for (const [index, raw] of (Array.isArray(response.data) ? response.data : []).entries()) {
    const item = asRecord(raw);
    if (!item) continue;
    const revised = typeof item.revised_prompt === "string" ? { revised_prompt: item.revised_prompt } : {};
    if (typeof item.b64_json === "string" && item.b64_json) {
      const file = { filename: `image-${index + 1}.${extension}`, contentType, payload: Buffer.from(item.b64_json, "base64") };
      images.push({ ...(await storeMedia(principal, model, file)), ...revised });
    } else if (typeof item.url === "string" && item.url) {
      images.push({ ...((await keptImage(ctx, model, item.url, index)) ?? { url: item.url }), ...revised });
    }
  }
  if (!images.length) return failure("The image model returned no images.");
  return success({ images, note: `Show each url to the user as a Markdown image. ${LINK_NOTE}` });
}

async function textToSpeech({ spec, args, principal, signal }: MediaContext): Promise<McpToolOutcome> {
  const model = spec.speech.model;
  const input = required(args, "text", MAX_SPEECH_CHARS);
  const format = (SPEECH_FORMATS as readonly string[]).includes(String(args.format)) ? String(args.format) : "mp3";
  const body: JsonMap = { model, input, voice: text(args, "voice", 64) || spec.speech.voice || DEFAULT_VOICE, response_format: format };
  const instructions = text(args, "instructions", 1000);
  if (instructions) body.instructions = instructions;
  const { aliases, clean } = await guardedRequest(model, principal, body);
  const hit = await metered(
    principal,
    model,
    body,
    () => forwardToModel(aliases, principal, "/audio/speech", clean, { binary: true, signal, timeoutMs: MEDIA_TOOL_TIMEOUT_MS }),
    () => ({ prompt_tokens: estimateTokens(typeof clean.input === "string" ? clean.input : input) }),
  );
  const contentType = mediaType(hit.contentType, "audio/", AUDIO_TYPES[format]!);
  const audio = await storeMedia(principal, model, { filename: `speech.${format}`, contentType, payload: hit.raw });
  return success({ audio, note: `Give the url to the user as a link. ${LINK_NOTE}` });
}

function videoView(json: JsonMap, id: string): JsonMap {
  const status = typeof json.status === "string" ? json.status : "unknown";
  const view: JsonMap = { video_id: id, status };
  if (typeof json.progress === "number") view.progress = json.progress;
  const error = typeof json.error === "string" ? json.error : asRecord(json.error)?.message;
  if (typeof error === "string" && error) view.error = error;
  return view;
}

async function generateVideo({ spec, args, principal, signal }: MediaContext): Promise<McpToolOutcome> {
  const model = spec.video.model;
  const body: JsonMap = { model, prompt: required(args, "prompt", MAX_PROMPT_CHARS) };
  const seconds = text(args, "seconds", 8);
  const size = text(args, "size", 32);
  if (seconds) body.seconds = seconds;
  if (size) body.size = size;
  const { aliases, clean } = await guardedRequest(model, principal, body);
  if (signal.aborted) throw clientClosedError();
  const hit = await metered(principal, model, body, () => forwardToModel(aliases, principal, "/videos", clean, { timeoutMs: MEDIA_TOOL_TIMEOUT_MS }));
  const stored = await storeVideo(principal, model, hit.json);
  return success({
    ...videoView(stored, String(stored.id)),
    note: "The video is being created. Call get_video with this video_id in a while to get the download url.",
  });
}

async function getVideo({ args, principal }: MediaContext): Promise<McpToolOutcome> {
  const id = required(args, "video_id", 200);
  const { object, model, upstreamId } = await videoRecord(principal, id);
  const previous = asRecord(parseJsonOrNull(Buffer.from(object.payload).toString("utf8"))) ?? {};
  const kept = asRecord(previous.media_file);
  if (typeof kept?.file_id === "string") {
    return success({ ...videoView(previous, id), video: { ...kept, url: mediaLink(kept.file_id) }, note: LINK_NOTE });
  }
  const status = await forwardToModel([model], principal, `/videos/${upstreamId}`, null, { method: "GET" });
  const json = asRecord(status.json) ?? {};
  if (json.status !== VIDEO_DONE) {
    await refreshVideo(id, json);
    const done = typeof json.status === "string" && VIDEO_FAILED.has(json.status);
    return done ? failure(JSON.stringify(videoView(json, id))) : success({ ...videoView(json, id), note: "Not ready yet. Check again later." });
  }
  const content = await forwardToModel([model], principal, `/videos/${upstreamId}/content`, null, { method: "GET", binary: true });
  const contentType = mediaType(content.contentType, "video/", "video/mp4");
  const video = await storeMedia(principal, model, { filename: videoFilename(contentType), contentType, payload: content.raw });
  await refreshVideo(id, { ...json, media_file: { file_id: video.file_id, content_type: contentType } });
  return success({ ...videoView(json, id), video, note: `Give the url to the user as a link. ${LINK_NOTE}` });
}

async function readLimited(res: Response, label: "audio" | "image"): Promise<Uint8Array> {
  const tooLarge = `The ${label} file is larger than 25 MB.`;
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > MAX_REMOTE_BYTES) {
    await cancelQuietly(res.body);
    throw new ToolInputError(tooLarge);
  }
  const reader = res.body?.getReader();
  if (!reader) return new Uint8Array();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_REMOTE_BYTES) {
      await cancelQuietly(reader);
      throw new ToolInputError(tooLarge);
    }
    parts.push(value);
  }
  return Buffer.concat(parts);
}

function storedAudio(object: StoredObjectRecord): { payload: Uint8Array; filename: string; contentType: string } {
  if (object.bytes > MAX_REMOTE_BYTES) throw new ToolInputError("The audio file is larger than 25 MB.");
  return { payload: object.payload, filename: object.filename || "audio", contentType: object.contentType || "application/octet-stream" };
}

async function audioSource(ctx: MediaContext): Promise<{ payload: Uint8Array; filename: string; contentType: string }> {
  const fileId = text(ctx.args, "file_id", 200);
  const url = text(ctx.args, "url", 4096);
  if (fileId) {
    const object = await getObject(fileId);
    if (object?.kind !== "file" || !canReadObject(object, ctx.principal)) throw new ToolInputError("File not found.");
    return storedAudio(object);
  }
  if (url && ownMediaUrl(url)) {
    const linked = mediaIdOfLink(url);
    if (!linked) throw new ToolInputError("media link is invalid or expired");
    const object = await getObject(linked);
    if (object?.kind !== "file" || !isMediaObject(object.meta, object.purpose)) throw new ToolInputError("File not found.");
    return storedAudio(object);
  }
  if (!url) throw new ToolInputError("Pass url or file_id.");
  let res: Response;
  try {
    res = await ctx.fetchRemote(url, { method: "GET", headers: { accept: "audio/*" }, signal: remoteSignal(ctx.signal) });
  } catch (err) {
    if (err instanceof McpError) throw new ToolInputError("This url cannot be fetched. Use a public https url.", { cause: err });
    throw err;
  }
  if (!res.ok) {
    await cancelQuietly(res.body);
    throw new ToolInputError(`Fetching the audio failed with status ${res.status}.`);
  }
  const name = new URL(url).pathname.split("/").pop() || "audio";
  return { payload: await readLimited(res, "audio"), filename: name, contentType: res.headers.get("content-type") ?? "application/octet-stream" };
}

export function audioFilename(name: string, contentType: string): string {
  const extension = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? "";
  if (TRANSCRIBABLE_EXTENSIONS.has(extension)) return name;
  const derived = TRANSCRIBABLE_TYPES[(contentType.split(";")[0] ?? "").trim().toLowerCase()];
  return derived ? `${name.replace(/\.[a-z0-9]*$/i, "") || "audio"}.${derived}` : name;
}

async function transcribeAudio(ctx: MediaContext): Promise<McpToolOutcome> {
  const { spec, args, principal } = ctx;
  const model = spec.transcription.model;
  allowModel(principal, model);
  const language = text(args, "language", 8);
  const audio = await audioSource(ctx);
  const form = new FormData();
  form.set("model", model);
  form.set("file", new Blob([Buffer.from(audio.payload)], { type: audio.contentType }), audioFilename(audio.filename, audio.contentType));
  if (language) form.set("language", language);
  const body: JsonMap = { model, ...(language ? { language } : {}) };
  const aliases = modelChain(principal, model, {});
  const hit = await metered(
    principal,
    model,
    body,
    async () => {
      const raw = await forwardToModel(aliases, principal, "/audio/transcriptions", null, {
        rawBody: form,
        binary: true,
        signal: ctx.signal,
        timeoutMs: MEDIA_TOOL_TIMEOUT_MS,
      });
      const transcript = new TextDecoder().decode(raw.raw);
      return { ...raw, json: parseJsonOrNull(transcript), transcript };
    },
    undefined,
    (hit) => hit.json ?? hit.transcript,
  );
  const json = asRecord(hit.json);
  const transcript = typeof json?.text === "string" ? json.text : hit.transcript;
  return success({ text: transcript, ...(typeof json?.language === "string" ? { language: json.language } : {}) });
}

type MediaHandler = { kind: McpMediaKind; endpoint: string; run: (ctx: MediaContext) => Promise<McpToolOutcome> };

const HANDLERS: Record<string, MediaHandler> = {
  [GENERATE_IMAGE_TOOL]: { kind: "image", endpoint: "/api/v1/images/generations", run: generateImage },
  [TEXT_TO_SPEECH_TOOL]: { kind: "speech", endpoint: "/api/v1/audio/speech", run: textToSpeech },
  [GENERATE_VIDEO_TOOL]: { kind: "video", endpoint: "/api/v1/videos", run: generateVideo },
  [GET_VIDEO_TOOL]: { kind: "video", endpoint: "/api/v1/videos", run: getVideo },
  [TRANSCRIBE_AUDIO_TOOL]: { kind: "transcription", endpoint: "/api/v1/audio/transcriptions", run: transcribeAudio },
};

async function mediaPrincipal(caller: Principal, endpoint: string): Promise<Principal> {
  const principal: Principal = { ...withTrace(caller, endpoint), pool: "api" };
  allowEndpoint(principal, gatewayPath(endpoint));
  const maxCost = caller.trace?.costCap?.budget === null ? caller.trace.costCap.limit : null;
  capRequestCost(principal, await assertBudget(principal), maxCost);
  return principal;
}

export async function callMedia(
  spec: McpMediaSpec,
  tool: string,
  args: JsonMap,
  principal: Principal | null,
  fetchRemote: McpFetch = guardedFetch(false),
  signal: AbortSignal = AbortSignal.timeout(MEDIA_TOOL_TIMEOUT_MS),
): Promise<McpToolOutcome> {
  if (!principal) return failure("This tool needs a signed-in caller.");
  const handler = HANDLERS[tool];
  if (!handler || !spec[handler.kind].model) return failure(`Unknown tool ${tool}.`);
  try {
    if (signal.aborted) throw clientClosedError();
    return await handler.run({ spec, args, principal: await mediaPrincipal(principal, handler.endpoint), fetchRemote, signal });
  } catch (err) {
    if (err instanceof ToolInputError) return failure(err.message);
    if (isClientClosed(err) || (signal.aborted && !(err instanceof GateError))) return failure(`${tool} stopped because the request ended or ran out of time.`);
    if (err instanceof GateError) return failure(gateFailure(tool, handler.kind, spec[handler.kind].model, err));
    logger.warn("mcp.media_failed", { tool, ...errorFields(err) });
    return failure(`${tool} failed.`);
  }
}
