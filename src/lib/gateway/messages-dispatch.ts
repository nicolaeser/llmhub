import "server-only";
import { chatUsageFromAnthropic, nativeMessagesBody } from "@/lib/gateway/anthropic";
import { recordUsage, usageFromUnknown } from "@/lib/gateway/billing";
import {
  chatOnce,
  deploymentKey,
  openChatStream,
  openUpstreamStream,
  recordFailure,
  redactChatJson,
  relayChatStream,
  UPSTREAM_TIMEOUT_MS,
  withDeployment,
} from "@/lib/gateway/chat";
import { asRecord } from "@/lib/gateway/core";
import { costFilter } from "@/lib/gateway/cost-cap";
import { spendTag } from "@/lib/gateway/gate";
import { GateError } from "@/lib/gateway/errors";
import { chatIncompatibility, chatToMessage, messagesToChat, MessagesStreamEncoder } from "@/lib/gateway/messages";
import { MessagesStreamTranscript } from "@/lib/gateway/log-content";
import { redactPii } from "@/lib/gateway/pii";
import { pipeChatStream } from "@/lib/gateway/responses";
import { requestRoutingOverride } from "@/lib/gateway/service-mode";
import { relaySse } from "@/lib/gateway/sse";
import { estimateTokens, requestText } from "@/lib/gateway/tokens";
import { prepareBody, proxyJson, upstreamError } from "@/lib/gateway/upstream";
import type { MessagesRequest } from "@/types/anthropic";
import type { JsonMap, Principal, Usage } from "@/types/gateway";

const NATIVE_PATH = "/v1/messages";

type MessagesInput = {
  principal: Principal;
  model: string;
  body: JsonMap;
  request: MessagesRequest;
  aliases: string[];
  outputPii: string[] | null;
  headers: Record<string, string>;
};

function chatFallback(request: MessagesRequest): () => JsonMap {
  let converted: JsonMap | null = null;
  return () => {
    if (converted) return converted;
    const issue = chatIncompatibility(request);
    if (issue) throw new GateError(400, "unsupported_parameter", issue);
    converted = messagesToChat(request);
    return converted;
  };
}

function redactBlock(block: JsonMap, entities: string[], found?: Set<string>): void {
  if (block.type === "text" && typeof block.text === "string") block.text = redactPii(block.text, entities, found);
}

export function redactMessage(message: JsonMap, entities: string[] | null, found?: Set<string>): JsonMap {
  if (!entities) return message;
  const content = Array.isArray(message.content) ? message.content : [];
  for (const raw of content) {
    const block = asRecord(raw);
    if (block) redactBlock(block, entities, found);
  }
  return message;
}

export function redactMessageEvent(event: JsonMap, entities: string[] | null, found?: Set<string>): JsonMap {
  if (!entities) return event;
  const delta = asRecord(event.delta);
  if (delta?.type === "text_delta" && typeof delta.text === "string") {
    delta.text = redactPii(delta.text, entities, found);
  }
  const block = asRecord(event.content_block);
  if (block) redactBlock(block, entities, found);
  return event;
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
  const fallback = chatFallback(input.request);
  const routed = await withDeployment(
    input.aliases,
    input.principal.routeLimits,
    async (dep, group) => {
      if (dep.kind !== "anthropic") {
        return { native: false, json: asRecord(await chatOnce(dep, group, fallback(), input.model)) ?? {} };
      }
      const proxied = await proxyJson({
        dep,
        apiKey: deploymentKey(dep),
        path: NATIVE_PATH,
        body: { ...nativeMessagesBody(input.body), model: dep.model || input.model, stream: false },
        timeoutMs: UPSTREAM_TIMEOUT_MS,
        groupStrategy: group.strategy,
        headers: input.headers,
      });
      if (proxied.status >= 400) throw upstreamError(proxied.status, proxied.json);
      return { native: true, json: asRecord(proxied.json) ?? {} };
    },
    { strategy: requestRoutingOverride(input.body), cost: costFilter(input.principal, input.body) },
  ).catch(async (err) => {
    await recordFailure(input, err, started);
    throw err;
  });
  const { result, dep, group } = routed;
  const entities = input.outputPii;
  const found = input.principal.trace?.piiOutput;
  let message: JsonMap;
  let usage: Partial<Usage>;
  if (result.native) {
    message = redactMessage({ ...result.json, model: input.model }, entities, found);
    usage = usageFromUnknown(chatUsageFromAnthropic(asRecord(result.json.usage)));
  } else {
    const chat = redactChatJson({ ...result.json }, entities, found);
    usage = usageFromUnknown(chat.usage, chat);
    message = chatToMessage(chat, input.model);
  }
  await recordUsage({
    principal: input.principal,
    model: input.model,
    deployment: dep,
    group,
    usage,
    status: 200,
    outcome: "ok",
    latencyMs: Date.now() - started,
    tag: spendTag(input.body),
    request: input.body,
    response: message,
  });
  return message;
}

export async function streamMessages(input: MessagesInput & { req: Request }): Promise<Response> {
  const started = Date.now();
  const fallback = chatFallback(input.request);
  const routed = await withDeployment(
    input.aliases,
    input.principal.routeLimits,
    async (dep, group) => {
      if (dep.kind !== "anthropic") {
        return {
          native: false,
          res: await openChatStream(dep, group, { req: input.req, model: input.model, body: fallback() }),
        };
      }
      const payload = prepareBody(
        dep,
        NATIVE_PATH,
        { ...nativeMessagesBody(input.body), model: dep.model || input.model, stream: true },
        group.strategy,
      );
      return {
        native: true,
        res: await openUpstreamStream({ dep, group, req: input.req, path: NATIVE_PATH, payload, headers: input.headers }),
      };
    },
    {
      deferRelease: true,
      strategy: requestRoutingOverride(input.body),
      cost: costFilter(input.principal, input.body),
    },
  ).catch(async (err) => {
    await recordFailure(input, err, started);
    throw err;
  });
  const { result, dep, group, release } = routed;
  const entities = input.outputPii;

  if (!result.native) {
    const chatBody = fallback();
    return pipeChatStream(
      relayChatStream({
        res: result.res,
        dep,
        group,
        release,
        principal: input.principal,
        model: input.model,
        body: chatBody,
        entities,
        started,
      }),
      new MessagesStreamEncoder(input.model, { inputTokens: estimateTokens(requestText(chatBody)) }),
    );
  }

  const usage: JsonMap = {};
  const found = input.principal.trace?.piiOutput;
  const transcript = new MessagesStreamTranscript();
  let streamed = "";
  return relaySse(result.res, {
    map: (json, event) => {
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
      const mapped = redactMessageEvent(json, entities, found);
      transcript.push(mapped, event);
      return mapped;
    },
    onEnd: async () => {
      release();
      const reported = usageFromUnknown(chatUsageFromAnthropic(usage));
      const prompt = estimateTokens(requestText(input.body));
      const completion = estimateTokens(streamed);
      await recordUsage({
        principal: input.principal,
        model: input.model,
        deployment: dep,
        group,
        usage:
          (reported.prompt_tokens ?? 0) + (reported.completion_tokens ?? 0) > 0
            ? reported
            : { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion },
        status: 200,
        outcome: "ok",
        latencyMs: Date.now() - started,
        tag: spendTag(input.body),
        stream: true,
        request: input.body,
        response: transcript.result(),
      });
    },
  });
}
