import assert from "node:assert/strict";
import test from "node:test";
import { S3Error } from "@/lib/s3/client";
import { s3FromParts } from "@/lib/s3/config";
import { hasPlaceholder, presetEndpoint, S3_PRESETS, s3Preset } from "@/lib/s3/presets";
import { probeStorage, s3ProbeCode } from "@/lib/s3/probe";
import { authorizationHeader, sha256Hex } from "@/lib/s3/sign";
import { joinKey, objectUrl, publicObjectUrl, resolveAddressing } from "@/lib/s3/url";
import { storageSettingsSchema } from "@/schemas/settings";
import type { S3Location } from "@/types/s3";

const KEYS = { S3_ACCESS_KEY_ID: "AKIAEXAMPLE", S3_SECRET_ACCESS_KEY: "secret" };

test("joinKey keeps nested paths and drops empty segments", () => {
  assert.equal(joinKey("llmhub/", "/files/", "id", "a.json"), "llmhub/files/id/a.json");
  assert.equal(joinKey("a/../b", "c"), "b/c");
});

test("path-style, virtual-hosted, and custom domain URLs", () => {
  const base: S3Location = {
    bucket: "llmhub",
    region: "eu-central-1",
    endpoint: "https://minio.internal:9000",
    prefix: "prod",
    addressing: "path",
    publicBaseUrl: "",
  };
  assert.equal(objectUrl(base, "files/id/a.json").toString(), "https://minio.internal:9000/llmhub/prod/files/id/a.json");

  const vhost = objectUrl(
    { ...base, endpoint: "https://s3.eu-central-1.amazonaws.com", addressing: "virtual-hosted" },
    "files/id/a.json",
  );
  assert.equal(vhost.hostname, "llmhub.s3.eu-central-1.amazonaws.com");
  assert.equal(vhost.pathname, "/prod/files/id/a.json");

  const domain: S3Location = {
    ...base,
    bucket: "files.example.com",
    endpoint: "https://files.example.com",
    prefix: "hub",
    addressing: "domain",
    publicBaseUrl: "https://cdn.example.com/assets",
  };
  assert.equal(objectUrl(domain, "videos/1/clip.mp4").toString(), "https://files.example.com/hub/videos/1/clip.mp4");
  assert.equal(publicObjectUrl(domain, "videos/1/clip.mp4"), "https://cdn.example.com/assets/hub/videos/1/clip.mp4");
  assert.equal(publicObjectUrl(base, "a b.txt"), "https://minio.internal:9000/llmhub/prod/a%20b.txt");
});

test("auto addressing picks path style off AWS, for IPs, and for dotted buckets", () => {
  const auto = (bucket: string, endpoint: string) => resolveAddressing({ addressing: "auto", bucket, endpoint });
  assert.equal(auto("llmhub", "https://minio.internal:9000"), "path");
  assert.equal(auto("llmhub", "http://127.0.0.1:9000"), "path");
  assert.equal(auto("my.bucket.name", "https://s3.amazonaws.com"), "path");
  assert.equal(auto("llmhub", "https://s3.eu-central-1.amazonaws.com"), "virtual-hosted");
  assert.equal(auto("llmhub", ""), "virtual-hosted");
  assert.equal(resolveAddressing({ addressing: "domain", bucket: "x", endpoint: "https://x" }), "domain");
});

test("s3FromParts needs a bucket and both keys and derives the endpoint", () => {
  assert.equal(s3FromParts({ bucket: "hub" }, {}), null);
  assert.equal(s3FromParts({ bucket: "" }, KEYS), null);
  const aws = s3FromParts({ bucket: "hub", prefix: "/prod/", region: "eu-west-1" }, KEYS);
  assert.equal(aws?.endpoint, "https://s3.eu-west-1.amazonaws.com");
  assert.equal(aws?.addressing, "virtual-hosted");
  assert.equal(aws?.prefix, "prod");
  const local = s3FromParts({ bucket: "hub", endpoint: "http://127.0.0.1:9000", region: "eu-central-1" }, KEYS);
  assert.equal(local?.endpoint, "http://127.0.0.1:9000");
  assert.equal(local?.addressing, "path");
  assert.equal("sessionToken" in (local ?? {}), false);
});

