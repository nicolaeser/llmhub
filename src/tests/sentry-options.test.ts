import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import * as Sentry from "@sentry/node";
import { peerAddressHeader } from "@/lib/http/client-ip";
import { readSentryDsn, sentryIngestOrigin, sentryInitOptions } from "@/lib/sentry/options";
import { scrubEvent, scrubText } from "@/lib/sentry/scrub";

const SUB_ADD_TOKEN = "a".repeat(43);

function recordingTransport(events: Sentry.ErrorEvent[]) {
  return () => ({
    send: async (envelope: unknown) => {
      const [, items] = envelope as [unknown, Array<[{ type: string }, unknown]>];
      for (const [header, payload] of items) {
        if (header.type === "event") events.push(payload as Sentry.ErrorEvent);
      }
      return {};
    },
    flush: async () => true,
  });
}

test("Sentry stays disabled when no DSN is set", () => {
  const options = sentryInitOptions({
    NODE_ENV: "production",
    SENTRY_DSN: "",
    NEXT_PUBLIC_SENTRY_DSN: "  ",
  });
  assert.equal(readSentryDsn({ SENTRY_DSN: "" }), undefined);
  assert.equal(options.enabled, false);
  assert.equal(options.dsn, undefined);
  assert.equal(options.tracesSampleRate, 0);
  assert.equal(sentryIngestOrigin({ NEXT_PUBLIC_SENTRY_DSN: "" }), undefined);
});

test("Sentry uses the runtime DSN, the build as release, and optional metadata", () => {
  const options = sentryInitOptions({
    SENTRY_DSN: "https://key@sentry.example/1",
    SENTRY_ENVIRONMENT: "staging",
    BUILD_ID: "v2026.10.27.abc1234",
    SENTRY_TRACES_SAMPLE_RATE: "0.2",
  });
  assert.equal(options.enabled, true);
  assert.equal(options.dsn, "https://key@sentry.example/1");
  assert.equal(options.environment, "staging");
  assert.equal(options.release, "v2026.10.27.abc1234");
  assert.equal(options.tracesSampleRate, 0.2);
  assert.equal(sentryInitOptions({ BUILD_ID: "v1", SENTRY_RELEASE: "llmhub@2" }).release, "llmhub@2");
  assert.equal(sentryInitOptions({ NODE_ENV: "development" }).environment, "development");
  assert.equal(sentryInitOptions({ NEXT_PUBLIC_SENTRY_DSN: "https://key@sentry.example/2" }).dsn, "https://key@sentry.example/2");
  assert.equal(sentryInitOptions({ SENTRY_TRACES_SAMPLE_RATE: "7" }).tracesSampleRate, 1);
});

test("the browser may reach only the ingest origin of the public DSN", () => {
  assert.equal(
    sentryIngestOrigin({ NEXT_PUBLIC_SENTRY_DSN: "https://key@o1.ingest.sentry.example/42" }),
    "https://o1.ingest.sentry.example",
  );
  assert.equal(sentryIngestOrigin({ SENTRY_DSN: "https://key@server-only.example/1" }), undefined);
  assert.equal(sentryIngestOrigin({ NEXT_PUBLIC_SENTRY_DSN: "not a url" }), undefined);
});

test("Sentry keeps request data, cookies and users out of events", () => {
  const { dataCollection } = sentryInitOptions({
    SENTRY_DSN: "https://key@sentry.example/1",
  });
  assert.equal("sendDefaultPii" in sentryInitOptions({}), false);
  assert.equal(dataCollection.userInfo, false);
  assert.equal(dataCollection.cookies, false);
  assert.equal(dataCollection.urlQueryParams, false);
  assert.deepEqual(dataCollection.httpBodies, []);
  assert.equal(dataCollection.databaseQueryData, false);
  assert.equal(dataCollection.queues, false);
  assert.equal(dataCollection.stackFrameVariables, false);
  assert.deepEqual(dataCollection.genAI, { inputs: false, outputs: false });
  for (const direction of [
    dataCollection.httpHeaders.request,
    dataCollection.httpHeaders.response,
  ]) {
    for (const header of ["authorization", "cookie", "set-cookie"]) {
      assert.ok(direction.deny.includes(header));
    }
    for (const header of [peerAddressHeader(), "cf-connecting-ip", "cf-connecting-ipv6", "x-forwarded-for", "x-real-ip"]) {
      assert.ok(direction.deny.some((entry) => header.includes(entry)), header);
    }
  }
});

test("add-account link tokens and URL parameter values never leave the scrubber", () => {
  assert.equal(
    scrubText(`https://hub.example/de/providers/sub-add/${SUB_ADD_TOKEN}`),
    "https://hub.example/de/providers/sub-add/[Filtered]",
  );
  assert.equal(
    scrubText(`/providers/sub-add/manage/${SUB_ADD_TOKEN}?x=1`),
    "/providers/sub-add/manage/[Filtered]?x=[Filtered]",
  );
  assert.equal(scrubText("GET /providers/sub-add/[token]"), "GET /providers/sub-add/[token]");
  assert.equal(
    scrubText("/account/reset-password?token=secret-reset&lang=de#state=s1"),
    "/account/reset-password?token=[Filtered]&lang=[Filtered]#state=[Filtered]",
  );
  assert.equal(scrubText("a == b && c"), "a == b && c");
});

