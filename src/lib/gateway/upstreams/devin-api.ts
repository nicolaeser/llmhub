import "server-only";
import { asString, asRecord } from "@/lib/gateway/core";
import {
  DEVIN_CATALOG_USER_AGENT,
  DEVIN_MODELS_PATH,
  DEVIN_PROFILE_URL,
  DEVIN_SERVER_URL,
  DEVIN_STATUS_PATH,
  DEVIN_TOKEN_URL,
  devinBasicAuth,
  devinMetadataRequest,
  devinProfileOf,
  formatSessionToken,
  parseDevinStatus,
} from "@/lib/gateway/upstreams/devin-account";
import { devinModels, parseDevinModelConfigs } from "@/lib/gateway/upstreams/devin-models";
import { readJsonOr } from "@/lib/utils/json";
import type { DevinProfile, DevinReply, DevinUserStatus } from "@/types/devin";
import type { DiscoveredModel } from "@/types/providers";

const DEVIN_TIMEOUT_MS = 30_000;

async function unary(path: string, token: string, userAgent: string): Promise<DevinReply> {
  try {
    const res = await fetch(`${DEVIN_SERVER_URL}${path}`, {
      method: "POST",
      headers: {
        Authorization: devinBasicAuth(token),
        "Connect-Protocol-Version": "1",
        "Content-Type": "application/proto",
        Accept: "*/*",
        "User-Agent": userAgent,
      },
      body: devinMetadataRequest(token),
      signal: AbortSignal.timeout(DEVIN_TIMEOUT_MS),
      redirect: "error",
    });
    const data = new Uint8Array(await res.arrayBuffer());
    return { status: res.status, data, retryAfter: res.headers.get("retry-after") };
  } catch {
    return { status: 0, data: new Uint8Array(), retryAfter: null };
  }
}

export function devinStatusReply(token: string): Promise<DevinReply> {
  return unary(DEVIN_STATUS_PATH, token, "");
}

export function readDevinStatus(reply: DevinReply): DevinUserStatus | null {
  if (reply.status < 200 || reply.status >= 300) return null;
  try {
    return parseDevinStatus(reply.data);
  } catch {
    return null;
  }
}

export async function devinModelsReply(token: string): Promise<{ status: number; models: DiscoveredModel[] }> {
  const reply = await unary(DEVIN_MODELS_PATH, token, DEVIN_CATALOG_USER_AGENT);
  if (reply.status < 200 || reply.status >= 300) return { status: reply.status, models: [] };
  try {
    return { status: reply.status, models: devinModels(parseDevinModelConfigs(reply.data)) };
  } catch {
    return { status: 502, models: [] };
  }
}

export async function exchangeDevinCode(code: string, verifier: string): Promise<string> {
  const res = await fetch(DEVIN_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ code: code.trim(), code_verifier: verifier.trim() }),
    signal: AbortSignal.timeout(DEVIN_TIMEOUT_MS),
    redirect: "error",
  }).catch(() => {
    throw new Error("SIGN_IN_FAILED");
  });
  const json = asRecord(await readJsonOr(res, null));
  const token = asString(json?.token).trim();
  if (!res.ok || !token) throw new Error("SIGN_IN_FAILED");
  return formatSessionToken(token);
}

export async function devinProfile(token: string): Promise<DevinProfile | null> {
  try {
    const res = await fetch(DEVIN_PROFILE_URL, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(DEVIN_TIMEOUT_MS),
      redirect: "error",
    });
    return res.ok ? devinProfileOf(await readJsonOr(res, null)) : null;
  } catch {
    return null;
  }
}
