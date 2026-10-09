import "server-only";
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
import { putObject, updateObjectPayload } from "@/lib/gateway/objects";
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
  visibleResponse,
} from "@/lib/gateway/responses";
import { newId, ownerId } from "@/lib/gateway/core";
import {
  fileSearchStores,
  runFileSearch,
  streamFileSearch,
  takeFileSearchTool,
  withFileSearch,
  withoutFileSearchHistory,
} from "@/lib/rag/file-search-tool";
import { responsesRequestSchema } from "@/schemas/responses";
import type { JsonMap, RoutePool } from "@/types/gateway";
import type { FileSearchContext } from "@/types/rag";

function storedPayload(response: JsonMap, messages: JsonMap[], input: JsonMap[]): Buffer {
  return Buffer.from(JSON.stringify({ response, messages, input }));
}

export function createResponseRoute(pool: RoutePool) {
  return async (req: Request): Promise<Response> => {
    try {
      const principal = await gateRequest(req, pool);
      const body = await readBody(req);
      const model = modelOf(body);
      allowModel(principal, model);
      const { body: redacted, output } = await applyGuardrails(body, principal);
      const clean = await resolveResponsesFiles(redacted, principal);
      const { body: requestBody, tool: searchTool } = takeFileSearchTool(clean);
      const parsed = parseRequest(responsesRequestSchema, requestBody);
      if (!parsed.ok) {
        throw new GateError(400, "invalid_request", parsed.message, { param: parsed.param });
      }
      const request = parsed.data;
      const owner = ownerId(principal);
      const history = request.previous_response_id
        ? await previousConversation(request.previous_response_id, principal)
        : [];
      const { body: baseChat, conversation } = responsesToChat(
        request,
        searchTool ? history : withoutFileSearchHistory(history),
      );
      const aliases = modelChain(principal, model, clean);
      const store = request.store !== false;
      const createdAt = Math.floor(Date.now() / 1000);
      const items = inputItems(request.input);
      const skeleton = (id: string): JsonMap => {
        const base = responseSkeleton(request, id, createdAt);
        return searchTool ? { ...base, tools: clean.tools, tool_choice: clean.tool_choice ?? "auto" } : base;
      };
      const search: FileSearchContext | null = searchTool
        ? {
            principal,
            model,
            aliases,
            outputGuard: output,
            tool: searchTool,
            stores: await fileSearchStores(principal, searchTool),
            include: request.include ?? null,
          }
        : null;
      const chatBody = search ? withFileSearch(baseChat, clean.tool_choice, request.parallel_tool_calls) : baseChat;

      if (request.stream === true && search) {
        return streamFileSearch({
          req,
          ctx: search,
          body: chatBody,
          prepare: async () => {
            let id = responseId(newId());
            let storedId = "";
            if (store) {
              const stored = await putObject({
                kind: "response",
                owner,
                contentType: "application/json",
                payload: storedPayload(skeleton(""), conversation, items),
                meta: { model },
              });
              storedId = stored.id;
              id = responseId(stored.id);
            }
            const encoder = new ResponsesStreamEncoder(skeleton(id), request.include ?? null);
            return {
              encoder,
              onDone: async (transcript) => {
                if (!storedId) return;
                await updateObjectPayload(
                  storedId,
                  storedPayload(encoder.result(), [...conversation, ...transcript], items),
                  { model },
                );
              },
            };
          },
        });
      }

      if (search) {
        const run = await runFileSearch(search, chatBody);
        const answered = chatToResponse(run.final, skeleton(""));
        const response = { ...answered, output: [...run.items, ...(answered.output as JsonMap[])] };
        const include = request.include ?? null;
        if (!store) return NextResponse.json(visibleResponse({ ...response, id: responseId(newId()) }, include));
        const stored = await putObject({
          kind: "response",
          owner,
          contentType: "application/json",
          payload: storedPayload(response, [...conversation, ...run.transcript], items),
          meta: { model },
        });
        return NextResponse.json(visibleResponse({ ...response, id: responseId(stored.id) }, include));
      }

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
  };
}
