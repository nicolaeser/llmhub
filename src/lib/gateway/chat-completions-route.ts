import "server-only";
import { NextResponse } from "next/server";
import { recordUsage } from "@/lib/gateway/billing";
import { cacheBypassed } from "@/lib/gateway/cache";
import { cachedTokens, lookupChatCache, storeChatCache } from "@/lib/gateway/chat-cache";
import { dispatchChat, streamChat } from "@/lib/gateway/chat";
import { resolveChatFiles } from "@/lib/gateway/file-refs";
import {
  allowModel,
  applyPii,
  gateRequest,
  gateResponse,
  modelOf,
  readBody,
  modelChain,
  spendTag,
} from "@/lib/gateway/gate";
import { loadSettings } from "@/lib/gateway/settings";
import type { RoutePool } from "@/types/gateway";

export function chatCompletionsRoute(pool: RoutePool) {
  return async (req: Request): Promise<Response> => {
    try {
      const principal = await gateRequest(req, pool);
      const body = await readBody(req);
      const model = modelOf(body);
      allowModel(principal, model);
      const { body: redacted, output } = await applyPii(body, principal);
      const clean = await resolveChatFiles(redacted, principal);
      const aliases = modelChain(principal, model, clean);
      const settings = await loadSettings();
      if (clean.stream === true) {
        return streamChat({
          req,
          principal,
          model,
          body: clean,
          aliases,
          outputPii: output,
        });
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
        await recordUsage({
          principal,
          model,
          status: 200,
          outcome: "cache_hit",
          latencyMs: Date.now() - started,
          tag: spendTag(clean),
          response: entry.response,
          responseCache: {
            event: similarity === null ? "hit" : "semantic_hit",
            savedTokens: entry.tokens,
            savedCost: entry.cost,
          },
        });
        return NextResponse.json(entry.response, {
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
        outputPii: output,
        responseCache: lookup ? { event: "miss" } : undefined,
      });
      if (lookup) {
        await storeChatCache(lookup.slot, {
          response: dispatched.json,
          cost: dispatched.cost,
          tokens: cachedTokens(dispatched.usage),
        });
      }
      return NextResponse.json(dispatched.json, {
        headers: { "X-Hub-Cache": "MISS" },
      });
    } catch (err) {
      return gateResponse(err, req);
    }
  };
}
