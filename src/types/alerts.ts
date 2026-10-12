import type { AlertWebhookInput } from "@/types/settings";

export type WebhookEvent = AlertWebhookInput["events"][number];

export type WebhookFormat = AlertWebhookInput["format"];

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
