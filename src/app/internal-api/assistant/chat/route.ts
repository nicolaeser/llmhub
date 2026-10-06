import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { hasPerm, PERMISSIONS } from "@/lib/auth/permissions";
import { isSameOriginRequest } from "@/lib/auth/request-origin";
import { env } from "@/lib/env";
import { readJSON } from "@/lib/http/api";
import { problemResponse } from "@/lib/http/problem";
import { asRecord, asString } from "@/lib/gateway/core";
import {
  parseAssistantLocale,
  parseAssistantModel,
  parseAssistantWrite,
  parseClientMessages,
} from "@/lib/assistant/parse";
import { runAssistant } from "@/lib/assistant/run";
import { disabledAssistantTools } from "@/lib/assistant/access";
import type { AssistantMessage } from "@/types/assistant";
import type { JsonMap } from "@/types/gateway";

export const maxDuration = 300;

function historyFromBody(body: JsonMap): AssistantMessage[] {
  const rec = asRecord(body) ?? {};
  const messages = parseClientMessages(rec.messages);
  const extra = asString(rec.message).trim();
  if (!extra) return messages;
  const last = messages.at(-1);
  if (last?.role === "user" && last.content === extra) return messages;
  return [...messages, { role: "user", content: extra.slice(0, 8000) }];
}

export async function POST(req: Request) {
  if (!isSameOriginRequest(req.headers, env.NEXT_PUBLIC_APP_URL)) {
    return problemResponse(req, "FORBIDDEN", { detail: "cross-site request rejected" });
  }
  const session = await getSession();
  if (session.error) return problemResponse(req, "UNAUTHORIZED");
  if (!hasPerm(session.permissions, PERMISSIONS.ASSISTANT_USE)) {
    return problemResponse(req, "FORBIDDEN");
  }

  let body: JsonMap;
  try {
    body = await readJSON<JsonMap>(req);
  } catch (err) {
    if ((err as { status?: number }).status === 413) return problemResponse(req, "PAYLOAD_TOO_LARGE");
    return problemResponse(req, "INVALID_JSON");
  }

  const history = historyFromBody(body);
  if (!history.length || history.at(-1)?.role !== "user") {
    return problemResponse(req, "VALIDATION", {
      detail: "the last message must come from the user",
      errors: [{ pointer: "#/messages", detail: "the last message must come from the user" }],
    });
  }

  const disabledTools = await disabledAssistantTools(session);
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (obj: unknown) => {
        try {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(obj)}\n\n`),
          );
        } catch {}
      };
      try {
        for await (const event of runAssistant({
          history,
          model: parseAssistantModel(body.model),
          signal: req.signal,
          ctx: {
            userId: session.user.id,
            permissions: session.permissions,
            disabledTools,
            orgId: session.user.orgId,
            locale: parseAssistantLocale(body.locale),
            allowWrite: parseAssistantWrite(body.write),
          },
        })) {
          if (req.signal.aborted) break;
          send(event);
        }
      } catch {
        send({ type: "error", message: "llm_failed" });
      } finally {
        try {
          controller.close();
        } catch {}
      }
    },
  });

  return new NextResponse(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
