import type { WEBHOOK_EVENTS, WEBHOOK_FORMATS } from "@/lib/alerts/events";

export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export type WebhookFormat = (typeof WEBHOOK_FORMATS)[number];

export type AlertWebhook = {
  id: string;
  url: string;
  secret: string;
  format: WebhookFormat;
  events: WebhookEvent[];
};

export type AlertPayload = {
  id: string;
  event: WebhookEvent;
  message: string;
  ts: string;
};

export type AlertStateKind = "budget" | "spend_anomaly" | "key_expiry";

export type SpendAnomalyRule = {
  factor: number;
  minCost: number;
};
