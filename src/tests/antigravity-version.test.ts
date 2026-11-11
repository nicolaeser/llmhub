import assert from "node:assert/strict";
import test, { afterEach, beforeEach, mock } from "node:test";
import {
  ANTIGRAVITY_CLIENT_VERSION,
  ANTIGRAVITY_MANIFEST_MAX_BYTES,
  ANTIGRAVITY_MANIFEST_URL,
  ANTIGRAVITY_VERSION_RETRY_MS,
  ANTIGRAVITY_VERSION_TTL_MS,
  antigravityClientVersion,
  antigravityUserAgent,
  hubUserAgent,
  parseManifestVersion,
  refreshAntigravityVersion,
} from "@/lib/gateway/upstreams/antigravity-version";
import { antigravityHeaders } from "@/lib/gateway/upstreams/antigravity";
import { antigravityVersionState, holdAntigravityVersion, resetAntigravityVersion } from "./support/antigravity-version";

const T0 = Date.parse("2026-11-11T08:00:00Z");
const BUILT_IN_USER_AGENT = "antigravity/hub/2.29.0 (aidev_client; os_type=darwin; arch=arm64; cl=1013060670)";
const MANIFEST = [
  "version: 2.31.1",
  "files:",
  "  - url: https://storage.googleapis.com/antigravity-public/antigravity-hub/2.31.1-1/darwin-arm/Antigravity.zip",
  "    sha512: abc==",
  "    size: 193164391",
  "path: Antigravity.zip",
  "sha512: abc==",
  "releaseDate: '2026-11-10T18:00:00.000Z'",
  "",
].join("\n");

type ManifestCall = { url: string; init: RequestInit | undefined };

const realFetch = globalThis.fetch;
let calls: ManifestCall[] = [];
let logged: Record<string, unknown>[] = [];

function serve(reply: () => Response | Promise<Response>) {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return reply();
  }) as typeof fetch;
}

function manifest(version: string): Response {
  return new Response(MANIFEST.replace("version: 2.31.1", `version: ${version}`), {
    status: 200,
    headers: { "content-type": "application/yaml" },
  });
}

function events(name: string): Record<string, unknown>[] {
  return logged.filter((line) => line.event === name);
}

beforeEach(() => {
  calls = [];
  logged = [];
  resetAntigravityVersion();
  mock.method(console, "log", (line: string) => {
    logged.push(JSON.parse(line) as Record<string, unknown>);
  });
});

afterEach(() => {
  globalThis.fetch = realFetch;
  mock.restoreAll();
  resetAntigravityVersion();
});

test("the User-Agent names the release's changelist only when it is known", () => {
  assert.equal(hubUserAgent("2.23.0"), "antigravity/hub/2.23.0 (aidev_client; os_type=darwin; arch=arm64; cl=998057262)");
  assert.equal(hubUserAgent("2.24.0"), "antigravity/hub/2.24.0 (aidev_client; os_type=darwin; arch=arm64; cl=1000335682)");
  assert.equal(hubUserAgent("2.29.0"), BUILT_IN_USER_AGENT);
  assert.equal(hubUserAgent("2.31.1"), "antigravity/hub/2.31.1 (aidev_client; os_type=darwin; arch=arm64)");
  assert.equal(ANTIGRAVITY_CLIENT_VERSION, "2.29.0");
  holdAntigravityVersion();
  assert.equal(antigravityUserAgent(), BUILT_IN_USER_AGENT);
  assert.deepEqual(antigravityHeaders(), { "User-Agent": BUILT_IN_USER_AGENT });
  holdAntigravityVersion("2.31.1");
  assert.deepEqual(antigravityHeaders(), { "User-Agent": "antigravity/hub/2.31.1 (aidev_client; os_type=darwin; arch=arm64)" });
});

