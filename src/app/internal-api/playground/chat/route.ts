import { getSession } from "@/lib/auth/session";
import { hasPerm, PERMISSIONS } from "@/lib/auth/permissions";
import { isSameOriginRequest } from "@/lib/auth/request-origin";
import { env } from "@/lib/env";
import { readJSON } from "@/lib/http/api";
import { problemFromError, problemResponse } from "@/lib/http/problem";
import { streamChat } from "@/lib/gateway/chat";
import {
  admit,
  allowModel,
  applyPii,
  modelChain,
  modelOf,
  requestPath,
  withTrace,
} from "@/lib/gateway/gate";
import { sessionPrincipal } from "@/lib/gateway/principal";
import type { JsonMap } from "@/types/gateway";

export const maxDuration = 300;

export async function POST(req: Request) {
  if (!isSameOriginRequest(req.headers, env.NEXT_PUBLIC_APP_URL)) {
    return problemResponse(req, "FORBIDDEN", { detail: "cross-site request rejected" });
  }
  const session = await getSession();
  if (session.error) return problemResponse(req, "UNAUTHORIZED");
  if (!hasPerm(session.permissions, PERMISSIONS.PLAYGROUND_USE)) {
    return problemResponse(req, "FORBIDDEN");
  }
  try {
    const body = await readJSON<JsonMap>(req);
    const model = modelOf(body);
    const principal = withTrace(sessionPrincipal(session.user), requestPath(req));
    allowModel(principal, model);
    await admit(principal);
    const { body: clean, output } = await applyPii(body, principal);
    return await streamChat({
      req,
      principal,
      model,
      body: { ...clean, stream: true },
      aliases: modelChain(principal, model, clean),
      outputPii: output,
    });
  } catch (err) {
    return problemFromError(req, err);
  }
}
