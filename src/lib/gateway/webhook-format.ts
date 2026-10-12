import type { AlertPayload, WebhookEvent, WebhookFormat } from "@/types/gateway";

const EVENT_TITLES: Record<WebhookEvent, string> = {
  upstream_exhaustion: "Upstream exhaustion",
  budget_threshold: "Budget threshold crossed",
  provider_models_changed: "Provider models changed",
  spend_anomaly: "Spend anomaly",
  key_expiring: "API key expiring",
  key_blocked: "API key blocked",
  pii_blocked: "Request blocked by PII policy",
};

const SLACK_SECTION_LIMIT = 3000;

function clip(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

function slackEscape(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function alertTitle(event: WebhookEvent): string {
  return `LLM Hub: ${EVENT_TITLES[event]}`;
}

function footer(alert: AlertPayload): string {
  return `${alert.event} · ${alert.ts} · ${alert.id}`;
}

function slackBody(alert: AlertPayload) {
  const title = alertTitle(alert.event);
  return {
    text: slackEscape(`${title}: ${alert.message}`),
    blocks: [
      { type: "header", text: { type: "plain_text", text: title } },
      { type: "section", text: { type: "plain_text", text: clip(alert.message, SLACK_SECTION_LIMIT) } },
      { type: "context", elements: [{ type: "plain_text", text: footer(alert) }] },
    ],
  };
}

function teamsBody(alert: AlertPayload) {
  return {
    type: "message",
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        contentUrl: null,
        content: {
          $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
          type: "AdaptiveCard",
          version: "1.4",
          msteams: { width: "Full" },
          body: [
            { type: "TextBlock", text: alertTitle(alert.event), weight: "Bolder", size: "Medium", wrap: true },
            { type: "TextBlock", text: alert.message, wrap: true },
            { type: "TextBlock", text: footer(alert), isSubtle: true, size: "Small", wrap: true },
          ],
        },
      },
    ],
  };
}

export function webhookBody(format: WebhookFormat, alert: AlertPayload): string {
  if (format === "slack") return JSON.stringify(slackBody(alert));
  if (format === "teams") return JSON.stringify(teamsBody(alert));
  return JSON.stringify({
    id: alert.id,
    event: alert.event,
    message: alert.message,
    source: "llm-hub",
    ts: alert.ts,
  });
}
