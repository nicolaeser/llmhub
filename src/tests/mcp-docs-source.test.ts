import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";
import { MAX_LINKED_DOCS_BYTES, docsLink, fetchDocs, htmlText, linkedText } from "@/lib/mcp/docs-source";
import { guardedFetch } from "@/lib/mcp/transport";
import { builderDraftSchema, builderLinkSchema } from "@/schemas/mcp";
import type { McpDocsAuth, McpFetch } from "@/types/mcp";

type Seen = { url: string; headers: Record<string, string> };
type Answer = { status: number; headers?: Record<string, string>; body?: string };

function recorder(answer: (url: string) => Response): { fetchImpl: McpFetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const fetchImpl: McpFetch = async (url, init) => {
    seen.push({ url, headers: init.headers });
    return answer(url);
  };
  return { fetchImpl, seen };
}

function header(seen: Seen, name: string): string | undefined {
  return Object.entries(seen.headers).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
}

const servers: Server[] = [];

async function listen(handler: (path: string, headers: IncomingHttpHeaders) => Answer) {
  const requests: { path: string; headers: IncomingHttpHeaders }[] = [];
  const server = createServer((req, res) => {
    const path = req.url ?? "/";
    requests.push({ path, headers: req.headers });
    const answer = handler(path, req.headers);
    res.writeHead(answer.status, answer.headers ?? {});
    res.end(answer.body ?? "");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  return { port: (server.address() as AddressInfo).port, requests };
}

after(() => {
  for (const server of servers) server.close();
});

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
  const { fetchImpl, seen } = recorder((url) => {
    if (url.endsWith("/start")) return new Response(null, { status: 302, headers: { location: "/spec" } });
    if (url.endsWith("/spec")) return new Response('{"openapi":"3.1.0"}', { status: 200, headers: { "content-type": "application/json" } });
    if (url.endsWith("/page")) return new Response("<p>Hello <b>docs</b></p>", { status: 200, headers: { "content-type": "text/html" } });
    if (url.endsWith("/huge")) return new Response("x", { status: 200, headers: { "content-length": String(MAX_LINKED_DOCS_BYTES + 1) } });
    return new Response("missing", { status: 404 });
  });
  const spec = await fetchDocs("https://docs.example.com/start", fetchImpl);
  assert.equal(linkedText(spec), '{"openapi":"3.1.0"}');
  assert.equal(spec.url, "https://docs.example.com/spec");
  assert.deepEqual(
    seen.map((call) => call.url),
    ["https://docs.example.com/start", "https://docs.example.com/spec"],
  );
  assert.equal(linkedText(await fetchDocs("https://docs.example.com/page#intro", fetchImpl)), "Hello docs");
  assert.equal(seen.at(-1)?.url, "https://docs.example.com/page");
  await assert.rejects(fetchDocs("https://docs.example.com/huge", fetchImpl), /MCP_BUILDER_FETCH_SIZE/);
  await assert.rejects(fetchDocs("https://docs.example.com/gone", fetchImpl), /^Error: MCP_BUILDER_FETCH$/);
  const loop = recorder(() => new Response(null, { status: 301, headers: { location: "/again" } }));
  await assert.rejects(fetchDocs("https://docs.example.com/again", loop.fetchImpl), /^Error: MCP_BUILDER_FETCH$/);
});

