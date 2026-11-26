import "server-only";
import { asRecord, asString } from "@/lib/gateway/core";
import { CLAUDE_CODE_SESSION_HEADER } from "@/lib/gateway/routing/account-affinity";
import { PinStore } from "@/lib/gateway/routing/pin-store";
import { affinitySession, SESSION_AFFINITY_HEADER } from "@/lib/gateway/routing/session-fingerprint";
import { env } from "@/lib/env";
import { parseJsonOrNull } from "@/lib/utils/json";
import type { JsonMap, Principal, RequestTrace } from "@/types/gateway";
import type {
  AffinityOutcome,
  ResolvedDeployment,
  ResolvedModelGroup,
  RunAffinity,
  RunRouting,
  SessionAffinity,
} from "@/types/routing";

export const DEPLOYMENT_PIN_TTL_MS = 30 * 60_000;
export const DEPLOYMENT_HEADER = "x-llmhub-deployment";
export const DEFAULT_SPILL_MARGIN = 4;
const KEY_PREFIX = "llmhub:deployment-pin:v1";
const SESSION_HEADERS = [SESSION_AFFINITY_HEADER, CLAUDE_CODE_SESSION_HEADER] as const;

export type AffinityPlan = {
  keep: ResolvedDeployment | null;
  pool: ResolvedDeployment[];
  outcome: Exclude<AffinityOutcome, "off">;
};

export type AffinityCandidates = {
  pinned: string | null;
  candidates: ResolvedDeployment[];
  queued: readonly ResolvedDeployment[];
  busy: ReadonlySet<string>;
  failed: ReadonlySet<string>;
  load: (id: string) => number;
  margin: number;
};

const deploymentPins = new PinStore<string>("deployment", KEY_PREFIX, "deployment_pin.redis_fallback");
const served = new WeakMap<object, SessionAffinity>();

function pinKey(alias: string, session: string): string {
  return `${alias}:${session}`;
}

function storedDeployment(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  return asString(asRecord(parseJsonOrNull(raw))?.deploymentId) || null;
}

function encoded(deploymentId: string): string {
  return JSON.stringify({ deploymentId });
}

export async function readDeploymentPin(alias: string, session: string, now = Date.now()): Promise<string | null> {
  if (!session) return null;
  const key = pinKey(alias, session);
  const local = deploymentPins.local(key, now);
  const shared = await deploymentPins.shared((redis) => redis.get(deploymentPins.sharedKey(key)));
  const pinned = shared ? storedDeployment(shared.value) : null;
  if (!pinned) return local;
  if (pinned !== local) deploymentPins.remember(key, pinned, DEPLOYMENT_PIN_TTL_MS, now);
  return pinned;
}

export async function writeDeploymentPin(alias: string, session: string, deploymentId: string, now = Date.now()): Promise<void> {
  if (!session) return;
  const key = pinKey(alias, session);
  deploymentPins.remember(key, deploymentId, DEPLOYMENT_PIN_TTL_MS, now);
  await deploymentPins.shared((redis) => redis.set(deploymentPins.sharedKey(key), encoded(deploymentId), "PX", DEPLOYMENT_PIN_TTL_MS));
}

export async function touchDeploymentPin(alias: string, session: string, deploymentId: string, now = Date.now()): Promise<void> {
  if (!session) return;
  const key = pinKey(alias, session);
  deploymentPins.remember(key, deploymentId, DEPLOYMENT_PIN_TTL_MS, now);
  await deploymentPins.shared(async (redis) => {
    const shared = deploymentPins.sharedKey(key);
    if (await redis.pexpire(shared, DEPLOYMENT_PIN_TTL_MS)) return;
    await redis.set(shared, encoded(deploymentId), "PX", DEPLOYMENT_PIN_TTL_MS, "NX");
  });
}

export function forgetDeploymentPins(): void {
  deploymentPins.forget();
}

export function spillMargin(): number {
  const configured = env.SESSION_AFFINITY_SPILL_MARGIN;
  return configured === undefined ? DEFAULT_SPILL_MARGIN : Number(configured);
}

function affinityScope(principal: Principal | undefined): string {
  return principal?.key?.project_id || principal?.memberId || principal?.key?.token_id || "";
}

export function sessionHeaders(headers: Headers): Record<string, string> {
  const found: Record<string, string> = {};
  for (const name of SESSION_HEADERS) {
    const value = headers.get(name)?.trim();
    if (value) found[name] = value;
  }
  return found;
}

export function runAffinity(
  principal: Principal | undefined,
  body: JsonMap | null,
  headers?: Record<string, string>,
): RunAffinity {
  const merged = { ...principal?.trace?.sessionHeaders, ...headers };
  return {
    request: { body, headers: Object.keys(merged).length ? merged : undefined, scope: affinityScope(principal) },
    sessions: new Map(),
    failed: new Set(),
  };
}

export function groupSession(group: ResolvedModelGroup, run: RunRouting | null): string {
  const affinity = run?.affinity;
  if (!group.session_affinity || !affinity) return "";
  const known = affinity.sessions.get(group.alias);
  if (known !== undefined) return known;
  const session = affinitySession({ ...affinity.request, alias: group.alias });
  affinity.sessions.set(group.alias, session);
  return session;
}

export function affinityPlan(input: AffinityCandidates): AffinityPlan {
  const { pinned, candidates } = input;
  if (!pinned) return { keep: null, pool: candidates, outcome: "new" };
  const usable = !input.failed.has(pinned);
  const kept = usable ? candidates.find((dep) => dep.id === pinned) : undefined;
  if (kept) {
    const least = Math.min(...candidates.map((dep) => input.load(dep.id)));
    if (input.load(pinned) <= least + input.margin) return { keep: kept, pool: candidates, outcome: "hit" };
    return { keep: null, pool: candidates.filter((dep) => dep.id !== pinned), outcome: "spill" };
  }
  const waiting = usable && input.busy.has(pinned) && input.queued.some((dep) => dep.id === pinned);
  if (waiting) return { keep: null, pool: candidates, outcome: "spill" };
  const fresh = candidates.filter((dep) => !input.failed.has(dep.id));
  return { keep: null, pool: fresh.length ? fresh : candidates, outcome: "failover" };
}

export function settleDeploymentPin(alias: string, session: string, outcome: AffinityOutcome, deploymentId: string): void {
  if (outcome === "off") return;
  if (outcome === "hit") void touchDeploymentPin(alias, session, deploymentId);
  else void writeDeploymentPin(alias, session, deploymentId);
}

export function noteAffinity(dep: ResolvedDeployment, affinity: SessionAffinity | null): void {
  if (affinity) served.set(dep, affinity);
  else served.delete(dep);
}

export function servedAffinity(dep: object | null | undefined): SessionAffinity | null {
  return dep ? (served.get(dep) ?? null) : null;
}

export function noteServed(trace: RequestTrace | undefined, dep: ResolvedDeployment, affinity: SessionAffinity | null): void {
  if (!trace) return;
  if (affinity) trace.affinityDeployment = dep.id;
  else delete trace.affinityDeployment;
}

export function withDeploymentHeader(res: Response, trace: RequestTrace | undefined): Response {
  const deploymentId = trace?.affinityDeployment;
  if (!deploymentId) return res;
  try {
    res.headers.set(DEPLOYMENT_HEADER, deploymentId);
    return res;
  } catch {
    const headers = new Headers(res.headers);
    headers.set(DEPLOYMENT_HEADER, deploymentId);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  }
}
