import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  ATTACHMENT_MAX_BYTES,
  attachmentHeaders,
  attachmentRefOf,
  extractAttachments,
  sniffAttachmentType,
} from "@/lib/gateway/request-logs/log-attachments";
import { requestTranscript, responseTranscript } from "@/lib/gateway/request-logs/log-content";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(600, 1)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(600, 2)]);
const PDF = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(600, 3)]);
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

test("sniffAttachmentType trusts magic bytes, not the declared type", () => {
  assert.equal(sniffAttachmentType(PNG), "image/png");
  assert.equal(sniffAttachmentType(JPEG), "image/jpeg");
  assert.equal(sniffAttachmentType(PDF), "application/pdf");
  assert.equal(sniffAttachmentType(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'></svg>")), null);
  assert.equal(sniffAttachmentType(Buffer.from("<html><script>alert(1)</script></html>")), null);
});

test("extractAttachments replaces inline media in chat, Anthropic, and image answers with references", () => {
  const request = {
    messages: [
      { role: "user", content: [{ type: "image_url", image_url: { url: `data:image/png;base64,${PNG.toString("base64")}` } }] },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "t1",
            content: [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: JPEG.toString("base64") } }],
          },
          { type: "document", source: { type: "base64", media_type: "application/pdf", data: PDF.toString("base64") } },
          { type: "image_url", image_url: { url: `data:image/png;base64,${PNG.toString("base64")}` } },
        ],
      },
    ],
    note: "x".repeat(400),
    token: "A".repeat(400),
  };
  const response = { data: [{ b64_json: PNG.toString("base64") }] };
  const out = extractAttachments(request, response);
  assert.deepEqual(
    out.files.map((file) => [file.id, file.contentType]),
    [
      [sha(PNG), "image/png"],
      [sha(JPEG), "image/jpeg"],
      [sha(PDF), "application/pdf"],
    ],
  );
  const text = JSON.stringify(out.request);
  assert.ok(text.includes(`llmhub-attachment:${sha(PNG)};image/png`));
  assert.ok(text.includes(`llmhub-attachment:${sha(JPEG)};image/jpeg`));
  assert.equal((out.request as typeof request).note, request.note);
  assert.equal((out.request as typeof request).token, request.token);
  assert.equal((out.response as typeof response).data[0]?.b64_json, `llmhub-attachment:${sha(PNG)};image/png`);
  assert.equal(request.messages[0]?.content[0] && JSON.stringify(request).includes("llmhub-attachment"), false);
});

test("raw base64 counts only at the length the PII scan already skips", async () => {
  const { isOpaqueText } = await import("@/lib/gateway/safety/pii");
  const small = Buffer.concat([PNG.subarray(0, 8), Buffer.alloc(200, 4)]);
  assert.equal(extractAttachments({ data: small.toString("base64") }, null).files.length, 0);
  assert.equal(extractAttachments({ url: `data:image/png;base64,${small.toString("base64")}` }, null).files.length, 1);
  for (const bytes of [PNG, JPEG, PDF]) assert.equal(isOpaqueText(bytes.toString("base64")), true);
});

test("extractAttachments leaves oversized or unknown payloads alone", () => {
  const big = Buffer.concat([PNG.subarray(0, 8), Buffer.alloc(ATTACHMENT_MAX_BYTES + 10, 0)]);
  const out = extractAttachments({ image: `data:image/png;base64,${big.toString("base64")}` }, null);
  assert.equal(out.files.length, 0);
  const unknown = Buffer.alloc(900, 9).toString("base64");
  assert.equal(extractAttachments({ blob: unknown }, null).files.length, 0);
});

test("transcripts carry the stored attachment, including images inside tool results", () => {
  const { request, response } = extractAttachments(
    {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Look" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: PNG.toString("base64") } },
            {
              type: "tool_result",
              tool_use_id: "t1",
              content: [
                { type: "text", text: "screenshot" },
                { type: "image", source: { type: "base64", media_type: "image/jpeg", data: JPEG.toString("base64") } },
              ],
            },
          ],
        },
      ],
    },
    { output: [{ type: "image_generation_call", result: PNG.toString("base64") }] },
  );
  const input = requestTranscript(request);
  const media = input.filter((entry) => entry.kind === "media");
  assert.deepEqual(
    media.map((entry) => entry.attachment),
    [
      { id: sha(PNG), contentType: "image/png" },
      { id: sha(JPEG), contentType: "image/jpeg" },
    ],
  );
  const output = responseTranscript(response);
  assert.deepEqual(output.find((entry) => entry.kind === "media")?.attachment, { id: sha(PNG), contentType: "image/png" });
});

test("attachment references and response headers are strict", () => {
  assert.equal(attachmentRefOf(`llmhub-attachment:${sha(PNG)};image/png`)?.id, sha(PNG));
  assert.equal(attachmentRefOf("llmhub-attachment:../../etc;image/png"), null);
  assert.equal(attachmentRefOf(`llmhub-attachment:${sha(PNG)};text/html;x`), null);
  const image = attachmentHeaders(sha(PNG), "image/png");
  assert.equal(image["Content-Type"], "image/png");
  assert.match(image["Content-Disposition"] ?? "", /^inline;/);
  assert.equal(image["X-Content-Type-Options"], "nosniff");
  assert.match(image["Content-Security-Policy"] ?? "", /sandbox/);
  const pdf = attachmentHeaders(sha(PDF), "application/pdf");
  assert.match(pdf["Content-Disposition"] ?? "", /^attachment;/);
  assert.equal(attachmentHeaders(sha(PDF), "text/html")["Content-Type"], "application/octet-stream");
});
