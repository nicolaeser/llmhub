import assert from "node:assert/strict";
import test from "node:test";
import { clientIp } from "@/lib/http/api";

test("client ip is the hop the reverse proxy appended", () => {
  assert.equal(clientIp(new Headers({ "x-forwarded-for": "203.0.113.9" })), "203.0.113.9");
  assert.equal(
    clientIp(new Headers({ "x-forwarded-for": "10.6.6.6, 198.51.100.4" })),
    "198.51.100.4",
  );
  assert.equal(clientIp(new Headers({ "x-forwarded-for": " 198.51.100.4 , " })), "198.51.100.4");
});

test("client ip ignores headers a client can set through the proxy", () => {
  assert.equal(
    clientIp(new Headers({ "x-real-ip": "10.6.6.6", "cf-connecting-ip": "10.6.6.7" })),
    "",
  );
  assert.equal(clientIp(new Headers()), "");
});
