import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after, afterEach, before, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";

const BUNDLED = "fake-bundled-client-value";
const SAVED = "fake-saved-client-value";
const root = fileURLToPath(new URL("../..", import.meta.url));
const settings = new Map<string, string>();

(globalThis as { prisma?: unknown }).prisma = {
  setting: {
    findUnique: async ({ where }: { where: { key: string } }) => {
      const value = settings.get(where.key);
      return value === undefined ? null : { key: where.key, value };
    },
    upsert: async ({ where, create }: { where: { key: string }; create: { value: string } }) => {
      settings.set(where.key, create.value);
      return { key: where.key, value: create.value };
    },
  },
};

const realFetch = globalThis.fetch;
const repositoryCwd = process.cwd();
let imageDir = "";
let config: typeof import("@/lib/gateway/upstreams/antigravity-config");
let signIn: typeof import("@/lib/gateway/upstreams/subscription-sign-in");

before(async () => {
  config = await import("@/lib/gateway/upstreams/antigravity-config");
  signIn = await import("@/lib/gateway/upstreams/subscription-sign-in");
  imageDir = await mkdtemp(path.join(tmpdir(), "llmhub-agy-image-"));
  await writeFile(path.join(imageDir, config.BUNDLED_CLIENT_SECRET_FILE), `  ${BUNDLED}\n`);
  process.chdir(imageDir);
});

after(async () => {
  process.chdir(repositoryCwd);
  await rm(imageDir, { recursive: true, force: true });
});

beforeEach(() => {
  settings.clear();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

test("the bundled file is read trimmed, and a missing, blank, or unreadable file means no secret", async () => {
  assert.equal(await config.readBundledClientSecret(path.join(imageDir, config.BUNDLED_CLIENT_SECRET_FILE)), BUNDLED);
  assert.equal(await config.readBundledClientSecret(path.join(imageDir, "missing")), "");
  const blank = path.join(imageDir, "blank");
  await writeFile(blank, " \n");
  assert.equal(await config.readBundledClientSecret(blank), "");
  const folder = path.join(imageDir, "folder");
  await mkdir(folder);
  assert.equal(await config.readBundledClientSecret(folder), "");
});

test("a bundled secret lets Google sign-in start without a saved one", async () => {
  assert.deepEqual(await config.antigravityClientState(), { saved: false, bundled: true });
  assert.equal(await config.antigravityClientSecret(), BUNDLED);
  const device = await signIn.startAuthorization("antigravity");
  assert.equal(device.grant.kind, "antigravity");
});

test("a saved secret wins over the bundled one until it is removed", async () => {
  await config.saveAntigravityClientSecret(SAVED);
  assert.deepEqual(await config.antigravityClientState(), { saved: true, bundled: true });
  assert.equal(await config.antigravityClientSecret(), SAVED);
  await config.saveAntigravityClientSecret("");
  assert.deepEqual(await config.antigravityClientState(), { saved: false, bundled: true });
  assert.equal(await config.antigravityClientSecret(), BUNDLED);
});

test("the code exchange sends the bundled secret when none is saved", async () => {
  const sent: URLSearchParams[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("https://oauth2.googleapis.com/token")) {
      sent.push(new URLSearchParams(String(init?.body ?? "")));
      return Response.json({ access_token: "access-1", refresh_token: "refresh-1", expires_in: 3600 });
    }
    if (url.startsWith("https://www.googleapis.com/oauth2/v2/userinfo")) return Response.json({ email: "dev@example.com" });
    if (url.endsWith(":loadCodeAssist")) return Response.json({ cloudaicompanionProject: "proj-1" });
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;
  const device = await signIn.startAuthorization("antigravity");
  if (device.grant.kind !== "antigravity") throw new Error("kind");
  const session = await signIn.completeAuthorization(device.grant, "4/code");
  assert.equal(session.tokens.accountId, "proj-1");
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.get("client_secret"), BUNDLED);
});

test("the image writes the bundled secret where the server reads it", async () => {
  const dockerfile = await readFile(path.join(root, "Dockerfile"), "utf8");
  const runner = dockerfile.slice(dockerfile.indexOf("AS runner"));
  assert.ok(runner.includes(`/run/secrets/antigravity_client_secret ${config.BUNDLED_CLIENT_SECRET_FILE};`));
});
