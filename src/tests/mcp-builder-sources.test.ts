import { chatReply, gateway, MODEL, resetGateway } from "./support/gateway-harness";
import { recordedPrisma } from "./support/recorded-prisma";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { runAsPrincipal } from "@/lib/auth/delegation";
import { McpSourceError } from "@/lib/mcp/errors";
import { BUILDER_MODEL_KEY, MAX_BUILDER_FILE_BYTES } from "@/schemas/mcp";
import type { AuthenticatedSession, Permission } from "@/types/auth";
import type { JsonMap } from "@/types/gateway";
import type { McpBuilderUpload, McpDraft } from "@/types/mcp";

const BEARER = "bearer-SECRET-7f3a";
const QUERY = "query-SECRET-91bc";
const PASSWORD = "basic-SECRET-c0de";
const SECRETS = [BEARER, QUERY, PASSWORD, Buffer.from(`reader:${PASSWORD}`).toString("base64")];

const DRAFT = JSON.stringify({
  name: "Pets",
  description: "Pet API",
  baseUrl: "https://api.pets.example/v1",
  internal: false,
  authType: "bearer",
  authHeader: "",
  notes: "",
  tools: [
    {
      name: "list_pets",
      title: "List pets",
      description: "Lists pets.",
      action: "read",
      method: "GET",
      path: "/pets",
      query: [],
      inputSchema: { type: "object", properties: {} },
    },
  ],
});

const SPEC = JSON.stringify({
  openapi: "3.1.0",
  info: { title: "Linked Pets" },
  servers: [{ url: "/v2" }],
  paths: { "/pets": { get: { operationId: "listPets", summary: "List pets" } } },
});

const YAML_SPEC = `openapi: 3.0.3
info:
  title: Uploaded Orders
servers:
  - url: https://orders.example.com/api
paths:
  /orders:
    get:
      operationId: listOrders
      summary: List orders
`;

let port = 0;
const docRequests: { path: string; authorization: string }[] = [];
const server: Server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  docRequests.push({ path: url.pathname, authorization: String(req.headers.authorization ?? "") });
  const bearer = req.headers.authorization === `Bearer ${BEARER}`;
  const basic = req.headers.authorization === `Basic ${Buffer.from(`reader:${PASSWORD}`).toString("base64")}`;
  if (url.pathname === "/guide" && bearer) {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<html><body><h1>Pets guide</h1><p>GET /pets lists every pet.</p></body></html>");
    return;
  }
  if (url.pathname === "/reference" && url.searchParams.get("api_key") === QUERY) {
    res.writeHead(200, { "content-type": "text/markdown" });
    res.end("# Reference\n\nPOST /pets creates a pet.");
    return;
  }
  if (url.pathname === "/openapi.json" && basic) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(SPEC);
    return;
  }
  if (url.pathname === "/manual.pdf" && bearer) {
    res.writeHead(200, { "content-type": "application/pdf" });
    res.end("%PDF-1.4 manual");
    return;
  }
  res.writeHead(401, { "www-authenticate": "Bearer" });
  res.end("sign in first");
});

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

after(() => {
  server.close();
});

function operator(permissions: Permission[]): AuthenticatedSession {
  return {
    error: false,
    sessionId: "",
    user: { id: "u1", username: "ops", email: "ops@example.com" } as AuthenticatedSession["user"],
    isOwner: false,
    role: null,
    permissions,
    secondFactor: "MANAGEMENT_KEY",
    ipAddress: null,
    userAgent: null,
  };
}

const manager = operator(["settings:manage"]);
const logs: string[] = [];
const original = { log: console.log, error: console.error, warn: console.warn };

function prepare(reply: (body: JsonMap) => Response = () => chatReply(DRAFT)) {
  resetGateway();
  docRequests.length = 0;
  logs.length = 0;
  recordedPrisma.reset({
    setting: {
      findUnique: ({ where }: { where: { key: string } }) => (where.key === BUILDER_MODEL_KEY ? { key: where.key, value: MODEL } : null),
    },
  });
  gateway.reply = (call) => reply(call.body ?? {});
}