test("fetchDocs sends bearer, basic, custom header, and query credentials", async () => {
  const ok = () => new Response("docs", { status: 200, headers: { "content-type": "text/plain" } });
  const bearer = recorder(ok);
  await fetchDocs("https://docs.example.com/a", bearer.fetchImpl, { type: "bearer", name: "", secret: "tok-123" });
  assert.equal(header(bearer.seen[0]!, "authorization"), "Bearer tok-123");

  const basic = recorder(ok);
  await fetchDocs("https://docs.example.com/a", basic.fetchImpl, { type: "basic", name: "jürgen", secret: "pä:ss" });
  const encoded = header(basic.seen[0]!, "authorization") ?? "";
  assert.match(encoded, /^Basic /);
  assert.equal(Buffer.from(encoded.slice(6), "base64").toString("utf8"), "jürgen:pä:ss");

  const custom = recorder(ok);
  await fetchDocs("https://docs.example.com/a", custom.fetchImpl, { type: "header", name: "accept", secret: "text/markdown" });
  await fetchDocs("https://docs.example.com/a", custom.fetchImpl, { type: "header", name: "Cookie", secret: "session=abc; theme=dark" });
  assert.equal(header(custom.seen[0]!, "accept"), "text/markdown");
  assert.equal(Object.keys(custom.seen[0]!.headers).filter((key) => key.toLowerCase() === "accept").length, 1);
  assert.equal(header(custom.seen[1]!, "cookie"), "session=abc; theme=dark");

  const query = recorder(ok);
  await fetchDocs("https://docs.example.com/a?lang=en", query.fetchImpl, { type: "query", name: "api_key", secret: "k&y=1" });
  const sent = new URL(query.seen[0]!.url);
  assert.equal(sent.searchParams.get("api_key"), "k&y=1");
  assert.equal(sent.searchParams.get("lang"), "en");
  assert.equal(header(query.seen[0]!, "authorization"), undefined);
});

test("credentials only follow redirects on the same site and never downgrade to http", async () => {
  const auths: McpDocsAuth[] = [
    { type: "bearer", name: "", secret: "tok-SECRET" },
    { type: "basic", name: "user", secret: "pw-SECRET" },
    { type: "header", name: "X-Api-Key", secret: "hdr-SECRET" },
    { type: "query", name: "key", secret: "q-SECRET" },
  ];
  const carries = (call: Seen, auth: McpDocsAuth) => {
    const basic = Buffer.from(`${auth.name}:${auth.secret}`, "utf8").toString("base64");
    const text = `${call.url} ${JSON.stringify(call.headers)}`;
    return text.includes(auth.secret) || text.includes(basic) || header(call, "authorization") !== undefined || header(call, "x-api-key") !== undefined;
  };
  for (const auth of auths) {
    const echoed = auth.type === "query" ? auth.secret : "public";
    const hops = recorder((url) => {
      const path = new URL(url).pathname;
      if (path === "/start") return new Response(null, { status: 302, headers: { location: "/same" } });
      if (path === "/same") return new Response(null, { status: 302, headers: { location: `https://cdn.example.net/other?key=${echoed}` } });
      if (url.startsWith("https://cdn.example.net/other")) return new Response(null, { status: 302, headers: { location: "http://docs.example.com/plain" } });
      return new Response("done", { status: 200 });
    });
    await fetchDocs("https://docs.example.com/start", hops.fetchImpl, auth);
    assert.equal(hops.seen.length, 4);
    const [first, same, other, plain] = hops.seen;
    for (const trusted of [first!, same!]) assert.equal(carries(trusted, auth), true, auth.type);
    for (const untrusted of [other!, plain!]) assert.equal(carries(untrusted, auth), false, auth.type);
  }
  const upgrade = recorder((url) =>
    url.startsWith("http:") ? new Response(null, { status: 301, headers: { location: "https://wiki.internal.example/docs" } }) : new Response("ok"),
  );
  await fetchDocs("http://wiki.internal.example/docs", upgrade.fetchImpl, { type: "bearer", name: "", secret: "tok" });
  assert.deepEqual(
    upgrade.seen.map((call) => header(call, "authorization")),
    ["Bearer tok", "Bearer tok"],
  );
});

test("401 and 403 from the documentation server map to MCP_BUILDER_FETCH_AUTH", async () => {
  for (const status of [401, 403]) {
    const denied = recorder(() => new Response("nope", { status }));
    await assert.rejects(fetchDocs("https://docs.example.com/a", denied.fetchImpl, { type: "bearer", name: "", secret: "bad" }), /MCP_BUILDER_FETCH_AUTH/);
  }
});

