import "server-only";
import { chatUsageFromAnthropic, nativeMessagesBody } from "@/lib/gateway/protocols/anthropic";
import { usageFromUnknown } from "@/lib/gateway/billing/billing";
import {
  chatOnce,
  openChatStream,
  openUpstreamStream,
  recordFailure,
  recordSuccess,
  relayChatStream,
  routeMetered,
  screenChatJson,
  withholdChatJson,
  UPSTREAM_TIMEOUT_MS,
} from "@/lib/gateway/dispatch/chat";
import { servesMessages, speaksMuse } from "@/lib/gateway/upstreams/provider-kinds";
import { asRecord } from "@/lib/gateway/core";
import { plainModel } from "@/lib/gateway/catalog/model-alias";
import { deploymentAuth } from "@/lib/gateway/upstreams/credentials";
import { anthropicErrorBody, GateError } from "@/lib/gateway/errors";
import { chatIncompatibility, chatToMessage, messagesToChat, MessagesStreamEncoder } from "@/lib/gateway/protocols/messages";
import { MessagesStreamTranscript } from "@/lib/gateway/request-logs/log-content";
import { outputScreen, type OutputScreen } from "@/lib/gateway/safety/guardrails";
import { instructChat, instructMessages } from "@/lib/gateway/safety/pii-instruction";
import { pipeChatStream } from "@/lib/gateway/protocols/chat-stream";
import { relaySse, sseEvent } from "@/lib/gateway/protocols/sse";
import { estimateTokens, requestText } from "@/lib/gateway/billing/tokens";
import { prepareBody, proxyJson, upstreamError } from "@/lib/gateway/dispatch/upstream";
import type { MessagesRequest } from "@/types/anthropic";
import type { JsonMap, Principal } from "@/types/gateway";
import type { TokenUsage } from "@/types/billing";
import type { OutputGuard } from "@/types/guardrails";

const NATIVE_PATH = "/v1/messages";

type MessagesInput = {
  principal: Principal;
  model: string;
  body: JsonMap;
  request: MessagesRequest;
  aliases: string[];
  outputGuard: OutputGuard | null;
  headers: Record<string, string>;
};

function chatFallback(input: MessagesInput): (kind: string) => JsonMap {
  let converted: JsonMap | null = null;
  return (kind) => {
    const issue = chatIncompatibility(input.request, { webSearch: kind === "codex" || speaksMuse(kind) });
    if (issue) throw new GateError(400, "unsupported_parameter", issue);
    converted ??= instructChat(input.principal.trace, messagesToChat(input.request));
    return converted;
  };
}

function screenBlock(block: JsonMap, apply: (text: string) => string): void {
  if (block.type === "text" && typeof block.text === "string") block.text = apply(block.text);
}

export function screenMessage(message: JsonMap, screen: OutputScreen | null): JsonMap {
  if (!screen) return message;
  const content = Array.isArray(message.content) ? message.content : [];
  for (const raw of content) {
    const block = asRecord(raw);
    if (block) screenBlock(block, (text) => screen.text(text));
  }
  return message;
}

export function screenMessageEvent(event: JsonMap, screen: OutputScreen | null): JsonMap {
  if (!screen) return event;
  const delta = asRecord(event.delta);
  if (delta?.type === "text_delta" && typeof delta.text === "string") delta.text = screen.delta(delta.text);
  const block = asRecord(event.content_block);
  if (block) screenBlock(block, (text) => screen.delta(text));
  return event;
}

function streamEventError(json: JsonMap): GateError {
  const error = asRecord(json.error);
  const message = typeof error?.message === "string" && error.message ? error.message : "upstream stream error";
  return new GateError(502, "upstream_error", message);
}

export function mergeStreamUsage(target: JsonMap, usage: unknown): JsonMap {
  for (const [key, value] of Object.entries(asRecord(usage) ?? {})) {
    if (value === null || value === undefined) continue;
    if (typeof value === "number" && value === 0 && typeof target[key] === "number") continue;
    target[key] = value;
  }
  return target;
}