test("the manifest version is read from its top-level version line only", () => {
  assert.equal(parseManifestVersion(MANIFEST), "2.31.1");
  assert.equal(parseManifestVersion('version: "2.31.1"\npath: a.zip\n'), "2.31.1");
  assert.equal(parseManifestVersion("version: '2.31.1'\r\npath: a.zip\r\n"), "2.31.1");
  assert.equal(parseManifestVersion("path: a.zip\nsha512: abc==\nversion: 2.32.0   \nreleaseDate: x\n"), "2.32.0");
  assert.equal(parseManifestVersion("files:\n  - version: 9.9.9\npath: a.zip\n"), null);
  for (const body of [
    "",
    "garbage \u0000\u0001 version 2.31.1",
    "<!doctype html><html><body>version: 2.31.1</body></html>",
    '{"version":"2.31.1"}',
    "version: 2.31.1-beta.1\n",
    "version: 2.31.1.4\n",
    "version: v2.31.1\n",
    "version: 2.31\n",
    "version:2.31.1\n",
    "version: \"2.31.1'\n",
    "version: 2.31.1 # latest\n",
    "version: 1234567.0.0\n",
    "version: 2.31.1-beta.1\nversion: 2.31.1\n",
  ]) {
    assert.equal(parseManifestVersion(body), null, body);
  }
});

test("nothing is fetched while the cached version is fresh", async () => {
  serve(() => manifest("2.31.1"));
  holdAntigravityVersion();
  for (let index = 0; index < 5; index++) antigravityUserAgent(T0 + index * ANTIGRAVITY_VERSION_TTL_MS);
  await refreshAntigravityVersion(T0);
  assert.equal(calls.length, 0);

  resetAntigravityVersion();
  antigravityUserAgent(T0);
  await refreshAntigravityVersion(T0);
  assert.equal(calls.length, 1);
  antigravityUserAgent(T0 + ANTIGRAVITY_VERSION_TTL_MS - 1);
  await refreshAntigravityVersion(T0 + ANTIGRAVITY_VERSION_TTL_MS - 1);
  assert.equal(calls.length, 1);
});

test("a stale version starts one background fetch for many callers and the new version is used afterwards", async () => {
  let release: (response: Response) => void = () => {};
  serve(() => new Promise<Response>((resolve) => (release = resolve)));
  const agents = Array.from({ length: 25 }, () => antigravityUserAgent(T0));
  assert.deepEqual(new Set(agents), new Set([BUILT_IN_USER_AGENT]));
  assert.equal(antigravityClientVersion(T0), ANTIGRAVITY_CLIENT_VERSION);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, ANTIGRAVITY_MANIFEST_URL);
  assert.deepEqual(calls[0]!.init?.headers, { "User-Agent": "electron-builder", "Cache-Control": "no-cache" });
  assert.equal(calls[0]!.init?.redirect, "error");
  assert.ok(calls[0]!.init?.signal instanceof AbortSignal);

  const settled = refreshAntigravityVersion(T0);
  release(manifest("2.31.1"));
  await settled;
  assert.equal(calls.length, 1);
  assert.equal(antigravityUserAgent(T0 + 1), "antigravity/hub/2.31.1 (aidev_client; os_type=darwin; arch=arm64)");
  assert.equal(antigravityVersionState()?.nextCheckAt, T0 + ANTIGRAVITY_VERSION_TTL_MS);
  assert.deepEqual(
    events("antigravity_version.changed").map(({ previous, version }) => ({ previous, version })),
    [{ previous: "2.29.0", version: "2.31.1" }],
  );

  const later = T0 + ANTIGRAVITY_VERSION_TTL_MS;
  serve(() => manifest("2.31.1"));
  antigravityUserAgent(later);
  await refreshAntigravityVersion(later);
  assert.equal(calls.length, 2);
  assert.equal(events("antigravity_version.changed").length, 1);
});