async function draft(raw: JsonMap, uploads: McpBuilderUpload[] = []): Promise<McpDraft> {
  const { draftMcpServer } = await import("@/lib/mcp/builder");
  console.log = (...args: unknown[]) => void logs.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) => void logs.push(args.map(String).join(" "));
  console.warn = (...args: unknown[]) => void logs.push(args.map(String).join(" "));
  try {
    return await runAsPrincipal(manager, () => draftMcpServer(raw, uploads));
  } finally {
    Object.assign(console, original);
  }
}

function upload(name: string, type: string, content: string | Uint8Array): McpBuilderUpload {
  return { name, type, bytes: typeof content === "string" ? new TextEncoder().encode(content) : content };
}

function link(path: string, auth: JsonMap): JsonMap {
  return { url: `http://127.0.0.1:${port}${path}`, internal: true, ...auth };
}

function assertNothingStored() {
  const writes = recordedPrisma.calls.filter((call) => !/^(find|count|aggregate|groupBy)/.test(call.method));
  assert.deepEqual(writes, []);
}

function assertNoSecret(label: string, value: unknown) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  for (const secret of SECRETS) assert.equal(text.includes(secret), false, `${label} contains a credential`);
}

async function rejection(work: Promise<unknown>): Promise<Error> {
  try {
    await work;
  } catch (err) {
    assert.ok(err instanceof Error);
    return err;
  }
  assert.fail("expected the draft to fail");
}

test("every source reaches the model in labeled sections while credentials stay with the docs server", async () => {
  prepare();
  const result = await draft(
    {
      template: "readonly",
      instruction: "Build the read operations.",
      docs: "Pasted note: GET /owners lists owners.",
      links: [link("/guide", { auth: "bearer", secret: BEARER }), link("/reference", { auth: "query", name: "api_key", secret: QUERY })],
    },
    [
      upload("notes.md", "text/markdown", "# Notes\n\nDELETE /pets/{id} removes a pet."),
      upload("manual.pdf", "application/pdf", "%PDF-1.4 uploaded"),
      upload("diagram.png", "image/png", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])),
    ],
  );
  assert.equal(result.source, "model");
  assert.deepEqual(result.tools.map((tool) => tool.name), ["list_pets"]);
  assert.equal(result.importedFrom, null);
  assert.equal(gateway.upstream.length, 1);
  const body = gateway.upstream[0]!.body!;
  const user = (body.messages as JsonMap[])[1]!;
  const parts = user.content as JsonMap[];
  assert.ok(Array.isArray(parts));
  const text = String(parts[0]!.text);
  assert.match(text, new RegExp(`Source 1: 127\\.0\\.0\\.1:${port}\\nPets guide`));
  assert.match(text, new RegExp(`Source 2: 127\\.0\\.0\\.1:${port}\\n# Reference`));
  assert.match(text, /Source 3: pasted text\nPasted note/);
  assert.match(text, /Source 4: notes\.md\n# Notes/);
  assert.equal(parts[1]!.text, "Source 5: manual.pdf (attached file)");
  assert.deepEqual(parts[2], {
    type: "file",
    file: { filename: "manual.pdf", file_data: `data:application/pdf;base64,${Buffer.from("%PDF-1.4 uploaded").toString("base64")}` },
  });
  assert.equal(parts[3]!.text, "Source 6: diagram.png (attached file)");
  assert.equal(parts[4]!.type, "image_url");
  assert.match(String((parts[4]!.image_url as JsonMap).url), /^data:image\/png;base64,/);
  assert.deepEqual(
    docRequests.map((request) => request.path),
    ["/guide", "/reference"],
  );
  assertNoSecret("model request", gateway.upstream);
  assertNoSecret("draft", result);
  assertNoSecret("logs", logs);
  assertNothingStored();
});

