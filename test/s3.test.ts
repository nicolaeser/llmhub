import assert from "node:assert/strict";
import test from "node:test";
import { s3FromParts } from "@/lib/s3/config";
import { authorizationHeader, sha256Hex } from "@/lib/s3/sign";
import {
  joinKey,
  objectUrl,
  publicObjectUrl,
  resolveAddressing
} from "@/lib/s3/url";
import type { S3Location } from "@/types/s3";

test("joinKey keeps nested paths and drops empty segments", () => {
  assert.equal(joinKey("llmhub/", "/files/", "id", "a.json"), "llmhub/files/id/a.json");
  assert.equal(joinKey("a/../b", "c"), "b/c");
});


test("path-style vs virtual-hosted vs domain bucket URLs", () => {
  const pathLoc: S3Location = {
    bucket: "llmhub",
    region: "eu-central-1",
    endpoint: "https://minio.internal:9000",
    prefix: "prod",
    addressing: "path",
    domainBucket: false,
    publicBaseUrl: "",
  };
  assert.equal(
    objectUrl(pathLoc, "files/id/a.json").toString(),
    "https://minio.internal:9000/llmhub/prod/files/id/a.json",
  );

  const vhost: S3Location = {
    bucket: "llmhub",
    region: "eu-central-1",
    endpoint: "https://s3.eu-central-1.amazonaws.com",
    prefix: "prod",
    addressing: "virtual-hosted",
    domainBucket: false,
    publicBaseUrl: "",
  };
  assert.equal(
    objectUrl(vhost, "files/id/a.json").hostname,
    "llmhub.s3.eu-central-1.amazonaws.com",
  );
  assert.match(objectUrl(vhost, "files/id/a.json").pathname, /\/prod\/files\/id\/a\.json$/);

  const domain: S3Location = {
    bucket: "files.example.com",
    region: "us-east-1",
    endpoint: "https://files.example.com",
    prefix: "hub",
    addressing: "virtual-hosted",
    domainBucket: true,
    publicBaseUrl: "https://files.example.com/assets",
  };
  assert.equal(
    objectUrl(domain, "videos/1/clip.mp4").toString(),
    "https://files.example.com/assets/hub/videos/1/clip.mp4",
  );
  assert.equal(
    publicObjectUrl(domain, "videos/1/clip.mp4"),
    "https://files.example.com/assets/hub/videos/1/clip.mp4",
  );
});

test("auto addressing: custom endpoint and dotted buckets use path style", () => {
  assert.equal(
    resolveAddressing({
      addressing: "auto",
      bucket: "llmhub",
      endpoint: "https://minio.internal:9000",
    }),
    "path",
  );
  assert.equal(
    resolveAddressing({
      addressing: "auto",
      bucket: "my.bucket.name",
      endpoint: "https://s3.amazonaws.com",
    }),
    "path",
  );
  assert.equal(
    resolveAddressing({
      addressing: "auto",
      bucket: "llmhub",
      endpoint: "https://s3.eu-central-1.amazonaws.com",
    }),
    "virtual-hosted",
  );
  assert.equal(
    resolveAddressing({
      domainBucket: true,
      bucket: "files.example.com",
      endpoint: "https://files.example.com",
    }),
    "virtual-hosted",
  );
});

test("s3FromParts requires bucket and credentials", () => {
  assert.equal(
    s3FromParts({ enabled: true, bucket: "hub" }, {}),
    null,
  );
  const runtime = s3FromParts(
    { enabled: true, bucket: "hub", prefix: "prod", addressing: "path" },
    { S3_ACCESS_KEY_ID: "AKIAEXAMPLE", S3_SECRET_ACCESS_KEY: "secret" },
  );
  assert.ok(runtime);
  assert.equal(runtime?.addressing, "path");
  assert.equal(runtime?.prefix, "prod");
  assert.equal(runtime?.region, "us-east-1");
  const local = s3FromParts(
    { enabled: true, bucket: "hub", endpoint: "http://127.0.0.1:9000", region: "eu-central-1" },
    { S3_ACCESS_KEY_ID: "llmhub", S3_SECRET_ACCESS_KEY: "llmhubrustfs" },
  );
  assert.equal(local?.accessKeyId, "llmhub");
  assert.equal(local?.endpoint, "http://127.0.0.1:9000");
  assert.equal(local?.region, "eu-central-1");
  assert.equal(
    s3FromParts({ enabled: false, bucket: "hub" }, { S3_ACCESS_KEY_ID: "a", S3_SECRET_ACCESS_KEY: "b" }),
    null,
  );
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
