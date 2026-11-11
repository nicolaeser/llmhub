import "server-only";
import { ANTIGRAVITY_BASE_URL, antigravityHeaders } from "@/lib/gateway/upstreams/antigravity";
import { asRecord } from "@/lib/gateway/core";
import { readJsonOr } from "@/lib/utils/json";
import type { UpstreamAuth } from "@/types/providers";

const MODELS_TIMEOUT_MS = 30_000;
const QUOTA_SUMMARY_TIMEOUT_MS = 10_000;

type InternalReply = { status: number; json: unknown; retryAfter: string | null };

async function postInternal(auth: UpstreamAuth, baseUrl: string, method: string, timeoutMs: number): Promise<InternalReply> {
  const root = (baseUrl.trim() || ANTIGRAVITY_BASE_URL).replace(/\/$/, "");
  try {
    const res = await fetch(`${root}/v1internal:${method}`, {
      method: "POST",
      headers: {
        ...antigravityHeaders(),
        Authorization: `Bearer ${auth.key}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ project: auth.project ?? "" }),
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "error",
    });
    const json: unknown = res.ok ? asRecord(await readJsonOr(res, null)) : null;
    return { status: res.status, json, retryAfter: res.headers.get("retry-after") };
  } catch {
    return { status: 0, json: null, retryAfter: null };
  }
}

export async function fetchAvailableModels(auth: UpstreamAuth, baseUrl = ""): Promise<InternalReply> {
  return postInternal(auth, baseUrl, "fetchAvailableModels", MODELS_TIMEOUT_MS);
}

export async function fetchQuotaSummary(auth: UpstreamAuth, baseUrl = ""): Promise<InternalReply> {
  return postInternal(auth, baseUrl, "retrieveUserQuotaSummary", QUOTA_SUMMARY_TIMEOUT_MS);
}
