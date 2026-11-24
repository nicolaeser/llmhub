import assert from "node:assert/strict";
import test from "node:test";
import { addressInText, joinBasePath, normalizeBaseUrl, rebaseTools, toolUrl } from "@/lib/mcp/base-url";

test("base URLs accept bare hosts and drop query, hash, and trailing slashes", () => {
  assert.equal(normalizeBaseUrl("api.example.com/v2/"), "https://api.example.com/v2");
  assert.equal(normalizeBaseUrl(" http://10.0.0.5:8080/v1?x=1#y "), "http://10.0.0.5:8080/v1");
  assert.equal(normalizeBaseUrl("localhost:3000"), "https://localhost:3000");
  assert.equal(normalizeBaseUrl("ftp://example.com"), "ftp://example.com");
  assert.equal(normalizeBaseUrl("not a url"), "not a url");
  assert.equal(normalizeBaseUrl(""), "");
});

test("tool paths join the base path once", () => {
  assert.equal(joinBasePath("/v2", "/v2/orders"), "/v2/orders");
  assert.equal(joinBasePath("/v2", "/orders"), "/v2/orders");
  assert.equal(joinBasePath("", "/orders"), "/orders");
  assert.equal(toolUrl("api.example.com/v2", "/v2/orders/{id}"), "https://api.example.com/v2/orders/{id}");
  assert.deepEqual(rebaseTools("https://x.example.com/v2", [{ path: "/v2/a" }, { path: "/b" }]), [{ path: "/a" }, { path: "/b" }]);
});

test("an address in the instruction is found without matching file or library names", () => {
  assert.equal(addressInText("The API runs under api.example.com."), "https://api.example.com");
  assert.equal(addressInText("Use https://api.example.com/v2/ please"), "https://api.example.com/v2");
  assert.equal(addressInText("Read only, built with Node.js from openapi.json"), "");
});
