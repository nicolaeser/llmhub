import "server-only";
import { NextResponse } from "next/server";
import { recordUsage } from "@/lib/gateway/billing/billing";
import { cacheBypassed } from "@/lib/gateway/cache/response-cache";
import { cachedTokens, lookupChatCache, storeChatCache } from "@/lib/gateway/cache/chat-cache";
import { dispatchChat, screenChatOutput, streamChat } from "@/lib/gateway/dispatch/chat";
import { restoreClientJson, restoreClientStream } from "@/lib/gateway/safety/restore-client";
import { resolveChatFiles } from "@/lib/gateway/storage/file-refs";
import { modelChain, spendTag } from "@/lib/gateway/access/gate";
import { gatewayRoute, screenModelRequest } from "@/lib/gateway/endpoints/pipeline";
import { loadSettings } from "@/lib/settings/enterprise";
import { maxCostHeader } from "@/lib/gateway/billing/cost-cap";
import { asRecord } from "@/lib/gateway/core";
import { chatStreamSink, chatToolNames, runMcpChat, streamMcpChat, withMcpTools } from "@/lib/mcp/chat-loop";
import { mcpToolsetFor } from "@/lib/mcp/toolset";
import type { RoutePool } from "@/types/routing";

export function chatCompletionsRoute(pool: RoutePool) {
  return gatewayRoute(async (req) => {
    const { principal, model, clean: redacted, output } = await screenModelRequest(req, { pool });
    const clean = await resolveChatFiles(redacted, principal);
    const aliases = modelChain(principal, model, clean);
    const toolset = typeof clean.n === "number" && clean.n > 1 ? null : await mcpToolsetFor(req, principal, chatToolNames(clean));
    if (toolset) {
      const ctx = {
        principal,
        model,
        aliases,
        outputGuard: output,
        toolset,
        maxCost: maxCostHeader(req.headers),
        signal: req.signal,
      };
      const body = withMcpTools(clean, toolset);
      if (clean.stream === true) {
        const wantsUsage = asRecord(clean.stream_options)?.include_usage === true;
        return restoreClientStream(principal.trace, await streamMcpChat({ req, ctx, body, sink: async () => chatStreamSink(wantsUsage) }));
      }
      const run = await runMcpChat(ctx, body);
      return NextResponse.json(restoreClientJson(principal.trace, run.final), { headers: { "X-Hub-Cache": "BYPASS" } });
    }
    const settings = await loadSettings();
    if (clean.stream === true) {
      return restoreClientStream(
        principal.trace,
        await streamChat({
          req,
          principal,
          model,
          body: clean,
          aliases,
          outputGuard: output,
        }),
      );
    }
    const started = Date.now();
    const lookup =
      !cacheBypassed(req.headers, clean) && settings.cacheTtlSeconds > 0
        ? await lookupChatCache({
            pool,
            principal,
            model,
            body: clean,
            ttlSeconds: settings.cacheTtlSeconds,
            semantic: settings.semanticCache,
          })
        : null;
    if (lookup?.hit) {
      const { entry, similarity } = lookup.hit;
      const response = structuredClone(entry.response);
      const blocked = screenChatOutput(response, output, principal.trace);
      await recordUsage({
        principal,
        model,
        status: 200,
        outcome: blocked ? "guardrail_blocked" : "cache_hit",
        latencyMs: Date.now() - started,
        tag: spendTag(clean),
        response,
        responseCache: {
          event: similarity === null ? "hit" : "semantic_hit",
          savedTokens: entry.tokens,
          savedCost: entry.cost,
        },
      });
      return NextResponse.json(restoreClientJson(principal.trace, response), {
        headers: {
          "X-Hub-Cache": "HIT",
          ...(similarity === null ? {} : { "X-Hub-Cache-Similarity": similarity.toFixed(4) }),
        },
      });
    }
    const dispatched = await dispatchChat({
      principal,
      model,
      body: clean,
      aliases,
      outputGuard: output,
      responseCache: lookup ? { event: "miss" } : undefined,
    });
    if (lookup && !principal.trace?.guardBlocked) {
      await storeChatCache(lookup.slot, {
        response: dispatched.json,
        cost: dispatched.cost,
        tokens: cachedTokens(dispatched.usage),
      });
    }
    return NextResponse.json(restoreClientJson(principal.trace, dispatched.json), {
      headers: { "X-Hub-Cache": "MISS" },
    });
  });
}
