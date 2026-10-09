import "server-only";
import { NextResponse } from "next/server";
import { recordUsage } from "@/lib/gateway/billing";
import { cacheBypassed, cacheGet, cacheKey, cachePut } from "@/lib/gateway/cache";
import { dispatchChat, streamChat } from "@/lib/gateway/chat";
import { resolveChatFiles } from "@/lib/gateway/file-refs";
import {
  allowModel,
  applyGuardrails,
  gateRequest,
  gateResponse,
  modelOf,
  readBody,
  modelChain,
} from "@/lib/gateway/gate";
import { loadSettings } from "@/lib/gateway/settings";
import { ownerId } from "@/lib/gateway/core";
import { bytesBody } from "@/lib/http/api";
import type { RoutePool } from "@/types/gateway";

export function chatCompletionsRoute(pool: RoutePool) {
  return async (req: Request): Promise<Response> => {
    try {
      const principal = await gateRequest(req, pool);
      const body = await readBody(req);
      const model = modelOf(body);
      allowModel(principal, model);
      const { body: redacted, output } = await applyGuardrails(body, principal);
      const clean = await resolveChatFiles(redacted, principal);
      const aliases = modelChain(principal, model, clean);
      const settings = await loadSettings();
      const raw = JSON.stringify(clean);
      if (clean.stream === true) {
        return streamChat({
          req,
          principal,
          model,
          body: clean,
          aliases,
          outputGuard: output,
        });
      }
      if (!cacheBypassed(req.headers, clean) && settings.cacheTtlSeconds > 0) {
        const key = cacheKey(pool, ownerId(principal), model, raw);
        const hit = cacheGet(key);
        if (hit) {
          let cached: unknown = null;
          try {
            cached = JSON.parse(new TextDecoder().decode(hit));
          } catch {}
          await recordUsage({
            principal,
            model,
            status: 200,
            outcome: "cache_hit",
            latencyMs: 0,
            response: cached ?? undefined,
          });
          if (cached !== null) {
            return NextResponse.json(cached, {
              headers: { "X-Hub-Cache": "HIT" },
            });
          }
          return new NextResponse(bytesBody(hit), {
            headers: { "Content-Type": "application/json", "X-Hub-Cache": "HIT" },
          });
        }
      }
      const dispatched = await dispatchChat({
        principal,
        model,
        body: clean,
        aliases,
        outputGuard: output,
      });
      if (!cacheBypassed(req.headers, clean) && settings.cacheTtlSeconds > 0) {
        cachePut(
          cacheKey(pool, ownerId(principal), model, raw),
          Buffer.from(JSON.stringify(dispatched.json)),
          settings.cacheTtlSeconds,
        );
      }
      return NextResponse.json(dispatched.json, {
        headers: { "X-Hub-Cache": "MISS" },
      });
    } catch (err) {
      return gateResponse(err, req);
    }
  };
}
