import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { listSourceFiles } from "./route-view-policy";
import {
  clientBucket,
  clientIp,
  ipAllowed,
  normalizeIp,
  peerAddressHeader,
  trackSocketPeers,
} from "@/lib/http/client-ip";
import type { IpMode } from "@/types/env";

const SOURCE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const RESOLVER = path.join(SOURCE_ROOT, "lib/http/client-ip.ts");
const ADDRESS_SOURCE =
  /\.get\(\s*["'`](?:x-forwarded-for|x-real-ip|cf-connecting-ipv?6?|true-client-ip|forwarded)["'`]|\[\s*["'`](?:x-forwarded-for|x-real-ip|cf-connecting-ipv?6?|true-client-ip)["'`]\s*\]|\bremoteAddress\b/i;

const SPOOFED = {
  "x-forwarded-for": "203.0.113.66",
  "x-real-ip": "203.0.113.67",
  "cf-connecting-ip": "203.0.113.68",
  "cf-connecting-ipv6": "2001:db8::68",
  "true-client-ip": "203.0.113.69",
  forwarded: "for=203.0.113.70",
};

const MODES: IpMode[] = ["proxy", "cloudflare", "direct"];

function nodeHeaders(raw: IncomingHttpHeaders): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(raw)) {
    if (typeof value === "string") headers.set(name, value);
  }
  return headers;
}

test("addresses are trimmed, unbracketed, stripped of ports, and canonical", () => {
  assert.equal(normalizeIp(" 198.51.100.4 "), "198.51.100.4");
  assert.equal(normalizeIp("198.51.100.4:51234"), "198.51.100.4");
  assert.equal(normalizeIp("2001:DB8:0:0::1"), "2001:db8::1");
  assert.equal(normalizeIp("[2001:db8::1]"), "2001:db8::1");
  assert.equal(normalizeIp("[2001:db8::1]:443"), "2001:db8::1");
  assert.equal(normalizeIp("fe80::1%eth0"), "fe80::1");
  assert.equal(normalizeIp("::1"), "::1");
});

test("IPv4-mapped IPv6 addresses count as the IPv4 address", () => {
  assert.equal(normalizeIp("::ffff:198.51.100.4"), "198.51.100.4");
  assert.equal(normalizeIp("::FFFF:c633:6404"), "198.51.100.4");
  assert.equal(normalizeIp("0:0:0:0:0:ffff:198.51.100.4"), "198.51.100.4");
  assert.equal(normalizeIp("64:ff9b::198.51.100.4"), "64:ff9b::c633:6404");
});

test("anything that is not one IP address is rejected", () => {
  for (const value of [
    null,
    undefined,
    "",
    "   ",
    "unknown",
    "_hidden",
    "localhost",
    "198.51.100",
    "198.51.100.256",
    "01.2.3.4",
    "1.2.3.4.5",
    "2001:db8::1::2",
    "198.51.100.4, 10.0.0.1",
    "[198.51.100.4]:port",
    "<script>",
    `::ffff:${"0".repeat(70)}`,
  ]) {
    assert.equal(normalizeIp(value), null, String(value));
  }
});

test("proxy mode uses the X-Forwarded-For hop the reverse proxy appended", () => {
  const ip = (forwardedFor: string) => clientIp(new Headers({ "x-forwarded-for": forwardedFor }), "proxy");
  assert.equal(ip("198.51.100.4"), "198.51.100.4");
  assert.equal(ip("203.0.113.66, 198.51.100.4"), "198.51.100.4");
  assert.equal(ip("203.0.113.66,203.0.113.67,198.51.100.4"), "198.51.100.4");
  assert.equal(ip("garbage, 10.0.0.1, 2001:DB8::7"), "2001:db8::7");
  assert.equal(ip("203.0.113.66, [2001:db8::7]:4711"), "2001:db8::7");
  assert.equal(ip("203.0.113.66, ::ffff:198.51.100.4"), "198.51.100.4");
});

test("proxy mode never falls back to entries a client prepended", () => {
  const ip = (forwardedFor: string) => clientIp(new Headers({ "x-forwarded-for": forwardedFor }), "proxy");
  assert.equal(ip("203.0.113.66, not-an-address"), null);
  assert.equal(ip("203.0.113.66, "), null);
  assert.equal(ip("203.0.113.66,"), null);
  const repeated = new Headers();
  repeated.append("x-forwarded-for", "203.0.113.66");
  repeated.append("x-forwarded-for", "198.51.100.4");
  assert.equal(clientIp(repeated, "proxy"), "198.51.100.4");
});

test("proxy mode ignores X-Real-IP and Cloudflare headers", () => {
  const others = new Headers(SPOOFED);
  others.delete("x-forwarded-for");
  assert.equal(clientIp(others, "proxy"), null);
  assert.equal(
    clientIp(new Headers({ ...SPOOFED, "x-forwarded-for": "203.0.113.66, 198.51.100.4" }), "proxy"),
    "198.51.100.4",
  );
  assert.equal(clientIp(new Headers(), "proxy"), null);
});

