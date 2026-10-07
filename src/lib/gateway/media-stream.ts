import "server-only";
import { usageFromUnknown } from "@/lib/gateway/billing";
import { openUpstreamStream, withDeployment } from "@/lib/gateway/chat";
import { asRecord } from "@/lib/gateway/core";
import { meter } from "@/lib/gateway/meter";
import { relaySse } from "@/lib/gateway/sse";
import { prepareBody, withDeploymentModel } from "@/lib/gateway/upstream";
import type { JsonMap, Principal, ProxyFirstResult, Usage } from "@/types/gateway";

export function wantsStream(body: JsonMap): boolean {
  return body.stream === true || body.stream === "true";
}

export async function streamMedia(input: {
  req: Request;
  principal: Principal;
  model: string;
  aliases: string[];
  path: string;
  body: JsonMap;
  form?: FormData;
}): Promise<Response> {
  const usage = meter(input.principal, input.model, input.body);
  const routed = await withDeployment(
    input.aliases,
    input.principal.routeLimits,
    async (dep, group) => {
      const form = withDeploymentModel(input.form, dep.model);
      return openUpstreamStream({
        dep,
        group,
        req: input.req,
        path: input.path,
        payload: form ? {} : prepareBody(dep, input.path, { ...input.body, stream: true }, group.strategy),
        form: form instanceof FormData ? form : undefined,
      });
    },
    { deferRelease: true },
  ).catch(async (err) => {
    await usage.fail(err);
    throw err;
  });
  const { result, dep, group, alias, release } = routed;
  let reported: Partial<Usage> = {};
  let text = "";
  let last: JsonMap | null = null;
  return relaySse(result, {
    map: (json) => {
      if (asRecord(json.usage)) reported = usageFromUnknown(json.usage, json);
      if (typeof json.delta === "string") text += json.delta;
      else if (typeof json.text === "string") text = json.text;
      last = json;
      return json;
    },
    onEnd: async () => {
      release();
      const hit: ProxyFirstResult = {
        status: 200,
        json: null,
        raw: new Uint8Array(),
        contentType: "text/event-stream",
        depId: dep.id,
        alias,
        dep,
        group,
      };
      await usage.ok(hit, reported, text ? { text } : last);
    },
  });
}
