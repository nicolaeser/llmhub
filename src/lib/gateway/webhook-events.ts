export const WEBHOOK_EVENTS = [
  "upstream_exhaustion",
  "budget_threshold",
  "provider_models_changed",
  "spend_anomaly",
  "key_expiring",
  "key_blocked",
  "pii_blocked",
] as const;

export const WEBHOOK_FORMATS = ["json", "slack", "teams"] as const;

export const MAX_ALERT_WEBHOOKS = 20;
