import assert from "node:assert/strict";
import test from "node:test";
import {
  auditLogWhere,
  createdAtRange,
  parseLogFilters,
  requestLogWhere,
  spendEventWhere,
} from "@/lib/gateway/request-log-query";

test("parseLogFilters trims strings, caps lengths, and reads the PII flag from query strings", () => {
  const filters = parseLogFilters({ model: "  gpt  ", status: "4001", pii: "1", keyId: 7, extra: "x" });
  assert.deepEqual(filters, {
    model: "gpt",
    status: "400",
    endpoint: "",
    keyId: "",
    userId: "",
    pii: true,
    from: "",
    to: "",
  });
  assert.equal(parseLogFilters(null).pii, false);
  assert.equal(parseLogFilters({ pii: true }).pii, true);
});

test("createdAtRange includes the whole end day for date-only input", () => {
  assert.deepEqual(createdAtRange("2026-10-01", "2026-10-06"), {
    gte: new Date("2026-10-01T00:00:00.000Z"),
    lt: new Date("2026-10-07T00:00:00.000Z"),
  });
  assert.deepEqual(createdAtRange("", "2026-10-06T12:00:00.000Z"), {
    lte: new Date("2026-10-06T12:00:00.000Z"),
  });
  assert.equal(createdAtRange("nope", ""), undefined);
});

test("requestLogWhere scopes to the owner and ignores another user filter", () => {
  const filters = parseLogFilters({ userId: "someone", keyId: "k1", status: "429", endpoint: "/v1/chat" });
  assert.deepEqual(requestLogWhere(filters, "me"), {
    userId: "me",
    keyId: "k1",
    status: 429,
    endpoint: { contains: "/v1/chat" },
  });
  assert.deepEqual(requestLogWhere(filters, null).userId, "someone");
});

test("requestLogWhere filters PII rows across prompt and response markers", () => {
  const where = requestLogWhere(parseLogFilters({ pii: true, status: "abc" }), null);
  assert.deepEqual(where, {
    OR: [{ piiInput: { isEmpty: false } }, { piiOutput: { isEmpty: false } }],
  });
});

test("spend and audit filters reuse the scope and date range", () => {
  const filters = parseLogFilters({ model: "m", keyId: "k", from: "2026-10-01", pii: true, endpoint: "/v1" });
  assert.deepEqual(spendEventWhere(filters, "me"), {
    userId: "me",
    keyId: "k",
    model: "m",
    createdAt: { gte: new Date("2026-10-01T00:00:00.000Z") },
  });
  assert.deepEqual(auditLogWhere(filters), { createdAt: { gte: new Date("2026-10-01T00:00:00.000Z") } });
  assert.deepEqual(auditLogWhere(parseLogFilters({})), {});
});
