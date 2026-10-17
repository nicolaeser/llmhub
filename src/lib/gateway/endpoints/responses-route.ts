import "server-only";
import { NextResponse } from "next/server";
import { dispatchChat, streamChat } from "@/lib/gateway/dispatch/chat";
import { modelChain } from "@/lib/gateway/access/gate";
import { gatewayRoute, screenModelRequest, validRequest } from "@/lib/gateway/endpoints/pipeline";
import { putObject, updateObjectPayload } from "@/lib/gateway/storage/objects";
import { previousConversation } from "@/lib/gateway/storage/responses-store";
import { resolveResponsesFiles } from "@/lib/gateway/storage/file-refs";
import {
  chatToResponse,
  inputItems,
  responseId,
  responseMessages,
  responseSkeleton,
  responsesToChat,
  visibleResponse,
} from "@/lib/gateway/protocols/responses";
import { pipeChatStream } from "@/lib/gateway/protocols/chat-stream";
import { restoreClientJson, restoreClientStream } from "@/lib/gateway/safety/restore-client";
import { ResponsesStreamEncoder } from "@/lib/gateway/protocols/responses-stream";
import { clientTools, withToolNamespaces } from "@/lib/gateway/protocols/responses-tools";
import { newId, ownerId } from "@/lib/gateway/core";
import { cancelQuietly } from "@/lib/utils/streams";
import {
  fileSearchStores,
  runFileSearch,
  streamFileSearch,
  takeFileSearchTool,
  withFileSearch,
  withoutFileSearchHistory,
} from "@/lib/rag/file-search-tool";
import { maxCostHeader } from "@/lib/gateway/billing/cost-cap";
import { runMcpChat, streamMcpChat, withMcpTools, withoutMcpHistory } from "@/lib/mcp/chat-loop";
import { mcpResponse, responsesSink } from "@/lib/mcp/responses";
import { mcpToolsetFor } from "@/lib/mcp/toolset";
import { responsesRequestSchema } from "@/schemas/responses";
import type { JsonMap, ScreenedRequest } from "@/types/gateway";
import type { RoutePool } from "@/types/routing";
import type { FileSearchContext } from "@/types/rag";

function storedPayload(response: JsonMap, messages: JsonMap[], input: JsonMap[]): Buffer {
  return Buffer.from(JSON.stringify({ response, messages, input }));
}

export function createResponseRoute(pool: RoutePool) {
  return gatewayRoute(async (req) => {
    const screened = await screenModelRequest(req, { pool });
    const files = await resolveResponsesFiles(screened.clean, screened.principal);
    const { body: clean, namespaces } = clientTools(files);
    return withToolNamespaces(await respond(req, screened, clean), namespaces);
  });
}

async function respond(req: Request, { principal, model, output }: ScreenedRequest, clean: JsonMap): Promise<Response> {
  const { body: requestBody, tool: searchTool } = takeFileSearchTool(clean);
  const request = validRequest(responsesRequestSchema, requestBody);
  const owner = ownerId(principal);
  const history = request.previous_response_id
    ? await previousConversation(request.previous_response_id, principal)
    : [];
  const callerTools = (request.tools ?? []).map((tool) => tool.name);
  const toolset = searchTool ? null : await mcpToolsetFor(req, principal, callerTools);
  const kept = new Set([...callerTools, ...(toolset?.tools.map((tool) => tool.name) ?? [])]);
  const { body: baseChat, conversation } = responsesToChat(
    request,
    withoutMcpHistory(searchTool ? history : withoutFileSearchHistory(history), kept),
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
  const chatBody = search
    ? withFileSearch(baseChat, clean.tool_choice, request.parallel_tool_calls)
    : toolset
      ? withMcpTools(baseChat, toolset)
      : baseChat;
  const mcp = toolset
    ? { principal, model, aliases, outputGuard: output, toolset, maxCost: maxCostHeader(req.headers), signal: req.signal }
    : null;

  if (mcp && request.stream === true) {
    return streamMcpChat({
      req,
      ctx: mcp,
      body: chatBody,
      sink: async () => {
        let id = responseId(newId());
        let storedId = "";
        if (store) {
          const stored = await putObject({
            kind: "response",
            owner,
            contentType: "application/json",
            payload: storedPayload(responseSkeleton(request, "", createdAt), conversation, items),
            meta: { model },
          });
          storedId = stored.id;
          id = responseId(stored.id);
        }
        const encoder = new ResponsesStreamEncoder(responseSkeleton(request, id, createdAt), request.include ?? null);
        return responsesSink(encoder, async (transcript) => {
          if (!storedId) return;
          await updateObjectPayload(
            storedId,
            storedPayload(encoder.result(), [...conversation, ...transcript], items),
            { model },
          );
        });
      },
    });
  }

  if (mcp) {
    const run = await runMcpChat(mcp, chatBody);
    const response = mcpResponse(run, responseSkeleton(request, "", createdAt));
    const include = request.include ?? null;
    if (!store) return NextResponse.json(restoreClientJson(principal.trace, visibleResponse({ ...response, id: responseId(newId()) }, include)));
    const stored = await putObject({
      kind: "response",
      owner,
      contentType: "application/json",
      payload: storedPayload(response, [...conversation, ...run.transcript], items),
      meta: { model },
    });
    return NextResponse.json(restoreClientJson(principal.trace, visibleResponse({ ...response, id: responseId(stored.id) }, include)));
  }

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
    if (!store) return NextResponse.json(restoreClientJson(principal.trace, visibleResponse({ ...response, id: responseId(newId()) }, include)));
    const stored = await putObject({
      kind: "response",
      owner,
      contentType: "application/json",
      payload: storedPayload(response, [...conversation, ...run.transcript], items),
      meta: { model },
    });
    return NextResponse.json(restoreClientJson(principal.trace, visibleResponse({ ...response, id: responseId(stored.id) }, include)));
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
        await cancelQuietly(streamed.body);
        throw err;
      }
    }
    const encoder = new ResponsesStreamEncoder(responseSkeleton(request, id, createdAt), request.include ?? null);
    return restoreClientStream(principal.trace, pipeChatStream(streamed, encoder, async () => {
      if (!storedId) return;
      const response = encoder.result();
      await updateObjectPayload(
        storedId,
        storedPayload(response, [...conversation, ...responseMessages(response)], items),
        { model },
      );
    }));
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
  if (!store) return NextResponse.json(restoreClientJson(principal.trace, visibleResponse({ ...response, id: responseId(newId()) }, include)));
  const stored = await putObject({
    kind: "response",
    owner,
    contentType: "application/json",
    payload: storedPayload(response, [...conversation, ...responseMessages(response)], items),
    meta: { model },
  });
  return NextResponse.json(restoreClientJson(principal.trace, visibleResponse({ ...response, id: responseId(stored.id) }, include)));
}
