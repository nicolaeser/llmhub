export type HealthBackend = "redis" | "memory";

export type HealthCounts = {
  ok: number;
  fail: number;
  trips: number;
  latency: number[];
};

export type HealthState = HealthCounts & { cooldownUntil: number | null };

export type HealthSummary = {
  attempts: number;
  failures: number;
  errorRate: number;
  p50: number | null;
  p95: number | null;
  trips: number;
};

export type DeploymentHealthView = HealthSummary & {
  id: string;
  alias: string;
  model: string;
  kind: string;
  provider: string;
  cooldownUntil: number | null;
};

export type HealthReport = {
  minutes: number;
  backend: HealthBackend;
  generatedAt: number;
  cooldownMs: number;
  deployments: DeploymentHealthView[];
};
