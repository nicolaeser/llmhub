import { NextResponse } from "next/server";
import { dispatchChat, streamChat } from "@/lib/gateway/chat";
import {
  allowModel,
  applyGuardrails,
  gateRequest,
  gateResponse,
  modelOf,
  readBody,
  modelChain,
} from "@/lib/gateway/gate";
import { GateError } from "@/lib/gateway/errors";
import { listObjects, payloadJson, putObject, updateObjectPayload } from "@/lib/gateway/objects";
import { previousConversation } from "@/lib/gateway/responses-store";
import { resolveResponsesFiles } from "@/lib/gateway/file-refs";
import {
  chatToResponse,
  inputItems,
  parseRequest,
  pipeChatStream,
  responseId,
  responseMessages,
  responseSkeleton,
  ResponsesStreamEncoder,
  responsesToChat,
  storedResponse,
  visibleResponse,
} from "@/lib/gateway/responses";
import { newId, ownerId } from "@/lib/gateway/core";
import { responsesRequestSchema } from "@/schemas/responses";
import type { JsonMap } from "@/types/gateway";

export const maxDuration = 300;

function storedPayload(response: JsonMap, messages: JsonMap[], input: JsonMap[]): Buffer {
  return Buffer.from(JSON.stringify({ response, messages, input }));
}

export async function GET(req: Request) {
  try {
    const principal = await gateRequest(req);
    const owner = ownerId(principal);
    const items = await listObjects("response", owner);
    return NextResponse.json({
      object: "list",
      data: items.map((item) => visibleResponse(storedResponse(item.id, payloadJson(item)).response, null)),
    });
  } catch (err) {
    return gateResponse(err, req);
  }
}

export async function POST(req: Request) {
  try {
    const principal = await gateRequest(req);
    const body = await readBody(req);
    const model = modelOf(body);
    allowModel(principal, model);
    const { body: redacted, output } = await applyGuardrails(body, principal);
    const clean = await resolveResponsesFiles(redacted, principal);
    const parsed = parseRequest(responsesRequestSchema, clean);
    if (!parsed.ok) {
      throw new GateError(400, "invalid_request", parsed.message, { param: parsed.param });
    }
    const request = parsed.data;
    const owner = ownerId(principal);
    const history = request.previous_response_id
      ? await previousConversation(request.previous_response_id, principal)
      : [];
    const { body: chatBody, conversation } = responsesToChat(request, history);
    const aliases = modelChain(principal, model, clean);
    const store = request.store !== false;
    const createdAt = Math.floor(Date.now() / 1000);
    const items = inputItems(request.input);

    if (request.stream === true) {
      const streamed = await streamChat({
        req,
        principal,
        model,
        body: chatBody,
        aliases,
        outputGuard: output,
      });
      let id = responseId(newId());
      let storedId = "";
      if (store) {
        try {
          const stored = await putObject({
            kind: "response",
            owner,
            contentType: "application/json",
            payload: storedPayload(responseSkeleton(request, "", createdAt), conversation, items),
            meta: { model },
          });
          storedId = stored.id;
          id = responseId(stored.id);
        } catch (err) {
          await streamed.body?.cancel().catch(() => undefined);
          throw err;
        }
      }
      const encoder = new ResponsesStreamEncoder(responseSkeleton(request, id, createdAt), request.include ?? null);
      return pipeChatStream(streamed, encoder, async () => {
        if (!storedId) return;
        const response = encoder.result();
        await updateObjectPayload(
          storedId,
          storedPayload(response, [...conversation, ...responseMessages(response)], items),
          { model },
        );
      });
    }

    const dispatched = await dispatchChat({
      principal,
      model,
      body: chatBody,
      aliases,
      outputGuard: output,
    });
    const response = chatToResponse(dispatched.json, responseSkeleton(request, "", createdAt));
    const include = request.include ?? null;
    if (!store) return NextResponse.json(visibleResponse({ ...response, id: responseId(newId()) }, include));
    const stored = await putObject({
      kind: "response",
      owner,
      contentType: "application/json",
      payload: storedPayload(response, [...conversation, ...responseMessages(response)], items),
      meta: { model },
    });
    return NextResponse.json(visibleResponse({ ...response, id: responseId(stored.id) }, include));
  } catch (err) {
    return gateResponse(err, req);
  }
}
