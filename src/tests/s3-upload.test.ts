import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test, { afterEach } from "node:test";
import { completeMultipartBody, contentMd5, isTransientS3Error, s3UploadStream } from "@/lib/s3/upload";
import { S3Error } from "@/lib/s3/client";
import type { S3Runtime } from "@/types/s3";

type Call = { method: string; url: URL; headers: Headers; body: Buffer };

const RUNTIME: S3Runtime = {
  bucket: "archive",
  region: "eu-central-1",
  endpoint: "https://s3.example.test",
  prefix: "llmhub",
  addressing: "path",
  publicBaseUrl: "",
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: "secret",
};

const MIB = 1024 * 1024;
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubFetch(answer: (call: Call, index: number) => Response): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const call = {
      method: init?.method ?? "GET",
      url: new URL(String(input)),
      headers: new Headers(init?.headers),
      body: init?.body ? Buffer.from(init.body as Uint8Array) : Buffer.alloc(0),
    };
    calls.push(call);
    return answer(call, calls.length - 1);
  }) as typeof fetch;
  return calls;
}

function s3Ok(call: Call): Response {
  if (call.method === "POST" && call.url.searchParams.has("uploads")) {
    return new Response("<InitiateMultipartUploadResult><UploadId>up-1</UploadId></InitiateMultipartUploadResult>");
  }
  if (call.method === "PUT" && call.url.searchParams.has("partNumber")) {
    return new Response(null, { headers: { etag: `"etag-${call.url.searchParams.get("partNumber")}"` } });
  }
  if (call.method === "POST" && call.url.searchParams.has("uploadId")) {
    return new Response("<CompleteMultipartUploadResult><ETag>\"final\"</ETag></CompleteMultipartUploadResult>");
  }
  return new Response(null, { status: call.method === "DELETE" ? 204 : 200 });
}

async function* chunks(total: number, size: number): AsyncGenerator<Buffer> {
  for (let offset = 0; offset < total; offset += size) yield Buffer.alloc(Math.min(size, total - offset), offset % 251);
}

test("a small body goes up in one PUT with Content-MD5 and the object lock headers", async () => {
  const calls = stubFetch(s3Ok);
  const body = Buffer.from("hello archive\n");
  const result = await s3UploadStream(RUNTIME, "compliance/requests.jsonl", [body], {
    contentType: "application/x-ndjson",
    headers: { "x-amz-object-lock-mode": "COMPLIANCE", "x-amz-object-lock-retain-until-date": "2027-11-11T00:00:00.000Z" },
  });
  assert.equal(calls.length, 1);
  const [put] = calls;
  assert.equal(put.method, "PUT");
  assert.equal(put.url.pathname, "/archive/llmhub/compliance/requests.jsonl");
  assert.equal(put.headers.get("content-md5"), contentMd5(body));
  assert.equal(put.headers.get("x-amz-object-lock-mode"), "COMPLIANCE");
  assert.equal(put.headers.get("content-type"), "application/x-ndjson");
  assert.match(put.headers.get("authorization") ?? "", /SignedHeaders=[^,]*content-md5[^,]*x-amz-object-lock-mode/);
  assert.deepEqual(result, { bytes: body.length, sha256: createHash("sha256").update(body).digest("hex"), parts: 1 });
});

test("a large body uses a multipart upload with one MD5 per part and lock headers on create", async () => {
  const calls = stubFetch(s3Ok);
  const total = 12 * MIB + 123;
  const result = await s3UploadStream(RUNTIME, "big.zip", chunks(total, 256 * 1024), {
    contentType: "application/zip",
    headers: { "x-amz-object-lock-mode": "GOVERNANCE", "x-amz-object-lock-retain-until-date": "2027-01-01T00:00:00.000Z" },
    partBytes: 5 * MIB,
  });
  const kinds = calls.map((call) => `${call.method} ${[...call.url.searchParams.keys()].sort().join(",")}`);
  assert.deepEqual(kinds, ["POST uploads", "PUT partNumber,uploadId", "PUT partNumber,uploadId", "PUT partNumber,uploadId", "POST uploadId"]);
  assert.equal(calls[0].headers.get("x-amz-object-lock-mode"), "GOVERNANCE");
  assert.equal(calls[0].headers.get("content-type"), "application/zip");
  const parts = calls.filter((call) => call.url.searchParams.has("partNumber"));
  assert.deepEqual(parts.map((call) => call.url.searchParams.get("partNumber")), ["1", "2", "3"]);
  for (const part of parts) assert.equal(part.headers.get("content-md5"), contentMd5(part.body));
  assert.equal(parts.reduce((sum, part) => sum + part.body.length, 0), total);
  assert.equal(calls[4].body.toString(), completeMultipartBody(['"etag-1"', '"etag-2"', '"etag-3"']));
  assert.equal(result.bytes, total);
  assert.equal(result.parts, 3);
  const expected = createHash("sha256");
  for await (const chunk of chunks(total, 256 * 1024)) expected.update(chunk);
  assert.equal(result.sha256, expected.digest("hex"));
});

test("a failed part aborts the multipart upload and keeps the S3 error", async () => {
  const calls = stubFetch((call) =>
    call.method === "PUT" && call.url.searchParams.get("partNumber") === "2"
      ? new Response("<Error><Code>AccessDenied</Code></Error>", { status: 403 })
      : s3Ok(call),
  );
  await assert.rejects(
    s3UploadStream(RUNTIME, "big.zip", chunks(11 * MIB, MIB), { contentType: "application/zip", partBytes: 5 * MIB, retryBaseMs: 1 }),
    (err) => err instanceof S3Error && err.code === "AccessDenied",
  );
  const last = calls[calls.length - 1];
  assert.equal(last.method, "DELETE");
  assert.equal(last.url.searchParams.get("uploadId"), "up-1");
});

test("an error document inside a 200 complete answer fails the upload", async () => {
  stubFetch((call) =>
    call.method === "POST" && call.url.searchParams.has("uploadId")
      ? new Response("<Error><Code>InternalError</Code></Error>")
      : s3Ok(call),
  );
  await assert.rejects(
    s3UploadStream(RUNTIME, "big.zip", chunks(6 * MIB, MIB), { contentType: "application/zip", partBytes: 5 * MIB, retryBaseMs: 1 }),
    (err) => err instanceof S3Error && err.code === "InternalError",
  );
});

test("transient answers are retried and permanent ones are not", async () => {
  let failures = 0;
  const calls = stubFetch((call) => {
    if (call.method === "PUT" && failures < 2) {
      failures += 1;
      return new Response("<Error><Code>SlowDown</Code></Error>", { status: 503 });
    }
    return s3Ok(call);
  });
  await s3UploadStream(RUNTIME, "small.jsonl", [Buffer.from("x")], { contentType: "text/plain", retryBaseMs: 1 });
  assert.equal(calls.length, 3);
  assert.equal(isTransientS3Error(new S3Error(503, "<Code>SlowDown</Code>")), true);
  assert.equal(isTransientS3Error(new S3Error(403, "<Code>AccessDenied</Code>")), false);
  assert.equal(isTransientS3Error(new TypeError("fetch failed")), true);
});

test("ETags are escaped in the completion document", () => {
  assert.equal(
    completeMultipartBody(['"a&b"']),
    '<CompleteMultipartUpload xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Part><PartNumber>1</PartNumber><ETag>&quot;a&amp;b&quot;</ETag></Part></CompleteMultipartUpload>',
  );
});