test("an OpenAPI document in any source is imported and the other sources are reported", async () => {
  prepare();
  const result = await draft(
    {
      template: "readonly",
      instruction: "Build the read operations.",
      docs: "Some prose about the API.",
      links: [link("/guide", { auth: "bearer", secret: BEARER })],
    },
    [upload("orders.yaml", "application/yaml", YAML_SPEC), upload("other.json", "application/json", SPEC)],
  );
  assert.equal(result.source, "openapi");
  assert.equal(result.name, "Uploaded Orders");
  assert.equal(result.baseUrl, "https://orders.example.com/api");
  assert.deepEqual(result.importedFrom, { kind: "file", name: "orders.yaml" });
  assert.deepEqual(result.unused, [
    { kind: "link", name: `127.0.0.1:${port}` },
    { kind: "text", name: "" },
    { kind: "file", name: "other.json" },
  ]);
  assert.equal(gateway.upstream.length, 0);
  assertNothingStored();

  prepare();
  const linked = await draft({
    template: "readonly",
    instruction: "Build the read operations.",
    links: [link("/openapi.json?lang=en", { auth: "basic", name: "reader", secret: PASSWORD })],
  });
  assert.equal(linked.source, "openapi");
  assert.equal(linked.baseUrl, `http://127.0.0.1:${port}/v2`);
  assert.equal(linked.internal, true);
  assert.deepEqual(linked.importedFrom, { kind: "link", name: `127.0.0.1:${port}` });
  assertNoSecret("draft", linked);
});

test("a pasted single link still loads like before", async () => {
  prepare();
  await assert.rejects(
    draft({ template: "readonly", instruction: "x", docs: `http://127.0.0.1:${port}/guide` }),
    (err: unknown) => err instanceof McpSourceError && err.message === "MCP_URL_INSECURE" && err.pointer === "#/docs",
  );
  assert.equal(docRequests.length, 0);
});

test("a rejected credential answers MCP_BUILDER_FETCH_AUTH for that link without echoing it", async () => {
  prepare();
  const err = await rejection(
    draft({
      template: "readonly",
      instruction: "x",
      links: [link("/reference", { auth: "query", name: "api_key", secret: QUERY }), link("/guide", { auth: "bearer", secret: `${BEARER}-old` })],
    }),
  );
  assert.ok(err instanceof McpSourceError);
  assert.equal(err.message, "MCP_BUILDER_FETCH_AUTH");
  assert.equal(err.pointer, "#/links/1");
  assert.equal(err.cause, undefined);
  assertNoSecret("error", `${err.message} ${err.stack} ${JSON.stringify(err)}`);
  assertNoSecret("logs", logs);
  assert.equal(gateway.upstream.length, 0);
  assertNothingStored();
});

test("a linked PDF behind a sign-in is passed to the model as a file", async () => {
  prepare();
  await draft({ template: "readonly", instruction: "x", links: [link("/manual.pdf", { auth: "bearer", secret: BEARER })] });
  const parts = ((gateway.upstream[0]!.body!.messages as JsonMap[])[1]!.content as JsonMap[]).map((part) => part.type);
  assert.deepEqual(parts, ["text", "text", "file"]);
  assertNoSecret("model request", gateway.upstream);
});

test("uploads are limited in number, size, and type", async () => {
  prepare();
  const small = upload("a.md", "text/markdown", "# a");
  const base = { template: "readonly", instruction: "x" };
  await assert.rejects(draft(base, Array.from({ length: 11 }, () => small)), /^Error: MCP_BUILDER_FILES_COUNT$/);
  const big = upload("big.pdf", "application/pdf", new Uint8Array(MAX_BUILDER_FILE_BYTES + 1));
  await assert.rejects(
    draft(base, [small, big]),
    (err: unknown) => err instanceof McpSourceError && err.message === "MCP_BUILDER_FILE_SIZE" && err.pointer === "#/files/1",
  );
  const eight = new Uint8Array(8 * 1024 * 1024).fill(0x61);
  await assert.rejects(
    draft(base, [upload("1.txt", "text/plain", eight), upload("2.txt", "text/plain", eight), upload("3.txt", "text/plain", eight)]),
    /^Error: MCP_BUILDER_FILES_SIZE$/,
  );
  for (const unsupported of [
    upload("tool.exe", "application/octet-stream", new Uint8Array([0x4d, 0x5a, 0, 0, 1])),
    upload("scan.tiff", "image/tiff", new Uint8Array([0x49, 0x49, 0x2a, 0])),
    upload("empty.md", "text/markdown", ""),
    upload("legacy.doc", "application/msword", "binary"),
  ]) {
    await assert.rejects(
      draft(base, [small, unsupported]),
      (err: unknown) => err instanceof McpSourceError && err.message === "MCP_BUILDER_FILE_UNSUPPORTED" && err.pointer === "#/files/1",
      unsupported.name,
    );
  }
  await assert.rejects(draft(base), /^Error: VALIDATION$/);
  assert.equal(gateway.upstream.length, 0);
  assertNothingStored();
});

