import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_USAGE_QUERY, usageHref, usageQueryFromSearch, usageQueryParams } from "@/lib/usage/usage-query";

test("usage filters read from the URL keep supported ranges and trim ids", () => {
  assert.deepEqual(usageQueryFromSearch(""), DEFAULT_USAGE_QUERY);
  assert.deepEqual(usageQueryFromSearch("?days=30&orgId=%20o1%20&keyId=k1&tab=overview&extra=x"), {
    ...DEFAULT_USAGE_QUERY,
    days: 30,
    orgId: "o1",
    keyId: "k1",
  });
  assert.equal(usageQueryFromSearch("?days=45").days, 14);
  assert.equal(usageQueryFromSearch("?days=abc").days, 14);
  assert.equal(usageQueryFromSearch(`?model=${"m".repeat(300)}`).model.length, 200);
  assert.deepEqual(usageQueryFromSearch("?teamId=t1&projectId=p1&memberId=m1&userId=u1&model=gpt"), {
    ...DEFAULT_USAGE_QUERY,
    teamId: "t1",
    projectId: "p1",
    memberId: "m1",
    userId: "u1",
    model: "gpt",
  });
});

test("usage filters write every key so cleared filters leave the URL and other params stay", () => {
  assert.deepEqual(usageQueryParams({ ...DEFAULT_USAGE_QUERY, teamId: "t1" }), {
    days: null,
    model: null,
    orgId: null,
    teamId: "t1",
    projectId: null,
    memberId: null,
    keyId: null,
    userId: null,
    labelKey: null,
    labelValue: null,
  });
  assert.equal(usageQueryParams({ ...DEFAULT_USAGE_QUERY, days: 90 }).days, "90");
  const query = { ...DEFAULT_USAGE_QUERY, days: 7, orgId: "o1", userId: "u1" };
  const params = new URLSearchParams("tab=overview");
  for (const [name, value] of Object.entries(usageQueryParams(query))) {
    if (value === null) params.delete(name);
    else params.set(name, value);
  }
  assert.equal(params.get("tab"), "overview");
  assert.deepEqual(usageQueryFromSearch(params.toString()), query);
});

test("usageHref links to the filtered overview", () => {
  assert.equal(usageHref({ orgId: "o1" }), "/usage?orgId=o1");
  assert.equal(usageHref({ keyId: "k 1", days: 30 }), "/usage?days=30&keyId=k+1");
  assert.equal(usageHref({}), "/usage");
});
