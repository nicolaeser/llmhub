import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CRAWL_PAGE_BYTES,
  crawlBudget,
  crawlDocs,
  fetchSitePage,
  loginWall,
  pageLinks,
  skippedUrl,
  withoutBoilerplate,
} from "@/lib/mcp/docs-crawl";
import { docsLoginFor } from "@/lib/mcp/docs-login";
import { builderLinkSchema } from "@/schemas/mcp";
import type { McpCrawlBudget, McpDocsLink, McpFetch } from "@/types/mcp";

type Seen = { url: string; headers: Record<string, string> };
type Answer = { status?: number; type?: string; body?: string; headers?: [string, string][] };
type Route = Answer | ((seen: Seen) => Answer);

const ROOT = "https://docs.example.com";

function html(title: string, body: string): string {
  return `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;
}

function links(...hrefs: string[]): string {
  return hrefs.map((href) => `<a href="${href}">${href}</a>`).join(" ");
}

function page(title: string, body: string, headers: [string, string][] = []): Answer {
  return { body: html(title, `<h1>${title}</h1>${body}`), headers };
}

function redirect(location: string, headers: [string, string][] = []): Answer {
  return { status: 302, headers: [["location", location], ...headers] };
}

function fakeSite(routes: Record<string, Route>) {
  const seen: Seen[] = [];
  const fetchImpl: McpFetch = async (url, init) => {
    const call = { url, headers: init.headers };
    seen.push(call);
    const target = new URL(url);
    const route = routes[`${target.origin}${target.pathname}${target.search}`] ?? routes[`${target.origin}${target.pathname}`];
    const answer = typeof route === "function" ? route(call) : (route ?? { status: 404, body: "missing" });
    const status = answer.status ?? 200;
    const headers = new Headers(answer.headers ?? []);
    if (status < 300 && !headers.has("content-type")) headers.set("content-type", answer.type ?? "text/html; charset=utf-8");
    return new Response(status >= 300 && status < 400 ? null : (answer.body ?? ""), { status, headers });
  };
  return { fetchImpl, seen, paths: () => seen.map((call) => call.url) };
}

function link(url: string, change: Partial<McpDocsLink> = {}): McpDocsLink {
  return { url, internal: false, crawl: true, auth: "none", name: "", secret: "", ...change };
}

function header(seen: Seen, name: string): string | undefined {
  return Object.entries(seen.headers).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
}

function budget(change: Partial<McpCrawlBudget> = {}): McpCrawlBudget {
  return { ...crawlBudget(), ...change };
}

test("the crawl follows sub pages of the start folder breadth first and stops at the depth limit", async () => {
  const deep: Record<string, Route> = {};
  for (let level = 1; level <= 9; level += 1) {
    deep[`${ROOT}/docs/api/deep/${level}.html`] = page(`Level ${level}`, `<p>Depth ${level} text.</p>${links(`${level + 1}.html`)}`);
  }
  const site = fakeSite({
    ...deep,
    [`${ROOT}/docs/api/index.html`]: page(
      "API index",
      `<p>Ticket API overview.</p>${links(
        "tickets.html",
        "users/index.html",
        "#top",
        "index.html?page=2",
        "deep/1.html",
        "/blog/news.html",
        "https://other.example.com/docs/api/x.html",
        "mailto:help@example.com",
        "javascript:void(0)",
        "style.css",
        "logo.png",
        "manual.pdf",
        "tel:+491234",
      )}`,
    ),
    [`${ROOT}/docs/api/index.html?page=2`]: page("API index page 2", "<p>More endpoints on page two.</p>"),
    [`${ROOT}/docs/api/tickets.html`]: page("Tickets", "<p>GET /api/v1/tickets lists tickets.</p>"),
    [`${ROOT}/docs/api/users/index.html`]: page("Users", `<p>Users overview.</p>${links("list.html", "../tickets.html")}`),
    [`${ROOT}/docs/api/users/list.html`]: page("List users", "<p>GET /api/v1/users lists users.</p>"),
  });
  const result = await crawlDocs(link(`${ROOT}/docs/api/index.html`), 0, site.fetchImpl, budget());
  assert.ok(result.site);
  const urls = result.site.pages.map((entry) => entry.url);
  assert.deepEqual(urls.slice(0, 5), [
    `${ROOT}/docs/api/index.html`,
    `${ROOT}/docs/api/tickets.html`,
    `${ROOT}/docs/api/users/index.html`,
    `${ROOT}/docs/api/index.html?page=2`,
    `${ROOT}/docs/api/deep/1.html`,
  ]);
  assert.ok(urls.includes(`${ROOT}/docs/api/users/list.html`));
  assert.ok(urls.includes(`${ROOT}/docs/api/deep/8.html`));
  assert.equal(urls.includes(`${ROOT}/docs/api/deep/9.html`), false);
  assert.equal(new Set(urls).size, urls.length);
  assert.equal(result.site.pages[1]!.title, "Tickets");
  assert.match(result.site.pages[1]!.text, /GET \/api\/v1\/tickets lists tickets/);
  const requested = site.paths();
  for (const blocked of ["blog", "other.example.com", "mailto", "javascript", "style.css", "logo.png", "manual.pdf", "tel:", "deep/9"]) {
    assert.equal(requested.some((url) => url.includes(blocked)), false, blocked);
  }
  assert.equal(requested.filter((url) => url.endsWith("/tickets.html")).length, 1);
  assert.deepEqual(result.site.stats, { pages: urls.length, skipped: 0, failed: 0, truncated: "depth" });
});

test("a crawl that starts at the site root covers the whole site and dedupes identical pages", async () => {
  const site = fakeSite({
    [`${ROOT}/`]: page("Home", `<p>Welcome to the docs.</p>${links("/guide/intro.html", "/index.html", "/api/")}`),
    [`${ROOT}/index.html`]: page("Home", `<p>Welcome to the docs.</p>${links("/guide/intro.html", "/index.html", "/api/")}`),
    [`${ROOT}/guide/intro.html`]: page("Intro", "<p>Start here.</p>"),
    [`${ROOT}/api/`]: page("API", "<p>POST /tickets creates a ticket.</p>"),
  });
  const result = await crawlDocs(link(`${ROOT}/`), 0, site.fetchImpl, budget());
  assert.deepEqual(
    result.site!.pages.map((entry) => entry.url),
    [`${ROOT}/`, `${ROOT}/guide/intro.html`, `${ROOT}/api/`],
  );
});

test("page, byte, and time budgets stop the crawl and report which one was hit", async () => {
  const routes: Record<string, Route> = {
    [`${ROOT}/docs/index.html`]: page("Index", `<p>Overview.</p>${links("a.html", "b.html", "c.html", "d.html", "e.html")}`),
  };
  for (const name of ["a", "b", "c", "d", "e"]) routes[`${ROOT}/docs/${name}.html`] = page(name, `<p>Page ${name} text.</p>`);

  const pages = fakeSite(routes);
  const few = await crawlDocs(link(`${ROOT}/docs/index.html`), 0, pages.fetchImpl, budget({ pages: 3 }));
  assert.equal(few.site!.pages.length, 3);
  assert.equal(few.site!.stats.truncated, "pages");

  const late = fakeSite(routes);
  const timed = await crawlDocs(link(`${ROOT}/docs/index.html`), 0, late.fetchImpl, budget({ deadline: Date.now() - 1 }));
  assert.equal(late.seen.length, 1);
  assert.equal(timed.site!.stats.truncated, "time");

  const small = fakeSite(routes);
  const start = routes[`${ROOT}/docs/index.html`] as Answer;
  const tight = await crawlDocs(
    link(`${ROOT}/docs/index.html`),
    0,
    small.fetchImpl,
    budget({ bytes: Buffer.byteLength(start.body!) + 10 }),
  );
  assert.equal(tight.site!.pages.length, 1);
  assert.equal(tight.site!.stats.truncated, "bytes");
  assert.ok(CRAWL_PAGE_BYTES > 10);

  const off = fakeSite(routes);
  const single = await crawlDocs(link(`${ROOT}/docs/index.html`, { crawl: false }), 0, off.fetchImpl, budget());
  assert.equal(off.seen.length, 1);
  assert.equal(single.site!.pages.length, 1);
  assert.equal(single.site!.stats.truncated, null);
});

test("credentials go to every page of the docs site and never to another site", async () => {
  const basic = `Basic ${Buffer.from("agent:pw-SECRET").toString("base64")}`;
  const guarded = (answer: Answer): Route => (seen) => (header(seen, "authorization") === basic ? answer : { status: 401, body: "sign in" });
  const site = fakeSite({
    [`${ROOT}/docs/index.html`]: guarded(page("Index", `<p>Overview.</p>${links("tickets.html", "moved.html", "mirror.html")}`)),
    [`${ROOT}/docs/tickets.html`]: guarded(page("Tickets", "<p>GET /tickets.</p>")),
    [`${ROOT}/docs/moved.html`]: guarded(redirect("https://cdn.example.net/docs/moved.html")),
    [`${ROOT}/docs/mirror.html`]: guarded(redirect("/docs/tickets-v2.html")),
    [`${ROOT}/docs/tickets-v2.html`]: guarded(page("Tickets v2", "<p>GET /v2/tickets.</p>")),
    "https://cdn.example.net/docs/moved.html": page("Moved", "<p>Public copy.</p>"),
  });
  const result = await crawlDocs(link(`${ROOT}/docs/index.html`, { auth: "basic", name: "agent", secret: "pw-SECRET" }), 0, site.fetchImpl, budget());
  for (const call of site.seen) {
    const trusted = call.url.startsWith(ROOT);
    assert.equal(header(call, "authorization") === basic, trusted, call.url);
  }
  const urls = result.site!.pages.map((entry) => entry.url);
  assert.deepEqual(urls, [`${ROOT}/docs/index.html`, `${ROOT}/docs/tickets.html`, `${ROOT}/docs/tickets-v2.html`]);
  assert.equal(result.site!.stats.skipped, 1);
});

test("a query key is re-added on the docs site but stripped from discovered addresses and results", async () => {
  const keyed = (answer: Answer): Route => (seen) => (new URL(seen.url).searchParams.get("key") === "q-SECRET" ? answer : { status: 403 });
  const site = fakeSite({
    [`${ROOT}/docs/index.html`]: keyed(page("Index", `<p>Overview.</p>${links("tickets.html?key=q-SECRET&amp;lang=en", "https://other.example.com/x?key=q-SECRET")}`)),
    [`${ROOT}/docs/tickets.html`]: keyed(page("Tickets", "<p>Ticket endpoints.</p>")),
  });
  const result = await crawlDocs(link(`${ROOT}/docs/index.html`, { auth: "query", name: "key", secret: "q-SECRET" }), 0, site.fetchImpl, budget());
  assert.deepEqual(
    result.site!.pages.map((entry) => entry.url),
    [`${ROOT}/docs/index.html`, `${ROOT}/docs/tickets.html?lang=en`],
  );
  assert.equal(JSON.stringify(result.site!.pages).includes("q-SECRET"), false);
  assert.match(result.site!.pages[0]!.text, /tickets\.html\?key=\[credential\]&lang=en/);
  assert.equal(site.seen.every((call) => call.url.startsWith(ROOT)), true);
  assert.equal(site.seen.every((call) => new URL(call.url).searchParams.get("key") === "q-SECRET"), true);
});

test("session cookies from the docs site are replayed on later requests of that site only", async () => {
  const cookie = (seen: Seen) => header(seen, "cookie") ?? "";
  const site = fakeSite({
    [`${ROOT}/docs/index.html`]: (seen) =>
      header(seen, "authorization")
        ? page("Index", `<p>Overview.</p>${links("a.html")}`, [
            ["set-cookie", "sid=abc; Path=/docs; HttpOnly; Secure"],
            ["set-cookie", "tracker=1; Domain=evil.example"],
            ["set-cookie", "theme=dark; Path=/"],
          ])
        : { status: 401 },
    [`${ROOT}/docs/a.html`]: (seen) =>
      cookie(seen).includes("sid=abc") ? page("A", `<p>Page A.</p>${links("b.html")}`) : redirect("/login"),
    [`${ROOT}/docs/b.html`]: redirect("/docs/c.html", [
      ["set-cookie", "sid=def; Path=/docs"],
      ["set-cookie", "theme=; Max-Age=0; Path=/"],
    ]),
    [`${ROOT}/docs/c.html`]: (seen) =>
      cookie(seen) === "sid=def" ? page("C", `<p>Page C.</p>${links("https://other.example.com/docs/d.html")}`) : { status: 403 },
    [`${ROOT}/login`]: page("Sign in", '<form><input type="password" name="pw"></form>'),
  });
  const result = await crawlDocs(link(`${ROOT}/docs/index.html`, { auth: "bearer", secret: "tok" }), 0, site.fetchImpl, budget());
  assert.deepEqual(
    result.site!.pages.map((entry) => entry.title),
    ["Index", "A", "C"],
  );
  assert.equal(cookie(site.seen[0]!), "");
  assert.equal(cookie(site.seen[1]!), "sid=abc; theme=dark");
  assert.equal(site.seen.some((call) => cookie(call).includes("tracker")), false);

  const portal = fakeSite({
    [`${ROOT}/kb/index.html`]: (seen) =>
      cookie(seen) === "portal=xyz; lang=de" ? page("Portal", `<p>Knowledge base.</p>${links("moved.html")}`) : redirect("/sso/login"),
    [`${ROOT}/kb/moved.html`]: redirect("https://cdn.example.net/kb/moved.html"),
    "https://cdn.example.net/kb/moved.html": page("Copy", "<p>Public copy.</p>"),
  });
  const viaCookie = await crawlDocs(link(`${ROOT}/kb/index.html`, { auth: "cookie", secret: "portal=xyz; lang=de" }), 0, portal.fetchImpl, budget());
  assert.equal(viaCookie.site!.pages[0]!.title, "Portal");
  const foreign = portal.seen.find((call) => call.url.startsWith("https://cdn.example.net"));
  assert.ok(foreign);
  assert.equal(cookie(foreign), "");
  assert.equal(header(foreign, "authorization"), undefined);
});

test("sign-out, destructive, and asset links are never opened, also not through a redirect", async () => {
  const site = fakeSite({
    [`${ROOT}/docs/index.html`]: page(
      "Index",
      `<p>Overview.</p>${links(
        "logout",
        "user/sign_out",
        "abmelden.html",
        "Log-Out",
        "tickets/5/delete",
        "remove",
        "admin.php?Action=AgentTicketDelete&amp;id=5",
        "session?do=logoff",
        "delete-ticket.html",
        "go.html",
        "theme.css",
        "font.woff2",
      )}`,
    ),
    [`${ROOT}/docs/delete-ticket.html`]: page("Delete a ticket", "<p>DELETE /tickets/{id} removes a ticket.</p>"),
    [`${ROOT}/docs/go.html`]: redirect("/docs/logout?next=/"),
  });
  const result = await crawlDocs(link(`${ROOT}/docs/index.html`), 0, site.fetchImpl, budget());
  assert.deepEqual(site.paths(), [`${ROOT}/docs/index.html`, `${ROOT}/docs/delete-ticket.html`, `${ROOT}/docs/go.html`]);
  assert.deepEqual(
    result.site!.pages.map((entry) => entry.title),
    ["Index", "Delete a ticket"],
  );
  assert.equal(result.site!.stats.skipped, 9);
  for (const raw of ["https://x.example/logout", "https://x.example/a?mode=remove", "https://x.example/img.svg", "mailto:x@example.com"]) {
    assert.notEqual(skippedUrl(new URL(raw)), null, raw);
  }
  assert.equal(skippedUrl(new URL("https://x.example/docs/remove-member.html")), null);
  assert.equal(skippedUrl(new URL("https://x.example/docs/tickets/delete.html")), null);
  assert.equal(skippedUrl(new URL("https://x.example/docs/logout.html")), "session");
  assert.equal(skippedUrl(new URL("https://x.example/tickets/5/delete.php")), "session");
});

test("frames, iframes, area maps, next links, and base href are followed", async () => {
  const start = new URL(`${ROOT}/javadoc/index.html`);
  const found = pageLinks(
    `<html><head><base href="/javadoc/api/"><link rel="next" href="page2.html"><link rel="stylesheet" href="x.css"></head>
<frameset><frame src="overview.html"><frame src='classes.html'></frameset>
<iframe src="embed.html"></iframe><map><area href="tickets.html"></map><!-- <a href="hidden.html"> --><script>var a = '<a href="script.html">';</script></html>`,
    start,
  );
  assert.deepEqual(
    found.links.map((url) => url.pathname),
    ["/javadoc/api/page2.html", "/javadoc/api/overview.html", "/javadoc/api/classes.html", "/javadoc/api/embed.html", "/javadoc/api/tickets.html"],
  );
  const site = fakeSite({
    [`${ROOT}/javadoc/index.html`]: { body: '<html><frameset><frame src="overview.html"><frame src="classes.html"></frameset></html>' },
    [`${ROOT}/javadoc/overview.html`]: page("Overview", `<p>All packages.</p>${links("tickets.html")}`),
    [`${ROOT}/javadoc/classes.html`]: page("Classes", "<p>TicketClient, UserClient.</p>"),
    [`${ROOT}/javadoc/tickets.html`]: page("TicketClient", "<p>createTicket(subject) sends POST /tickets.</p>"),
  });
  const result = await crawlDocs(link(`${ROOT}/javadoc/index.html`), 0, site.fetchImpl, budget());
  assert.deepEqual(
    result.site!.pages.map((entry) => entry.title),
    ["Overview", "Classes", "TicketClient"],
  );
});

test("a sign-in page instead of docs fails the start link and is skipped for sub pages", async () => {
  const form = page("Sign in", '<form method="post"><input name="user"><input type="password" name="pw"><button>Sign in</button></form>');
  const walled = fakeSite({
    [`${ROOT}/docs/index.html`]: redirect("/login?next=%2Fdocs%2Findex.html"),
    [`${ROOT}/login`]: form,
  });
  await assert.rejects(crawlDocs(link(`${ROOT}/docs/index.html`), 0, walled.fetchImpl, budget()), /^Error: MCP_BUILDER_FETCH_AUTH$/);
  const direct = fakeSite({ [`${ROOT}/docs/index.html`]: form });
  await assert.rejects(crawlDocs(link(`${ROOT}/docs/index.html`), 0, direct.fetchImpl, budget()), /MCP_BUILDER_FETCH_AUTH/);

  const sso = fakeSite({
    [`${ROOT}/docs/index.html`]: page("Index", `<p>Overview.</p>${links("private.html", "auth/index.html")}`),
    [`${ROOT}/docs/private.html`]: redirect("https://sso.example.com/auth/realms/main/protocol/openid-connect/auth?client=docs"),
    "https://sso.example.com/auth/realms/main/protocol/openid-connect/auth": page("Single sign-on", "<p>Loading…</p>"),
    [`${ROOT}/docs/auth/index.html`]: page("Authentication", `<p>${"Send the API token in the Authorization header. ".repeat(80)}</p><input type="password" placeholder="Try it">`),
  });
  const result = await crawlDocs(link(`${ROOT}/docs/index.html`), 0, sso.fetchImpl, budget());
  assert.deepEqual(
    result.site!.pages.map((entry) => entry.title),
    ["Index", "Authentication"],
  );
  assert.equal(result.site!.stats.skipped, 1);
  const response = { url: new URL(`${ROOT}/docs/a.html`), requested: new URL(`${ROOT}/docs/a.html`), redirected: false };
  assert.equal(loginWall("<p>Docs</p>", "Docs", response), false);
});

test("navigation and footer lines repeated on most pages are kept once", () => {
  const nav = ["Home", "API reference", "Tickets", "Users", "Sign out"];
  const footer = ["Imprint", "© 2026 Example Helpdesk"];
  const body = (name: string) => [`${name} endpoint`, `GET /api/v1/${name}`, `Returns the ${name}.`, "Parameters", "id integer required", `More about ${name}.`];
  const pages = ["tickets", "users", "groups", "tags"].map((name) => ({
    url: `${ROOT}/docs/${name}.html`,
    title: name,
    text: [...nav, ...body(name), ...footer].join("\n"),
  }));
  const cleaned = withoutBoilerplate(pages);
  assert.equal(cleaned[0]!.text, pages[0]!.text);
  for (const [index, entry] of cleaned.slice(1).entries()) {
    const name = ["users", "groups", "tags"][index]!;
    assert.equal(entry.text, body(name).join("\n"));
  }
  assert.deepEqual(withoutBoilerplate(pages.slice(0, 2)), pages.slice(0, 2));
});

test("an OpenAPI document found while crawling is reported and ends the crawl", async () => {
  const spec = JSON.stringify({ openapi: "3.1.0", info: { title: "Helpdesk" }, paths: { "/tickets": { get: { operationId: "listTickets" } } } });
  const site = fakeSite({
    [`${ROOT}/docs/index.html`]: page(
      "API explorer",
      `<div id="swagger-ui"></div><script>SwaggerUIBundle({ url: "/openapi.json", dom_id: "#swagger-ui" });</script>`,
    ),
    [`${ROOT}/openapi.json`]: { body: spec, type: "application/json" },
  });
  const result = await crawlDocs(link(`${ROOT}/docs/index.html`), 0, site.fetchImpl, budget());
  assert.deepEqual(result.site!.specs, [{ url: `${ROOT}/openapi.json`, text: spec }]);
  assert.equal(site.seen[1]!.url, `${ROOT}/openapi.json`);
});

test("fetchSitePage loads more pages of the docs site with its login and the same skip rules", async () => {
  const bearer = (answer: Answer): Route => (seen) => (header(seen, "authorization") === "Bearer tok" ? answer : { status: 401 });
  const site = fakeSite({
    [`${ROOT}/docs/index.html`]: bearer(page("Index", "<p>Overview.</p>")),
    [`${ROOT}/reference/tickets.html`]: bearer(page("Tickets reference", "<p>PATCH /tickets/{id} updates a ticket.</p>")),
    [`${ROOT}/reference/login.html`]: bearer(page("Sign in", '<form><input type="password"></form>')),
  });
  const shared = budget({ fetches: 2 });
  const { site: docs } = await crawlDocs(link(`${ROOT}/docs/index.html`, { auth: "bearer", secret: "tok" }), 0, site.fetchImpl, shared);
  assert.ok(docs);
  const loaded = await fetchSitePage(docs, `${ROOT}/reference/tickets.html#patch`);
  assert.ok("page" in loaded);
  assert.equal(loaded.page.title, "Tickets reference");
  assert.equal(docs.pages.length, 2);
  assert.equal(docs.stats.pages, 2);
  assert.ok("page" in (await fetchSitePage(docs, `${ROOT}/docs/index.html`)));
  for (const refused of ["https://other.example.com/docs.html", `${ROOT}/account/logout`, `${ROOT}/files/manual.pdf`, "not a url"]) {
    assert.ok("error" in (await fetchSitePage(docs, refused)), refused);
  }
  assert.ok("error" in (await fetchSitePage(docs, `${ROOT}/reference/login.html`)));
  assert.match(String(Object.values(await fetchSitePage(docs, `${ROOT}/reference/more.html`))[0]), /limit/);
  assert.equal(site.seen.filter((call) => call.url.includes("other.example.com") || call.url.includes("logout")).length, 0);
});