export async function dispatchMessages(input: MessagesInput): Promise<JsonMap> {
  const started = Date.now();
  const fallback = chatFallback(input);
  const routed = await routeMetered(input, started, async (dep, group) => {
    if (!servesMessages(dep.kind)) {
      return { native: false, json: asRecord(await chatOnce(dep, group, fallback(dep.kind), input.model)) ?? {} };
    }
    const proxied = await proxyJson({
      dep,
      auth: await deploymentAuth(dep),
      path: NATIVE_PATH,
      body: {
        ...nativeMessagesBody(instructMessages(input.principal.trace, input.body)),
        model: dep.model || plainModel(input.model),
        stream: false,
      },
      timeoutMs: UPSTREAM_TIMEOUT_MS,
      groupStrategy: group.strategy,
      headers: input.headers,
    });
    if (proxied.status >= 400) throw upstreamError(proxied.status, proxied.json, proxied.headers);
    return { native: true, json: asRecord(proxied.json) ?? {} };
  });
  const { result } = routed;
  const screen = outputScreen(input.outputGuard, input.principal.trace);
  let message: JsonMap;
  let usage: Partial<TokenUsage>;
  if (result.native) {
    message = screenMessage({ ...result.json, model: input.model }, screen);
    if (screen?.blocked) Object.assign(message, { content: [], stop_reason: "refusal", stop_sequence: null });
    usage = usageFromUnknown(chatUsageFromAnthropic(asRecord(result.json.usage)));
  } else {
    const chat = screenChatJson({ ...result.json }, screen);
    if (screen?.blocked) withholdChatJson(chat);
    usage = usageFromUnknown(chat.usage, chat);
    message = chatToMessage(chat, input.model);
    if (screen?.blocked) message.content = [];
  }
  await recordSuccess(input, routed, { usage, blocked: screen?.blocked ?? false, started, response: message });
  return message;
}

export async function streamMessages(input: MessagesInput & { req: Request }): Promise<Response> {
  const started = Date.now();
  const fallback = chatFallback(input);
  const routed = await routeMetered(
    input,
    started,
    async (dep, group) => {
      if (!servesMessages(dep.kind)) {
        return {
          native: false,
          res: await openChatStream(dep, group, { req: input.req, model: input.model, body: fallback(dep.kind) }),
        };
      }
      const payload = prepareBody(
        dep,
        NATIVE_PATH,
        {
          ...nativeMessagesBody(instructMessages(input.principal.trace, input.body)),
          model: dep.model || plainModel(input.model),
          stream: true,
        },
        group.strategy,
      );
      return {
        native: true,
        res: await openUpstreamStream({ dep, group, req: input.req, path: NATIVE_PATH, payload, headers: input.headers }),
      };
    },
    { deferRelease: true, signal: input.req.signal },
  );
  const { result, dep, group, release } = routed;

  if (!result.native) {
    const chatBody = fallback(dep.kind);
    return pipeChatStream(
      relayChatStream({
        res: result.res,
        dep,
        group,
        release,
        principal: input.principal,
        model: input.model,
        body: chatBody,
        outputGuard: input.outputGuard,
        started,
      }),
      new MessagesStreamEncoder(input.model, { inputTokens: estimateTokens(requestText(chatBody)) }),
    );
  }

  const usage: JsonMap = {};
  const screen = outputScreen(input.outputGuard, input.principal.trace);
  const transcript = new MessagesStreamTranscript();
  let streamed = "";
  let stopped = false;
  let upstreamFailure: GateError | null = null;
  const incomplete = (failure: unknown): GateError | null => {
    if (stopped && !upstreamFailure) return null;
    if (upstreamFailure) return upstreamFailure;
    if (failure instanceof GateError) return failure;
    return new GateError(502, "upstream_error", "upstream stream ended before message_stop");
  };
  return relaySse(result.res, {
    map: (json, event) => {
      if (event === "message_stop") stopped = true;
      if (event === "error") upstreamFailure = streamEventError(json);
      if (event === "message_start") {
        const message = asRecord(json.message);
        if (message) {
          message.model = input.model;
          mergeStreamUsage(usage, message.usage);
        }
      } else if (event === "message_delta") {
        mergeStreamUsage(usage, json.usage);
      } else if (event === "content_block_delta") {
        const delta = asRecord(json.delta);
        if (typeof delta?.text === "string") streamed += delta.text;
        if (typeof delta?.thinking === "string") streamed += delta.thinking;
        if (typeof delta?.partial_json === "string") streamed += delta.partial_json;
      }
      const mapped = screenMessageEvent(json, screen);
      if (screen?.blocked) {
        if (event === "content_block_start" || event === "content_block_delta") return null;
        const delta = asRecord(mapped.delta);
        if (event === "message_delta" && delta) Object.assign(delta, { stop_reason: "refusal", stop_sequence: null });
      }
      transcript.push(mapped, event);
      return mapped;
    },
    tail: (failure) => {
      const err = incomplete(failure);
      if (!err || err === upstreamFailure) return null;
      return sseEvent("error", anthropicErrorBody(err.status, err.message));
    },
    onEnd: async (failure, cancelled) => {
      release();
      const err = cancelled || input.req.signal?.aborted ? null : incomplete(failure);
      if (err) {
        await recordFailure(input, err, started);
        return;
      }
      const reported = usageFromUnknown(chatUsageFromAnthropic(usage));
      const prompt = estimateTokens(requestText(input.body));
      const completion = estimateTokens(streamed);
      await recordSuccess(input, routed, {
        usage:
          (reported.prompt_tokens ?? 0) + (reported.completion_tokens ?? 0) > 0
            ? reported
            : { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion },
        blocked: screen?.blocked ?? false,
        started,
        stream: true,
        response: transcript.result(),
      });
    },
  });
}
