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

export type AlertStateKind = "budget" | "spend_anomaly" | "key_expiry" | "error_rate" | "latency";

export type SpendAnomalyRule = {
  factor: number;
  minCost: number;
};

export type AlertEmails = {
  recipients: string[];
  events: WebhookEvent[];
};

export type AlertMail = {
  subject: string;
  text: string;
  html: string;
};

export type TrafficAlertRule = {
  windowMinutes: number;
  minRequests: number;
  errorRatePercent: number;
  latencyP95Ms: number;
  latencyFactor: number;
};

export type StatusCount = {
  status: number;
  count: number;
};

export type TrafficScope = {
  id: string;
  model: string;
  counts: StatusCount[];
};

export type ErrorRate = {
  requests: number;
  errors: number;
  percent: number;
};

export type LatencySpike = {
  absolute: boolean;
  relative: boolean;
};
