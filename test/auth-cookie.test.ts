import assert from "node:assert/strict";
import test from "node:test";
import { signSessionToken, verifySessionCookie } from "@/lib/auth/cookie";
import { randomToken } from "@/lib/crypto";

test("signed session cookies round-trip to the opaque token", async () => {
  const token = randomToken();
  assert.match(token, /^[0-9a-f]{64}$/);
  const cookie = await signSessionToken(token);
  assert.equal(await verifySessionCookie(cookie), token);
});

test("tampered or malformed session cookies are rejected", async () => {
  const token = randomToken();
  const cookie = await signSessionToken(token);
  const last = cookie.at(-1) === "a" ? "b" : "a";
  assert.equal(await verifySessionCookie(`${cookie.slice(0, -1)}${last}`), null);
  assert.equal(await verifySessionCookie(`${randomToken()}.${cookie.split(".")[1]}`), null);
  assert.equal(await verifySessionCookie(token), null);
  assert.equal(await verifySessionCookie(`${cookie}.extra`), null);
  assert.equal(await verifySessionCookie("not-a-cookie"), null);
});