test("events lose secret URLs and multi-line error text but keep stack frames", () => {
  const frame = { filename: "/app/.next/server/chunk.js?v=1", function: "render" };
  const event = scrubEvent({
    request: { url: `https://hub.example/providers/sub-add/${SUB_ADD_TOKEN}`, headers: { Referer: "https://hub.example/account/reset-password?token=t" } },
    contexts: { nextjs: { request_path: "/sso/callback?code=c&state=s" } },
    breadcrumbs: [{ category: "navigation", data: { from: "/keys", to: `/providers/sub-add/manage/${SUB_ADD_TOKEN}` } }],
    exception: {
      values: [{ type: "Error", value: `Invalid \`prisma.user.create()\` invocation:\n{ email: "owner@example.com" }`, stacktrace: { frames: [frame] } }],
    },
  });
  assert.equal(event.request.url, "https://hub.example/providers/sub-add/[Filtered]");
  assert.equal(event.request.headers.Referer, "https://hub.example/account/reset-password?token=[Filtered]");
  assert.equal(event.contexts.nextjs.request_path, "/sso/callback?code=[Filtered]&state=[Filtered]");
  assert.equal(event.breadcrumbs[0].data.to, "/providers/sub-add/manage/[Filtered]");
  assert.equal(event.exception.values[0].value, "Invalid `prisma.user.create()` invocation:");
  assert.deepEqual(event.exception.values[0].stacktrace.frames[0], { filename: "/app/.next/server/chunk.js?v=1", function: "render" });
  assert.equal(scrubEvent({ exception: { values: [{ value: "x".repeat(400) }] } }).exception.values[0].value.length, 300);
  const scope = new Sentry.Scope();
  scope.setTag("route", "/keys?tab=mine");
  scrubEvent({ sdkProcessingMetadata: { capturedSpanScope: scope } });
  assert.equal(scope.getScopeData().tags.route, "/keys?tab=mine");
});

test("span names and attributes lose add-account link tokens and URL parameter values", () => {
  const span = scrubEvent({
    name: `POST /providers/sub-add/${SUB_ADD_TOKEN}`,
    attributes: { "url.full": `https://hub.example/providers/sub-add/manage/${SUB_ADD_TOKEN}?state=s`, "http.request.method": "POST" },
  });
  assert.equal(span.name, "POST /providers/sub-add/[Filtered]");
  assert.deepEqual(span.attributes, {
    "url.full": "https://hub.example/providers/sub-add/manage/[Filtered]?state=[Filtered]",
    "http.request.method": "POST",
  });
});

test("a real Sentry client drops credentials, bodies, cookies, and client addresses from request errors", async () => {
  const events: Sentry.ErrorEvent[] = [];
  const client = Sentry.init({
    ...sentryInitOptions({ SENTRY_DSN: "https://key@sentry.invalid/1", BUILD_ID: "v-test" }),
    transport: recordingTransport(events),
    defaultIntegrations: false,
    integrations: [Sentry.httpIntegration({ spans: false }), Sentry.requestDataIntegration()],
  });
  const server = createServer((req, res) => {
    const requestScope = Sentry.getIsolationScope();
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () =>
      setImmediate(() => {
        Sentry.withIsolationScope(requestScope, () =>
          Sentry.captureException(new Error("upstream failed\nprompt: my secret prompt")),
        );
        res.end(String(Buffer.concat(chunks).length));
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}/providers/sub-add/${SUB_ADD_TOKEN}?key=sk-query`, {
      method: "POST",
      headers: {
        authorization: "Bearer sk-live-virtual-key",
        "x-api-key": "sk-ant-api-key",
        "x-goog-api-key": "google-key",
        "api-key": "azure-key",
        cookie: "__Host-llmhub-session=session-token",
        "x-forwarded-for": "203.0.113.7",
        "cf-connecting-ip": "203.0.113.8",
        [peerAddressHeader()]: "203.0.113.9",
        "content-type": "application/json",
      },
      body: JSON.stringify({ messages: [{ role: "user", content: "my secret prompt" }] }),
    });
    await res.text();
    await Sentry.flush(2_000);
    assert.equal(events.length, 1);
    const [event] = events;
    const serialized = JSON.stringify(event);
    for (const secret of [
      "sk-live-virtual-key",
      "sk-ant-api-key",
      "google-key",
      "azure-key",
      "session-token",
      "sk-query",
      "203.0.113",
      "my secret prompt",
      SUB_ADD_TOKEN,
    ]) {
      assert.equal(serialized.includes(secret), false, secret);
    }
    assert.equal(event.request?.headers?.["content-type"], "application/json");
    assert.equal(event.request?.url, `http://127.0.0.1:${port}/providers/sub-add/[Filtered]`);
    assert.equal(event.release, "v-test");
    assert.equal(event.user, undefined);
  } finally {
    server.close();
    await client?.close();
  }
});
