import type { AlertMail, AlertPayload, WebhookEvent, WebhookFormat } from "@/types/alerts";

const EVENT_TITLES: Record<WebhookEvent, string> = {
  upstream_exhaustion: "Upstream exhaustion",
  budget_threshold: "Budget threshold crossed",
  provider_models_changed: "Provider models changed",
  spend_anomaly: "Spend anomaly",
  key_expiring: "API key expiring",
  key_blocked: "API key blocked",
  pii_blocked: "Request blocked by PII policy",
  emergency_sign_in: "Emergency sign-in",
  error_rate_spike: "Error rate spike",
  latency_spike: "Latency spike",
};

const SLACK_SECTION_LIMIT = 3000;

const EVENT_PAGES: Record<WebhookEvent, string> = {
  upstream_exhaustion: "/logs",
  budget_threshold: "/overview",
  provider_models_changed: "/models",
  spend_anomaly: "/usage",
  key_expiring: "/keys",
  key_blocked: "/keys",
  pii_blocked: "/logs",
  emergency_sign_in: "/users",
  error_rate_spike: "/logs",
  latency_spike: "/logs",
};

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

function consoleLink(appUrl: string, path: string): string {
  return new URL(path, appUrl).toString();
}

export function alertMail(alert: AlertPayload, appUrl: string): AlertMail {
  return {
    subject: alertTitle(alert.event),
    text: [
      alert.message,
      "",
      "--",
      `Event: ${alert.event}`,
      `Time: ${alert.ts}`,
      `Alert ID: ${alert.id}`,
      `Open LLM Hub: ${consoleLink(appUrl, EVENT_PAGES[alert.event])}`,
      `Change alert emails: ${consoleLink(appUrl, "/settings?tab=logging")}`,
    ].join("\n"),
  };
}