test("fetchDocs authenticates against a real server and strips credentials for another origin", async () => {
  const other = await listen(() => ({ status: 200, headers: { "content-type": "text/plain" }, body: "public mirror" }));
  const docs = await listen((path, headers): Answer => {
    if (headers.authorization !== "Bearer live-SECRET") return { status: 401, body: "sign in" };
    if (path === "/spec") return { status: 200, headers: { "content-type": "application/json" }, body: '{"openapi":"3.1.0","paths":{}}' };
    if (path === "/mirror") return { status: 302, headers: { location: `http://127.0.0.1:${other.port}/copy` } };
    return { status: 404 };
  });
  const fetchImpl = guardedFetch(true);
  const spec = await fetchDocs(`http://127.0.0.1:${docs.port}/spec`, fetchImpl, { type: "bearer", name: "", secret: "live-SECRET" });
  assert.equal(linkedText(spec), '{"openapi":"3.1.0","paths":{}}');
  await assert.rejects(
    fetchDocs(`http://127.0.0.1:${docs.port}/spec`, fetchImpl, { type: "bearer", name: "", secret: "wrong" }),
    /MCP_BUILDER_FETCH_AUTH/,
  );
  const mirrored = await fetchDocs(`http://127.0.0.1:${docs.port}/mirror`, fetchImpl, { type: "bearer", name: "", secret: "live-SECRET" });
  assert.equal(linkedText(mirrored), "public mirror");
  assert.equal(other.requests.length, 1);
  assert.equal(other.requests[0]!.headers.authorization, undefined);
  await assert.rejects(fetchDocs(`http://127.0.0.1:${docs.port}/spec`, guardedFetch(false)), /MCP_URL_INSECURE/);
  await assert.rejects(fetchDocs("http://169.254.169.254/latest/meta-data", fetchImpl), /MCP_URL_BLOCKED/);
});

test("builder links validate header names, query names, credentials, and http use", () => {
  const link = (change: Record<string, unknown>) => builderLinkSchema.safeParse({ url: "https://docs.example.com", ...change });
  const issue = (change: Record<string, unknown>) => {
    const parsed = link(change);
    return parsed.success ? "" : parsed.error.issues.map((item) => `${String(item.path[0])}:${item.message}`).join(",");
  };
  assert.equal(issue({}), "");
  assert.equal(issue({ auth: "header", name: "X-API-Key", secret: "v" }), "");
  assert.equal(issue({ auth: "header", name: "Cookie", secret: "session=1; a=b" }), "");
  assert.equal(issue({ auth: "header", name: "Authorization", secret: "Token abc" }), "");
  assert.equal(issue({ auth: "header", name: "X Bad", secret: "v" }), "name:invalid");
  assert.equal(issue({ auth: "header", name: "X-Key:", secret: "v" }), "name:invalid");
  assert.equal(issue({ auth: "header", name: "Host", secret: "v" }), "name:invalid");
  assert.equal(issue({ auth: "header", name: "Transfer-Encoding", secret: "v" }), "name:invalid");
  assert.equal(issue({ auth: "header", name: "X-Key", secret: "a\r\nInjected: 1" }), "secret:invalid");
  assert.equal(issue({ auth: "bearer", secret: "tok\n" }), "secret:invalid");
  assert.equal(issue({ auth: "bearer", secret: "" }), "secret:required");
  assert.equal(issue({ auth: "basic", name: "a:b", secret: "x" }), "name:invalid");
  assert.equal(issue({ auth: "basic", name: "admin", secret: "p\u0000w" }), "secret:invalid");
  assert.equal(issue({ auth: "basic", name: "admin", secret: "pä ss" }), "");
  assert.equal(issue({ auth: "query", name: "api key", secret: "v" }), "name:invalid");
  assert.equal(issue({ auth: "query", name: "api_key", secret: "ünicode & co" }), "");
  assert.equal(issue({ url: "http://docs.example.com" }), "url:insecure");
  assert.equal(issue({ url: "http://docs.example.com", internal: true }), "");
  assert.equal(issue({ url: "https://user:pw@docs.example.com" }), "url:invalid");
  assert.equal(issue({ url: "docs.example.com" }), "url:invalid");
  const many = Array.from({ length: 11 }, () => ({ url: "https://docs.example.com" }));
  assert.equal(builderDraftSchema.safeParse({ instruction: "x", links: many }).success, false);
  assert.equal(builderDraftSchema.safeParse({ instruction: "x", links: many.slice(0, 10) }).success, true);
});