test("every storage preset fills a valid endpoint once its placeholders are replaced", () => {
  const ids = S3_PRESETS.map((preset) => preset.id);
  assert.deepEqual(ids, ["aws", "r2", "minio", "rustfs", "hetzner", "b2", "wasabi", "spaces", "scaleway", "ionos", "custom"]);
  assert.equal(s3Preset("r2").region, "auto");
  assert.equal(s3Preset("unknown").id, "custom");
  assert.equal(presetEndpoint(s3Preset("hetzner"), "nbg1"), "https://nbg1.your-objectstorage.com");
  assert.equal(presetEndpoint(s3Preset("aws"), ""), "https://s3.us-east-1.amazonaws.com");
  assert.equal(hasPlaceholder(presetEndpoint(s3Preset("r2"), "auto")), true);
  for (const preset of S3_PRESETS) {
    const endpoint = presetEndpoint(preset, preset.region).replace(/\{[^}]+\}/g, "acme");
    const parsed = storageSettingsSchema.safeParse({
      preset: preset.id,
      bucket: "llmhub",
      region: preset.region,
      endpoint,
      prefix: "",
      addressing: preset.addressing,
      public_base_url: "",
    });
    assert.equal(parsed.success, true, preset.id);
    assert.equal(preset.docs === "" || preset.docs.startsWith("https://"), true, preset.id);
  }
  const unreplaced = storageSettingsSchema.safeParse({
    preset: "r2",
    bucket: "llmhub",
    region: "auto",
    endpoint: presetEndpoint(s3Preset("r2"), "auto"),
    prefix: "",
    addressing: "path",
    public_base_url: "",
  });
  assert.equal(unreplaced.success, false);
});

test("storage probe failures map to stable codes without upstream text", () => {
  const xml = (code: string) => `<?xml version="1.0"?><Error><Code>${code}</Code><Message>secret detail</Message></Error>`;
  assert.deepEqual(s3ProbeCode(new S3Error(403, xml("InvalidAccessKeyId"))), { code: "AUTH", status: 403 });
  assert.deepEqual(s3ProbeCode(new S3Error(403, xml("SignatureDoesNotMatch"))), { code: "SIGNATURE", status: 403 });
  assert.deepEqual(s3ProbeCode(new S3Error(403, xml("AccessDenied"))), { code: "DENIED", status: 403 });
  assert.deepEqual(s3ProbeCode(new S3Error(404, xml("NoSuchBucket"))), { code: "NO_BUCKET", status: 404 });
  assert.deepEqual(s3ProbeCode(new S3Error(400, xml("AuthorizationHeaderMalformed"))), { code: "REGION", status: 400 });
  assert.deepEqual(s3ProbeCode(new S3Error(301, "")), { code: "REGION", status: 301 });
  assert.deepEqual(s3ProbeCode(new S3Error(403, "")), { code: "DENIED", status: 403 });
  assert.deepEqual(s3ProbeCode(new S3Error(500, "boom")), { code: "FAILED", status: 500 });
  assert.deepEqual(s3ProbeCode(new TypeError("fetch failed")), { code: "UNREACHABLE", status: null });
  assert.equal(new S3Error(403, xml("AccessDenied")).message.includes("secret detail"), false);
});

async function withFetch<T>(
  handler: (method: string, url: string, body: Buffer | null) => Response | Promise<Response>,
  run: () => Promise<T>,
) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
    handler(init?.method ?? "GET", String(input), init?.body ? Buffer.from(init.body as Buffer) : null)) as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

test("probeStorage writes, reads back, and deletes one object under the prefix", async () => {
  const runtime = s3FromParts({ bucket: "hub", endpoint: "http://127.0.0.1:9000", prefix: "prod" }, KEYS)!;
  const stored = new Map<string, Buffer>();
  const seen: string[] = [];
  const ok = await withFetch(
    (method, url, body) => {
      seen.push(`${method} ${new URL(url).pathname.replace(/[0-9a-f-]{36}/, "ID")}`);
      if (method === "PUT") stored.set(url, body ?? Buffer.alloc(0));
      if (method === "GET") return new Response(new Uint8Array(stored.get(url) ?? Buffer.alloc(0)));
      return new Response(null, { status: method === "PUT" ? 200 : 204 });
    },
    () => probeStorage(runtime),
  );
  assert.equal(ok.ok, true);
  assert.deepEqual(seen, [
    "PUT /hub/prod/llmhub-probe/ID.txt",
    "GET /hub/prod/llmhub-probe/ID.txt",
    "DELETE /hub/prod/llmhub-probe/ID.txt",
  ]);

  const denied = await withFetch(
    (method) =>
      method === "PUT"
        ? new Response("<Error><Code>AccessDenied</Code></Error>", { status: 403 })
        : new Response(null, { status: 500 }),
    () => probeStorage(runtime),
  );
  assert.deepEqual(denied, { ok: false, step: "put", code: "DENIED", status: 403 });

  const offline = await withFetch(
    () => {
      throw new TypeError("fetch failed");
    },
    () => probeStorage(runtime),
  );
  assert.deepEqual(offline, { ok: false, step: "put", code: "UNREACHABLE", status: null });
});

test("SigV4 authorization header is stable for a frozen timestamp", () => {
  const signed = authorizationHeader({
    method: "PUT",
    url: new URL("https://minio.internal:9000/llmhub/prod/files/a.json"),
    region: "us-east-1",
    accessKeyId: "AKIAEXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
    bodySha256: sha256Hex("hello"),
    now: new Date("2015-08-30T12:36:00.000Z"),
  });
  assert.match(signed.authorization, /^AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE\/20150830\/us-east-1\/s3\/aws4_request/);
  assert.match(signed.authorization, /SignedHeaders=host;x-amz-content-sha256;x-amz-date/);
  assert.match(signed.authorization, /Signature=[0-9a-f]{64}$/);
});
