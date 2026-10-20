import "server-only";
import { REQUESTS_FEED } from "@/lib/gateway/request-logs/requests-feed";
import { LIMITS_FEED } from "@/lib/providers/limits-feed";
import { USAGE_FEED } from "@/lib/usage/usage-today";
import type { LiveFeed, LiveTopic } from "@/types/live";

export const LIVE_FEEDS: Record<LiveTopic, LiveFeed<unknown>> = {
  limits: LIMITS_FEED,
  requests: REQUESTS_FEED,
  usage: USAGE_FEED,
};