test("cloudflare mode trusts only CF-Connecting-IP", () => {
  assert.equal(
    clientIp(new Headers({ ...SPOOFED, "cf-connecting-ip": "198.51.100.4" }), "cloudflare"),
    "198.51.100.4",
  );
  assert.equal(clientIp(new Headers({ "cf-connecting-ip": " 2001:DB8::7 " }), "cloudflare"), "2001:db8::7");
  assert.equal(clientIp(new Headers({ "x-forwarded-for": "198.51.100.4", "x-real-ip": "198.51.100.4" }), "cloudflare"), null);
  assert.equal(clientIp(new Headers({ "cf-connecting-ip": "198.51.100.4, 203.0.113.66" }), "cloudflare"), null);
  assert.equal(clientIp(new Headers({ "cf-connecting-ip": "unknown" }), "cloudflare"), null);
});

test("cloudflare mode reads the IPv6 header only behind a pseudo IPv4 address", () => {
  assert.equal(
    clientIp(new Headers({ "cf-connecting-ip": "240.16.0.1", "cf-connecting-ipv6": "2001:db8::7" }), "cloudflare"),
    "2001:db8::7",
  );
  assert.equal(clientIp(new Headers({ "cf-connecting-ip": "240.16.0.1" }), "cloudflare"), "240.16.0.1");
  assert.equal(
    clientIp(new Headers({ "cf-connecting-ip": "198.51.100.4", "cf-connecting-ipv6": "2001:db8::7" }), "cloudflare"),
    "198.51.100.4",
  );
});

test("Cloudflare headers count only in cloudflare mode", () => {
  for (const mode of ["proxy", "direct"] as const) {
    assert.equal(clientIp(new Headers({ "cf-connecting-ip": "198.51.100.4" }), mode), null, mode);
  }
});

test("direct mode trusts no request header", () => {
  assert.equal(clientIp(new Headers(SPOOFED), "direct"), null);
  assert.equal(clientIp(new Headers({ "x-llmhub-peer": "198.51.100.4" }), "direct"), null);
  assert.match(peerAddressHeader(), /^x-llmhub-peer-[0-9a-f]{24}$/);
  assert.equal(peerAddressHeader(), peerAddressHeader());
});

test("direct mode reads the socket peer even when a client sends forwarding headers", async () => {
  trackSocketPeers();
  trackSocketPeers();
  const header = peerAddressHeader();
  const seen: Record<IpMode, string | null>[] = [];
  const server = createServer((req, res) => {
    const headers = nodeHeaders(req.headers);
    seen.push(Object.fromEntries(MODES.map((mode) => [mode, clientIp(headers, mode)])) as Record<IpMode, string | null>);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address() as AddressInfo;
    for (const headers of [{}, SPOOFED, { ...SPOOFED, [header]: "203.0.113.71" }]) {
      const res = await fetch(`http://127.0.0.1:${port}/`, { headers });
      await res.arrayBuffer();
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  assert.deepEqual(
    seen.map((entry) => entry.direct),
    ["127.0.0.1", "127.0.0.1", "127.0.0.1"],
  );
  assert.deepEqual(
    seen.map((entry) => entry.proxy),
    [null, "203.0.113.66", "203.0.113.66"],
  );
});

test("key IP allowlists compare canonical addresses", () => {
  assert.equal(ipAllowed(["198.51.100.4"], "198.51.100.4"), true);
  assert.equal(ipAllowed(["2001:DB8:0::7"], "2001:db8::7"), true);
  assert.equal(ipAllowed(["::ffff:198.51.100.4"], "198.51.100.4"), true);
  assert.equal(ipAllowed(["198.51.100.4"], "198.51.100.5"), false);
  assert.equal(ipAllowed(["198.51.100.4", "not-an-address"], null), false);
  assert.equal(ipAllowed([], "198.51.100.4"), false);
});

test("rate limits count IPv6 clients per /64 and unresolved clients together", () => {
  assert.equal(clientBucket("198.51.100.4"), "198.51.100.4");
  assert.equal(clientBucket("2001:db8:1:2:3:4:5:6"), "2001:db8:1:2::/64");
  assert.equal(clientBucket("2001:db8:1:2::9"), "2001:db8:1:2::/64");
  assert.equal(clientBucket("2001:db8::1"), "2001:db8:0:0::/64");
  assert.equal(clientBucket("::1"), "0:0:0:0::/64");
  assert.equal(clientBucket(null), "unknown");
});

test("only the resolver reads client address headers or socket peers", () => {
  const offenders = listSourceFiles(SOURCE_ROOT)
    .filter((file) => file !== RESOLVER && ADDRESS_SOURCE.test(readFileSync(file, "utf8")))
    .map((file) => path.relative(SOURCE_ROOT, file));
  assert.deepEqual(offenders, []);
  assert.match(readFileSync(RESOLVER, "utf8"), ADDRESS_SOURCE);
});
