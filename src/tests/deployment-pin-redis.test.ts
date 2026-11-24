import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import type { ResolvedDeployment, ResolvedModelGroup, RunRouting } from "@/types/routing";

process.env.REDIS_URL = "redis://redis.test:6379";

type Command = { name: string; args: unknown[] };

const store = new Map<string, { value: string; ttl: number }>();
const commands: Command[] = [];
let down = false;

function unavailable(): void {
  if (down) throw new Error("redis offline");
}

const handlers: Record<string, (...args: never[]) => unknown> = {
  get: (key: string) => store.get(key)?.value ?? null,
  set: (key: string, value: string, _px: string, ttl: number, mode?: string) => {
    if (mode === "NX" && store.has(key)) return null;
    store.set(key, { value, ttl });
    return "OK";
  },
  pexpire: (key: string, ttl: number) => {
    const held = store.get(key);
    if (!held) return 0;
    held.ttl = ttl;
    return 1;
  },
  mget: (keys: string[]) => keys.map(() => null),
};

const fakeRedis = new Proxy(
  {},
  {
    get: (_target, name: string) =>
      name === "then"
        ? undefined
        : async (...args: unknown[]) => {
            unavailable();
            commands.push({ name, args });
            return handlers[name]?.(...(args as never[])) ?? null;
          },
  },
);
(globalThis as { __llmhubRedis?: Promise<unknown> }).__llmhubRedis = Promise.resolve(fakeRedis);

const PREFIX = "llmhub:deployment-pin:v1";

function pinCommands(): Command[] {
  return commands.filter((command) => String(command.args[0]).startsWith(PREFIX));
}

async function settle(): Promise<void> {
  for (let wait = 0; wait < 10; wait++) await new Promise((resolve) => setImmediate(resolve));
}

beforeEach(async () => {
  const { forgetDeploymentPins } = await import("@/lib/gateway/routing/deployment-affinity");
  forgetDeploymentPins();
  store.clear();
  commands.length = 0;
  down = false;
});

test("deployment pins live under their own prefix with a thirty minute expiry", async () => {
  const { DEPLOYMENT_PIN_TTL_MS, writeDeploymentPin } = await import("@/lib/gateway/routing/deployment-affinity");
  await writeDeploymentPin("local-qwen", "a".repeat(32), "gpu-a");
  assert.equal(DEPLOYMENT_PIN_TTL_MS, 30 * 60_000);
  assert.deepEqual(store.get(`${PREFIX}:local-qwen:${"a".repeat(32)}`), {
    value: JSON.stringify({ deploymentId: "gpu-a" }),
    ttl: DEPLOYMENT_PIN_TTL_MS,
  });
});

test("a pin another replica moved wins over the local copy", async () => {
  const { readDeploymentPin, writeDeploymentPin } = await import("@/lib/gateway/routing/deployment-affinity");
  await writeDeploymentPin("alias", "moved", "gpu-a");
  store.set(`${PREFIX}:alias:moved`, { value: JSON.stringify({ deploymentId: "gpu-b" }), ttl: 1 });
  assert.equal(await readDeploymentPin("alias", "moved"), "gpu-b");
  down = true;
  assert.equal(await readDeploymentPin("alias", "moved"), "gpu-b");
});

test("a hit extends the shared expiry and restores a pin Redis lost", async () => {
  const { DEPLOYMENT_PIN_TTL_MS, touchDeploymentPin } = await import("@/lib/gateway/routing/deployment-affinity");
  store.set(`${PREFIX}:alias:kept`, { value: JSON.stringify({ deploymentId: "gpu-a" }), ttl: 5 });
  await touchDeploymentPin("alias", "kept", "gpu-a");
  assert.equal(store.get(`${PREFIX}:alias:kept`)?.ttl, DEPLOYMENT_PIN_TTL_MS);
  assert.deepEqual(
    pinCommands().map((command) => command.name),
    ["pexpire"],
  );
  commands.length = 0;
  await touchDeploymentPin("alias", "lost", "gpu-b");
  assert.deepEqual(
    pinCommands().map((command) => command.name),
    ["pexpire", "set"],
  );
  assert.deepEqual(store.get(`${PREFIX}:alias:lost`), { value: JSON.stringify({ deploymentId: "gpu-b" }), ttl: DEPLOYMENT_PIN_TTL_MS });
});

test("without Redis the replica keeps routing on its own pins", async () => {
  const { readDeploymentPin, writeDeploymentPin } = await import("@/lib/gateway/routing/deployment-affinity");
  down = true;
  await writeDeploymentPin("alias", "offline", "gpu-a");
  assert.equal(await readDeploymentPin("alias", "offline"), "gpu-a");
  down = false;
  assert.equal(await readDeploymentPin("alias", "offline"), "gpu-a");
});

test("deployment pins and account pins never share a key or a local copy", async () => {
  const { forgetDeploymentPins, readDeploymentPin, writeDeploymentPin } = await import("@/lib/gateway/routing/deployment-affinity");
  const { readPin, writePin, forgetPins } = await import("@/lib/gateway/routing/account-affinity");
  forgetPins();
  down = true;
  await writePin("claude", "shared-session", { providerId: "acct-a", handoffAt: 0 }, null);
  await writeDeploymentPin("claude", "shared-session", "gpu-a");
  forgetDeploymentPins();
  assert.deepEqual(await readPin("claude", "shared-session"), { providerId: "acct-a", handoffAt: 0 });
  assert.equal(await readDeploymentPin("claude", "shared-session"), null);
});

function replica(id: string, weight: number): ResolvedDeployment {
  return {
    id,
    kind: "openai_compat",
    base_url: "http://gpu.test/v1",
    model: "qwen",
    weight,
    cost_input_per_1k: 0,
    cost_output_per_1k: 0,
    provider_id: "",
  };
}

function group(alias: string, sessionAffinity: boolean): ResolvedModelGroup {
  const mapped = [replica(`${alias}-a`, 10), replica(`${alias}-b`, 5)];
  return {
    alias,
    strategy: "priority",
    billing_mode: "routed",
    price_input_per_1k: 0,
    price_output_per_1k: 0,
    price_time_zone: "UTC",
    price_windows: [],
    overflow_group: "",
    num_retries: 0,
    fallback_groups: [],
    deployments: mapped,
    mapped,
    session_affinity: sessionAffinity,
  };
}

async function routing(): Promise<RunRouting> {
  const { runAffinity } = await import("@/lib/gateway/routing/deployment-affinity");
  return { session: "", tried: new Set(), affinity: runAffinity(undefined, null, { "x-session-affinity": "agent" }) };
}

test("routing reads and writes deployment pins in Redis only for groups with session affinity", async () => {
  const { acquireGroup } = await import("@/lib/gateway/routing/runtime");
  const off = await acquireGroup(group("redis-off", false), undefined, undefined, "", undefined, null, await routing());
  off.release();
  await settle();
  assert.deepEqual(pinCommands(), []);

  const on = group("redis-on", true);
  const first = await acquireGroup(on, undefined, undefined, "", undefined, null, await routing());
  first.release();
  await settle();
  assert.deepEqual(
    pinCommands().map((command) => command.name),
    ["get", "set"],
  );
  commands.length = 0;
  const second = await acquireGroup(on, undefined, undefined, "", undefined, null, await routing());
  second.release();
  await settle();
  assert.equal(second.affinity?.outcome, "hit");
  assert.deepEqual(
    pinCommands().map((command) => command.name),
    ["get", "pexpire"],
  );
});
