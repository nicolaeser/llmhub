import "server-only";

import prisma from "@/lib/db/prisma";
import { dispatchChat } from "@/lib/gateway/chat";
import { admit, withTrace } from "@/lib/gateway/gate";
import { sessionPrincipal } from "@/lib/gateway/principal";
import { getEnterprise } from "@/lib/gateway/settings";
import { getTranslations } from "next-intl/server";
import { asRecord } from "@/lib/gateway/core";
import { ASSISTANT_STEP_LIMIT_NOTE, assistantSystemPrompt } from "@/lib/assistant/prompt";
import { callMcpTool, mcpToolsForModel } from "@/lib/assistant/mcp";
import { setupStatus } from "@/lib/assistant/tools/general";
import {
  assistantAlias,
  completionText,
  parseToolArgs,
  parseToolCalls,
  redactSecrets,
} from "@/lib/assistant/parse";
import type {
  AssistantContext,
  AssistantEvent,
  AssistantMessage,
  AssistantToolCall,
  AssistantToolChoice,
} from "@/types/assistant";
import type { JsonMap } from "@/types/gateway";

const ASSISTANT_ENDPOINT = "/internal-api/assistant/chat";
const MAX_STEPS = 10;
const MAX_TOOL_CALLS_PER_STEP = 6;
const MAX_TOOL_RESULT_CHARS = 12_000;

class AssistantNoLlmError extends Error {
  constructor() {
    super("no_llm");
    this.name = "AssistantNoLlmError";
  }
}

function bounded<T>(value: T): T | { truncated: true; preview: string } {
  const serialized = JSON.stringify(value) ?? "null";
  if (serialized.length <= MAX_TOOL_RESULT_CHARS) return value;
  return {
    truncated: true,
    preview: serialized.slice(0, MAX_TOOL_RESULT_CHARS - 80),
  };
}

function toolFailed(result: unknown): boolean {
  return typeof asRecord(result)?.error === "string";
}

function redactHistory(message: AssistantMessage): AssistantMessage {
  return {
    ...message,
    content: redactSecrets(message.content),
    ...(message.toolCalls
      ? {
          toolCalls: message.toolCalls.map((call) => ({
            ...call,
            arguments: redactSecrets(call.arguments),
          })),
        }
      : {}),
  };
}

function toProviderMessages(messages: AssistantMessage[]): JsonMap[] {
  return messages.map((message) => {
    if (message.role === "tool") {
      return {
        role: "tool",
        tool_call_id: message.toolCallId ?? "",
        name: message.name ?? "",
        content: message.content,
      };
    }
    if (message.role === "assistant" && message.toolCalls?.length) {
      return {
        role: "assistant",
        content: message.content || null,
        tool_calls: message.toolCalls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: call.arguments },
        })),
      };
    }
    return { role: message.role, content: message.content };
  });
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

async function resolveAssistantAlias(requested: string): Promise<string | null> {
  const alias = assistantAlias(requested, await getEnterprise());
  if (!alias) return null;
  const match = await prisma.modelGroup.findUnique({ where: { alias }, select: { alias: true } });
  return match?.alias ?? null;
}

async function completeGateway(
  ctx: AssistantContext,
  messages: AssistantMessage[],
  tools: ReturnType<typeof mcpToolsForModel>,
  alias: string,
  toolChoice: AssistantToolChoice,
): Promise<{ content: string; toolCalls: AssistantToolCall[] }> {
  const principal = withTrace(
    await sessionPrincipal({ id: ctx.userId, teamId: ctx.teamId, orgId: ctx.orgId }),
    ASSISTANT_ENDPOINT,
  );
  await admit(principal);
  const dispatched = await dispatchChat({
    principal,
    model: alias,
    aliases: [alias],
    outputPii: null,
    body: {
      model: alias,
      messages: toProviderMessages(messages),
      tools,
      tool_choice: toolChoice,
      stream: false,
    },
  });
  return {
    content: completionText(dispatched.json),
    toolCalls: parseToolCalls(dispatched.json).slice(
      0,
      MAX_TOOL_CALLS_PER_STEP,
    ),
  };
}

async function completeChat(
  ctx: AssistantContext,
  messages: AssistantMessage[],
  requestedModel: string,
  toolChoice: AssistantToolChoice = "auto",
): Promise<{ content: string; toolCalls: AssistantToolCall[] }> {
  const alias = await resolveAssistantAlias(requestedModel);
  if (!alias) throw new AssistantNoLlmError();
  return completeGateway(ctx, messages, mcpToolsForModel(ctx), alias, toolChoice);
}

export async function* runAssistant(opts: {
  history: AssistantMessage[];
  ctx: AssistantContext;
  model?: string;
  signal?: AbortSignal;
}): AsyncGenerator<AssistantEvent> {
  const setup = await setupStatus(opts.ctx);
  const now = `${new Date().toISOString().slice(0, 16)}Z`;
  const system = `${assistantSystemPrompt(opts.ctx.locale, opts.ctx.allowWrite)}\n\n## Live snapshot\nCurrent time (UTC): ${now}\n${JSON.stringify(setup)}`;
  const messages: AssistantMessage[] = [
    { role: "system", content: system },
    ...opts.history
      .filter((message) => message.role !== "system")
      .map(redactHistory),
  ];

  try {
    let answered = false;
    for (let step = 0; step < MAX_STEPS; step += 1) {
      if (opts.signal?.aborted) break;
      const turn = await completeChat(opts.ctx, messages, opts.model ?? "");
      if (turn.content) {
        yield { type: "text", delta: turn.content };
      }
      messages.push({
        role: "assistant",
        content: turn.content,
        toolCalls: turn.toolCalls.length ? turn.toolCalls : undefined,
      });
      if (turn.toolCalls.length === 0) {
        answered = true;
        break;
      }

      for (const [index, call] of turn.toolCalls.entries()) {
        const id = `${step}-${index}`;
        const args = parseToolArgs(call.arguments);
        yield { type: "tool_call", id, name: call.name, args: bounded(args) };
        const executed = await callMcpTool(call.name, args, opts.ctx);
        const result = bounded(executed.result);
        yield {
          type: "tool_result",
          id,
          name: call.name,
          status: toolFailed(executed.result) ? "error" : "done",
          result,
          ...(executed.navigate ? { href: executed.navigate } : {}),
        };
        if (executed.secret) {
          yield { type: "secret", id, value: executed.secret };
        }
        messages.push({
          role: "tool",
          content: JSON.stringify(result) ?? "null",
          toolCallId: call.id,
          name: call.name,
        });
      }
    }
    if (!answered && !opts.signal?.aborted) {
      const wrapUp = await completeChat(
        opts.ctx,
        [
          { role: "system", content: `${system}\n\n${ASSISTANT_STEP_LIMIT_NOTE}` },
          ...messages.slice(1),
        ],
        opts.model ?? "",
        "none",
      );
      if (wrapUp.content) {
        yield { type: "text", delta: wrapUp.content };
      }
    }
    yield { type: "done" };
  } catch (err) {
    if (isAbortError(err) || opts.signal?.aborted) {
      yield { type: "done" };
      return;
    }
    if (err instanceof AssistantNoLlmError) {
      const t = await getTranslations({
        locale: opts.ctx.locale,
        namespace: "Assistant",
      });
      yield {
        type: "text",
        delta: t("noModelReply", {
          next: setup.next,
          providers: setup.providers,
          models: setup.models,
          keys: setup.keys,
          setupHelp: t("setupHelp"),
        }),
      };
      yield { type: "done" };
      return;
    }
    yield { type: "error", message: "llm_failed" };
    yield { type: "done" };
  }
}
