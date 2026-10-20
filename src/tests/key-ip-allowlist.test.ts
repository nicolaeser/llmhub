import { gateway, gatewayRequest, MODEL, resetGateway, virtualKeyRow } from "./support/gateway-harness";
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

beforeEach(() => {
  resetGateway();
});

async function chatFrom(headers: Record<string, string>): Promise<{ status: number; code: string | null }> {
  const { POST } = await import("@/app/api/v1/chat/completions/route");
  const res = await POST(
    gatewayRequest("/api/v1/chat/completions", { model: MODEL, messages: [{ role: "user", content: "hi" }] }, headers),
  );
  const body = (await res.json()) as { error?: { code?: string } };
  return { status: res.status, code: body.error?.code ?? null };
}

const ALLOWED = { status: 200, code: null };
const REJECTED = { status: 403, code: "ip_not_allowed" };

test("key IP allowlists check the address the reverse proxy appended", async () => {
  gateway.key = virtualKeyRow({ allowedIps: ["198.51.100.4", "2001:DB8::7"] });
  assert.deepEqual(await chatFrom({ "x-forwarded-for": "203.0.113.9, 198.51.100.4" }), ALLOWED);
  assert.deepEqual(await chatFrom({ "x-forwarded-for": "198.51.100.4, 203.0.113.9" }), REJECTED);
  assert.deepEqual(await chatFrom({ "x-forwarded-for": "198.51.100.4, garbage" }), REJECTED);
  assert.equal(gateway.upstream.length, 1);
});

test("key IP allowlists match canonical IPv6 and IPv4-mapped addresses", async () => {
  gateway.key = virtualKeyRow({ allowedIps: ["198.51.100.4", "2001:DB8::7"] });
  assert.deepEqual(await chatFrom({ "x-forwarded-for": "2001:db8:0:0::7" }), ALLOWED);
  assert.deepEqual(await chatFrom({ "x-forwarded-for": "::ffff:198.51.100.4" }), ALLOWED);
  assert.deepEqual(await chatFrom({ "x-forwarded-for": "2001:db8::8" }), REJECTED);
});

test("key IP allowlists ignore X-Real-IP and Cloudflare headers outside cloudflare mode", async () => {
  gateway.key = virtualKeyRow({ allowedIps: ["198.51.100.4"] });
  const spoofed = { "x-real-ip": "198.51.100.4", "cf-connecting-ip": "198.51.100.4", "true-client-ip": "198.51.100.4" };
  assert.deepEqual(await chatFrom(spoofed), REJECTED);
  assert.deepEqual(await chatFrom({ ...spoofed, "x-forwarded-for": "203.0.113.9" }), REJECTED);
  assert.equal(gateway.upstream.length, 0);
});