test("a failed refresh keeps the current version and waits for the backoff before trying again", async () => {
  holdAntigravityVersion("2.31.1");
  antigravityVersionState()!.nextCheckAt = T0;
  serve(() => new Response("unavailable", { status: 503 }));
  assert.equal(antigravityClientVersion(T0), "2.31.1");
  await refreshAntigravityVersion(T0);
  assert.equal(calls.length, 1);
  assert.equal(antigravityClientVersion(T0 + 1), "2.31.1");
  assert.equal(events("antigravity_version.refresh_failed").length, 1);

  antigravityUserAgent(T0 + ANTIGRAVITY_VERSION_RETRY_MS - 1);
  await refreshAntigravityVersion(T0 + ANTIGRAVITY_VERSION_RETRY_MS - 1);
  assert.equal(calls.length, 1);

  antigravityUserAgent(T0 + ANTIGRAVITY_VERSION_RETRY_MS);
  await refreshAntigravityVersion(T0 + ANTIGRAVITY_VERSION_RETRY_MS);
  assert.equal(calls.length, 2);
  assert.equal(events("antigravity_version.refresh_failed").length, 1);

  const recovered = T0 + 2 * ANTIGRAVITY_VERSION_RETRY_MS;
  serve(() => manifest("2.32.0"));
  antigravityUserAgent(recovered);
  await refreshAntigravityVersion(recovered);
  assert.equal(calls.length, 3);
  assert.equal(antigravityClientVersion(recovered + 1), "2.32.0");

  serve(() => new Response("unavailable", { status: 503 }));
  antigravityUserAgent(recovered + ANTIGRAVITY_VERSION_TTL_MS);
  await refreshAntigravityVersion(recovered + ANTIGRAVITY_VERSION_TTL_MS);
  assert.equal(calls.length, 4);
  assert.equal(antigravityClientVersion(recovered + ANTIGRAVITY_VERSION_TTL_MS + 1), "2.32.0");
  assert.equal(events("antigravity_version.refresh_failed").length, 2);
});

test("redirects, other statuses, network errors, and unusable bodies are failures", async () => {
  const oversized = `version: 2.31.1\n${"#".repeat(ANTIGRAVITY_MANIFEST_MAX_BYTES)}\n`;
  const replies: [string, () => Response | Promise<Response>][] = [
    ["redirect followed", () => new Response(null, { status: 302, headers: { location: "https://example.test/latest.yml" } })],
    ["redirect refused", () => Promise.reject(new TypeError("fetch failed"))],
    ["created", () => new Response("version: 2.31.1\n", { status: 201 })],
    ["not found", () => new Response("version: 2.31.1\n", { status: 404 })],
    ["html", () => new Response("<html><body>version: 2.31.1</body></html>", { status: 200 })],
    ["garbage", () => new Response("\u0000\u0001\u0002", { status: 200 })],
    ["binary", () => new Response(new Uint8Array([0x76, 0x65, 0x72, 0xff, 0xfe, 0x0a]), { status: 200 })],
    ["empty", () => new Response(null, { status: 200 })],
    ["oversized", () => new Response(oversized, { status: 200 })],
    ["declared oversized", () => new Response("version: 2.31.1\n", { status: 200, headers: { "content-length": "999999" } })],
    ["pre-release", () => manifest("2.31.1-beta.1")],
    ["four parts", () => manifest("2.31.1.0")],
    ["below built-in", () => manifest("2.28.9")],
    ["far below built-in", () => manifest("1.99.99")],
    ["another major", () => manifest("3.0.0")],
    ["absurd", () => manifest("999999.999999.999999")],
  ];
  for (const [name, reply] of replies) {
    resetAntigravityVersion();
    calls = [];
    serve(reply);
    antigravityUserAgent(T0);
    await refreshAntigravityVersion(T0);
    assert.equal(calls.length, 1, name);
    assert.equal(antigravityClientVersion(T0 + 1), ANTIGRAVITY_CLIENT_VERSION, name);
    assert.equal(antigravityVersionState()?.nextCheckAt, T0 + ANTIGRAVITY_VERSION_RETRY_MS, name);
  }
  assert.equal(events("antigravity_version.refresh_failed").length, replies.length);
  assert.equal(events("antigravity_version.changed").length, 0);
});

test("versions compare numerically inside the built-in major and the built-in version itself is accepted", async () => {
  for (const [version, expected] of [
    ["2.100.0", "2.100.0"],
    ["10.0.0", ANTIGRAVITY_CLIENT_VERSION],
    ["2.29.0", "2.29.0"],
    ["2.29.1", "2.29.1"],
    ["2.3.0", ANTIGRAVITY_CLIENT_VERSION],
  ] as const) {
    resetAntigravityVersion();
    serve(() => manifest(version));
    antigravityUserAgent(T0);
    await refreshAntigravityVersion(T0);
    assert.equal(antigravityClientVersion(T0 + 1), expected, version);
  }
});