test("the draft route rejects cross-site posts and missing sessions before it reads the upload", async () => {
  const { POST } = await import("@/app/internal-api/mcp/draft/route");
  const form = () => {
    const body = new FormData();
    body.append("request", JSON.stringify({ instruction: "x", links: [link("/guide", { auth: "bearer", secret: BEARER })] }));
    body.append("file", new Blob(["# doc"]), "doc.md");
    return body;
  };
  const crossSite = new Request("http://localhost:3000/internal-api/mcp/draft", {
    method: "POST",
    body: form(),
    headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site" },
  });
  const res = await POST(crossSite);
  assert.equal(res.status, 403);
  assert.equal((await res.json()).code, "FORBIDDEN");
  assert.equal(crossSite.bodyUsed, false);
  const anonymous = new Request("http://localhost:3000/internal-api/mcp/draft", { method: "POST", body: form() });
  const answer = await POST(anonymous).catch(() => null);
  assert.ok(answer === null || answer.status === 401);
  assert.equal(anonymous.bodyUsed, false);
  assert.equal(docRequests.length, 0);
});

test("readForm caps the streamed body and only parses multipart", async () => {
  const { isPayloadTooLarge, readForm } = await import("@/lib/http/api");
  const form = new FormData();
  form.append("request", "{}");
  form.append("file", new Blob([new Uint8Array(4096)]), "a.md");
  const encoded = new Response(form);
  const contentType = encoded.headers.get("content-type") ?? "";
  const bytes = new Uint8Array(await encoded.arrayBuffer());
  const multipart = () =>
    new Request("http://hub.local/internal-api/mcp/draft", { method: "POST", body: bytes, headers: { "content-type": contentType } });
  await assert.rejects(readForm(multipart(), 1024), (err: unknown) => isPayloadTooLarge(err));
  const parsed = await readForm(multipart(), 64 * 1024);
  assert.equal(parsed.get("request"), "{}");
  assert.equal((parsed.get("file") as File).size, 4096);
  const json = new Request("http://hub.local/x", { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
  await assert.rejects(readForm(json, 1024), /^Error: UNSUPPORTED_MEDIA_TYPE$/);
});

test("a model that rejects file parts answers MCP_BUILDER_MODEL_FILES", async () => {
  const pdf = [upload("manual.pdf", "application/pdf", "%PDF-1.4 x")];
  const reject = (message: string) => () => Response.json({ error: { message, type: "invalid_request_error" } }, { status: 400 });
  prepare(reject("Invalid content type. image_url and file are not supported for this model."));
  await assert.rejects(draft({ template: "readonly", instruction: "x" }, pdf), /^Error: MCP_BUILDER_MODEL_FILES$/);
  prepare(reject("Invalid request."));
  await assert.rejects(draft({ template: "readonly", instruction: "x", docs: "GET /pets" }), /^Error: MCP_BUILDER_DRAFT$/);
  prepare(reject("This model's maximum context length is 8192 tokens."));
  await assert.rejects(draft({ template: "readonly", instruction: "x" }, pdf), /^Error: MCP_BUILDER_DOCS_LONG$/);
  assertNothingStored();
});
