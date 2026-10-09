import "server-only";
import { createHmac, randomUUID } from "node:crypto";
import { jobsEnabled } from "@/lib/jobs/connection";
import { enqueueWebhook } from "@/lib/jobs/queues";
import { isRouterError } from "@/lib/gateway/core";
import { claimCooldown, PII_ALERT_COOLDOWN_MS } from "@/lib/gateway/alert-rules";
import { getEnterprise } from "@/lib/gateway/settings";
import { writeAudit } from "@/lib/gateway/audit";
import { webhookBody } from "@/lib/gateway/webhook-format";
import { logger } from "@/lib/logging/logger";
import type { Principal, WebhookEvent } from "@/types/gateway";
import type { WebhookJobData } from "@/types/jobs";

export function webhookHeaders(
  secret: string,
  body: string,
  timestamp = Math.floor(Date.now() / 1000),
): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (!secret) return headers;
  const signature = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  headers["X-LLMHub-Timestamp"] = String(timestamp);
  headers["X-LLMHub-Signature"] = `sha256=${signature}`;
  return headers;
}

export async function deliverWebhook(data: WebhookJobData, attempts = 1): Promise<void> {
  const hook = (await getEnterprise()).alert_webhooks?.find((h) => h.id === data.webhookId);
  if (!hook?.events.includes(data.event)) return;
  const body = webhookBody(hook.format, {
    id: data.id,
    event: data.event,
    message: data.message,
    ts: new Date().toISOString(),
  });
  try {
    const res = await fetch(hook.url, {
      method: "POST",
      headers: webhookHeaders(hook.secret.trim(), body),
      body,
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await writeAudit({
      actor: "worker",
      action: "alert_delivered",
      objectType: "alert",
      objectId: data.id,
      after: { webhook: hook.id, event: data.event, format: hook.format, status: res.status, attempts },
    });
  } catch (err) {
    await writeAudit({
      actor: "worker",
      action: "alert_failed",
      objectType: "alert",
      objectId: data.id,
      after: {
        webhook: hook.id,
        event: data.event,
        attempts,
        error: err instanceof Error ? err.message : String(err),
      },
    });
    throw err;
  }
}

async function dispatchWebhook(job: WebhookJobData): Promise<void> {
  if (jobsEnabled()) {
    try {
      await enqueueWebhook(job);
      return;
    } catch (err) {
      logger.warn("alert.enqueue_failed", {
        webhook: job.webhookId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
  await deliverWebhook(job, 1);
}

export async function fireAlert(event: WebhookEvent, message: string): Promise<void> {
  try {
    const hooks = (await getEnterprise()).alert_webhooks?.filter((h) => h.events.includes(event)) ?? [];
    if (!hooks.length) return;
    const id = randomUUID();
    await Promise.allSettled(hooks.map((h) => dispatchWebhook({ id, webhookId: h.id, event, message })));
  } catch {}
}

export function shouldAlert(err: unknown): boolean {
  if (isRouterError(err, "no_healthy")) return true;
  const status = (err as { status?: number }).status ?? 0;
  const code = (err as { code?: string }).code;
  return status >= 500 || status === 429 || code === "no_capacity";
}

export async function alertUpstreamFailure(err: unknown): Promise<void> {
  if (!shouldAlert(err)) return;
  const message = err instanceof Error ? err.message : "upstream failure";
  await fireAlert("upstream_exhaustion", message);
}

const piiAlerts = new Map<string, number>();

export async function alertPiiBlocked(principal: Principal, entities: Iterable<string>, now = Date.now()): Promise<void> {
  const key = principal.key;
  const subject = key ? `key:${key.token_id}` : `user:${principal.userId}`;
  if (!claimCooldown(piiAlerts, subject, now, PII_ALERT_COOLDOWN_MS)) return;
  const who = key ? `key ${key.key_alias || key.key_name}` : `console user ${principal.userId}`;
  const where = principal.trace?.endpoint ? ` on ${principal.trace.endpoint}` : "";
  await fireAlert("pii_blocked", `${who}: request${where} blocked by PII policy (${[...entities].sort().join(", ")})`);
}

export async function alertKeyBlocked(key: { keyAlias: string; prefix: string }, actor: string): Promise<void> {
  await fireAlert("key_blocked", `key ${key.keyAlias || key.prefix} was blocked by ${actor}`);
}
