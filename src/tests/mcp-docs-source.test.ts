import assert from "node:assert/strict";
import test from "node:test";
import { MAX_LINKED_DOCS_BYTES, docsLink, fetchDocs, htmlText } from "@/lib/mcp/docs-source";
import type { McpFetch } from "@/types/mcp";

test("docsLink accepts one http link and nothing else", () => {
  assert.equal(docsLink("  https://api.example.com/openapi.json \n"), "https://api.example.com/openapi.json");
  assert.equal(docsLink("https://a.example.com/x https://b.example.com/y"), null);
  assert.equal(docsLink("openapi: 3.1.0"), null);
  assert.equal(docsLink("ftp://example.com/spec"), null);
});

test("htmlText keeps readable text and drops scripts and styles", () => {
  const text = htmlText(`<!doctype html><html><head><title>x</title><style>p{}</style></head>
<body><h1>Pets&nbsp;API</h1><script>alert(1)</script><svg/><p>GET <code>/pets?limit=10</code> lists pets &amp; owners.</p>
<ul><li>POST /pets</li><li>DELETE /pets/{id} &#8594; gone</li></ul></body></html>`);
  assert.equal(text, "Pets API\n\nGET /pets?limit=10 lists pets & owners.\n\nPOST /pets\n\nDELETE /pets/{id} → gone");
});

test("fetchDocs follows redirects, converts HTML, and enforces the size limit", async () => {
  const seen: string[] = [];
  const fetchImpl: McpFetch = async (url) => {
    seen.push(url);
    if (url.endsWith("/start")) return new Response(null, { status: 302, headers: { location: "/spec" } });
    if (url.endsWith("/spec")) return new Response('{"openapi":"3.1.0"}', { status: 200, headers: { "content-type": "application/json" } });
    if (url.endsWith("/page")) return new Response("<p>Hello <b>docs</b></p>", { status: 200, headers: { "content-type": "text/html" } });
    if (url.endsWith("/huge")) return new Response("x", { status: 200, headers: { "content-length": String(MAX_LINKED_DOCS_BYTES + 1) } });
    return new Response("missing", { status: 404 });
  };
  assert.equal(await fetchDocs("https://docs.example.com/start", fetchImpl), '{"openapi":"3.1.0"}');
  assert.deepEqual(seen, ["https://docs.example.com/start", "https://docs.example.com/spec"]);
  assert.equal(await fetchDocs("https://docs.example.com/page", fetchImpl), "Hello docs");
  await assert.rejects(fetchDocs("https://docs.example.com/huge", fetchImpl), /MCP_BUILDER_FETCH_SIZE/);
  await assert.rejects(fetchDocs("https://docs.example.com/gone", fetchImpl), /MCP_BUILDER_FETCH/);
  const loop: McpFetch = async () => new Response(null, { status: 301, headers: { location: "/again" } });
  await assert.rejects(fetchDocs("https://docs.example.com/again", loop), /MCP_BUILDER_FETCH/);
});