test("builder links default to following sub pages and accept a copied browser cookie", () => {
  const parsed = builderLinkSchema.parse({ url: "https://docs.example.com" });
  assert.equal(parsed.crawl, true);
  const issue = (change: Record<string, unknown>) => {
    const result = builderLinkSchema.safeParse({ url: "https://docs.example.com", ...change });
    return result.success ? "" : result.error.issues.map((item) => `${String(item.path[0])}:${item.message}`).join(",");
  };
  assert.equal(issue({ auth: "cookie", secret: "session=abc; csrftoken=x" }), "");
  assert.equal(issue({ auth: "cookie", secret: "" }), "secret:required");
  assert.equal(issue({ auth: "cookie", secret: "a=1\r\nX: y" }), "secret:invalid");
  assert.equal(issue({ crawl: false }), "");
});

test("docsLoginFor maps a docs sign-in to the server login only on the same site", () => {
  const rows: McpDocsLink[] = [
    link("https://docs.example.com/api/", { auth: "cookie", secret: "sid=1" }),
    link("https://helpdesk.example.com/docs/", { auth: "header", name: "Cookie", secret: "sid=2" }),
    link("https://helpdesk.example.com/help/", { auth: "basic", name: "agent", secret: "pw" }),
    link("https://api.example.com/docs/", { auth: "query", name: "api_key", secret: "k" }),
  ];
  assert.deepEqual(docsLoginFor("https://helpdesk.example.com/api/v1", rows), { link: 2, authType: "basic", authHeader: "agent", secret: "pw" });
  assert.deepEqual(docsLoginFor("https://api.example.com/v2", rows), { link: 3, authType: "query", authHeader: "api_key", secret: "k" });
  assert.equal(docsLoginFor("https://docs.example.com/v1", rows), null);
  assert.equal(docsLoginFor("https://elsewhere.example.com", rows), null);
  assert.equal(docsLoginFor("not a url", rows), null);
  assert.deepEqual(docsLoginFor("https://bearer.example.com/api", [link("http://bearer.example.com/docs", { internal: true, auth: "bearer", secret: "t" })]), {
    link: 0,
    authType: "bearer",
    authHeader: "",
    secret: "t",
  });
  assert.equal(docsLoginFor("https://x.example.com", [link("https://x.example.com/d", { auth: "header", name: "X_Key", secret: "v" })]), null);
});
