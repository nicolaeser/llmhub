import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { releaseChannel, updateStatus } from "@/lib/updates/release-status";
import type { PublishedRelease } from "@/types/updates";

process.env.BUILD_ID = "v2026.10.07.38e8b1b";

function release(tag: string, publishedAt: string, draft = false): PublishedRelease {
  return { tag, url: `https://github.com/nicolaeser/llmhub/releases/tag/${tag}`, publishedAt, draft };
}

const releases = [
  release("v2026.10.07.671389b", "2026-10-07T11:34:26Z"),
  release("dev-2026.10.07.9472612", "2026-10-07T11:23:06Z"),
  release("v2026.10.07.38e8b1b", "2026-10-07T07:46:21Z"),
  release("dev-2026.10.06.b75078d", "2026-10-06T14:19:50Z"),
  release("v2026.10.09.deadbee", "2026-10-09T08:00:00Z", true),
];

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  delete (globalThis as { __llmhubReleaseCache?: unknown }).__llmhubReleaseCache;
});

test("release channels follow the CI tag formats", () => {
  assert.equal(releaseChannel("v2026.10.07.671389b"), "stable");
  assert.equal(releaseChannel("dev-2026.10.07.9472612"), "dev");
  assert.equal(releaseChannel("development"), null);
  assert.equal(releaseChannel("0.1.0"), null);
});

test("a newer release in the same channel is an update, drafts and other channels are not", () => {
  assert.deepEqual(updateStatus("v2026.10.07.38e8b1b", releases), {
    current: "v2026.10.07.38e8b1b",
    latest: "v2026.10.07.671389b",
    url: "https://github.com/nicolaeser/llmhub/releases/tag/v2026.10.07.671389b",
    available: true,
  });
  assert.equal(updateStatus("v2026.10.07.671389b", releases).available, false);
  assert.equal(updateStatus("dev-2026.10.07.9472612", releases).available, false);
  assert.equal(updateStatus("dev-2026.10.06.b75078d", releases).latest, "dev-2026.10.07.9472612");
  assert.equal(updateStatus("dev-2026.10.06.b75078d", releases).available, true);
});

test("builds missing from the release list compare by release date", () => {
  assert.equal(updateStatus("v2026.10.01.abcdef0", releases).available, true);
  assert.equal(updateStatus("v2026.10.07.abcdef0", releases).available, false);
  assert.deepEqual(updateStatus("development", releases), {
    current: "development",
    latest: null,
    url: null,
    available: false,
  });
});

test("the GitHub check is cached, can be turned off, and survives failures", async () => {
  const { checkForUpdate, RELEASES_URL } = await import("@/lib/updates/update-check");
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    calls.push(String(input));
    return Response.json([
      { tag_name: "v2026.10.07.671389b", html_url: "https://github.com/nicolaeser/llmhub/releases/tag/v2026.10.07.671389b", published_at: "2026-10-07T11:34:26Z", draft: false },
      { tag_name: "v2026.10.07.38e8b1b", html_url: "https://github.com/nicolaeser/llmhub/releases/tag/v2026.10.07.38e8b1b", published_at: "2026-10-07T07:46:21Z", draft: false },
      { tag_name: "v2026.10.08.1234567", html_url: "https://evil.example/release", published_at: "2026-10-08T07:46:21Z", draft: false },
    ]);
  }) as typeof fetch;

  assert.deepEqual(await checkForUpdate(false), {
    current: "v2026.10.07.38e8b1b",
    latest: null,
    url: null,
    available: false,
  });
  assert.equal(calls.length, 0);

  const first = await checkForUpdate(true);
  assert.equal(first.available, true);
  assert.equal(first.latest, "v2026.10.07.671389b");
  await checkForUpdate(true);
  assert.deepEqual(calls, [RELEASES_URL]);

  delete (globalThis as { __llmhubReleaseCache?: unknown }).__llmhubReleaseCache;
  globalThis.fetch = (async () => new Response("rate limited", { status: 403 })) as typeof fetch;
  assert.deepEqual(await checkForUpdate(true), {
    current: "v2026.10.07.38e8b1b",
    latest: null,
    url: null,
    available: false,
  });
});
