import assert from "node:assert/strict";
import test from "node:test";
import {
  auditLogWhere,
  createdAtRange,
  logFilterParams,
  logFiltersFromSearch,
  logsHref,
  parseLogFilters,
  requestLogWhere,
  spendEventWhere,
  zonedLogFilters,
} from "@/lib/gateway/request-logs/request-log-query";

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

test("createdAtRange reads instants with offsets and treats wall-clock input without one as UTC", () => {
  assert.deepEqual(createdAtRange("2026-10-01T00:00:00+02:00", "2026-10-06T23:59:59.999+02:00"), {
    gte: new Date("2026-09-30T22:00:00.000Z"),
    lte: new Date("2026-10-06T21:59:59.999Z"),
  });
  assert.deepEqual(createdAtRange("2026-10-06T12:00", ""), { gte: new Date("2026-10-06T12:00:00.000Z") });
});

test("zonedLogFilters turns date filters into instants for whole days in the console time zone", () => {
  const filters = parseLogFilters({ model: "m", from: "2026-10-01", to: "2026-10-06" });
  assert.deepEqual(zonedLogFilters(filters, "Europe/Berlin"), {
    ...filters,
    from: "2026-09-30T22:00:00.000Z",
    to: "2026-10-06T21:59:59.999Z",
  });
  assert.deepEqual(zonedLogFilters(filters, "UTC"), {
    ...filters,
    from: "2026-10-01T00:00:00.000Z",
    to: "2026-10-06T23:59:59.999Z",
  });
  assert.deepEqual(zonedLogFilters(filters, "America/New_York"), {
    ...filters,
    from: "2026-10-01T04:00:00.000Z",
    to: "2026-10-07T03:59:59.999Z",
  });
});

test("zonedLogFilters follows daylight saving changes and leaves unambiguous or invalid input alone", () => {
  const dst = zonedLogFilters(parseLogFilters({ from: "2026-10-25", to: "2026-10-25" }), "Europe/Berlin");
  assert.equal(dst.from, "2026-10-24T22:00:00.000Z");
  assert.equal(dst.to, "2026-10-25T22:59:59.999Z");
  const winter = zonedLogFilters(parseLogFilters({ from: "2026-12-01" }), "Europe/Berlin");
  assert.equal(winter.from, "2026-11-30T23:00:00.000Z");
  assert.equal(winter.to, "");
  const wallClock = zonedLogFilters(parseLogFilters({ from: "2026-10-06T12:00" }), "Europe/Berlin");
  assert.equal(wallClock.from, "2026-10-06T10:00:00.000Z");
  const instants = parseLogFilters({ from: "2026-10-06T12:00:00.000Z", to: "2026-10-07T12:00:00+05:30" });
  assert.deepEqual(zonedLogFilters(instants, "Europe/Berlin"), instants);
  const invalid = parseLogFilters({ from: "2026-13-45", to: "nope" });
  assert.deepEqual(zonedLogFilters(invalid, "Europe/Berlin"), invalid);
});

test("zoned date filters select the same rows on the server as the console shows for those days", () => {
  const zoned = zonedLogFilters(parseLogFilters({ from: "2026-10-01", to: "2026-10-06" }), "Europe/Berlin");
  assert.deepEqual(requestLogWhere(zoned, {}).createdAt, {
    gte: new Date("2026-09-30T22:00:00.000Z"),
    lte: new Date("2026-10-06T21:59:59.999Z"),
  });
});

test("requestLogWhere intersects another user filter with the owner scope instead of replacing it", () => {
  const filters = parseLogFilters({ userId: "someone", keyId: "k1", status: "429", endpoint: "/v1/chat" });
  assert.deepEqual(requestLogWhere(filters, { userId: "me" }), {
    AND: [{ userId: "someone", keyId: "k1" }, { userId: "me" }],
    status: 429,
    endpoint: { contains: "/v1/chat" },
  });
  assert.deepEqual(requestLogWhere(filters, {}).AND, [{ userId: "someone", keyId: "k1" }, {}]);
});

test("requestLogWhere keeps company users inside their company", () => {
  const filters = parseLogFilters({ keyId: "k1" });
  assert.deepEqual(requestLogWhere(filters, { orgId: "org_a" }), { AND: [{ keyId: "k1" }, { orgId: "org_a" }] });
  assert.deepEqual(requestLogWhere(filters, { orgId: "org_a", userId: "me" }), {
    AND: [{ keyId: "k1" }, { orgId: "org_a", userId: "me" }],
  });
});

test("requestLogWhere filters PII rows across prompt and response markers", () => {
  const where = requestLogWhere(parseLogFilters({ pii: true, status: "abc" }), {});
  assert.deepEqual(where, {
    AND: [{}, {}],
    OR: [{ piiInput: { isEmpty: false } }, { piiOutput: { isEmpty: false } }],
  });
});

test("spend and audit filters reuse the scope and date range", () => {
  const filters = parseLogFilters({ model: "m", keyId: "k", from: "2026-10-01", pii: true, endpoint: "/v1" });
  assert.deepEqual(spendEventWhere(filters, { userId: "me" }), {
    AND: [{ keyId: "k", model: "m" }, { userId: "me" }],
    createdAt: { gte: new Date("2026-10-01T00:00:00.000Z") },
  });
  assert.deepEqual(auditLogWhere(filters), { createdAt: { gte: new Date("2026-10-01T00:00:00.000Z") } });
  assert.deepEqual(auditLogWhere(parseLogFilters({})), {});
});

test("log filters round-trip through URL params and drop empty values", () => {
  const filters = parseLogFilters({ keyId: "k1", userId: "u1", pii: true, from: "2026-10-01" });
  const params = logFilterParams(filters);
  assert.deepEqual(params, {
    model: null,
    status: null,
    endpoint: null,
    keyId: "k1",
    userId: "u1",
    pii: "1",
    from: "2026-10-01",
    to: null,
  });
  const search = new URLSearchParams(Object.entries(params).flatMap(([name, value]) => (value === null ? [] : [[name, value]])));
  assert.deepEqual(logFiltersFromSearch(`?${search}`), filters);
  assert.deepEqual(logFiltersFromSearch("?keyId=%20k2%20&tab=x&pii=0"), parseLogFilters({ keyId: "k2" }));
  assert.deepEqual(logFiltersFromSearch(""), parseLogFilters({}));
});

test("logsHref links to the filtered logs and to the plain page without filters", () => {
  assert.equal(logsHref({ keyId: "k 1" }), "/logs?keyId=k+1");
  assert.equal(logsHref({ userId: "u1", pii: false }), "/logs?userId=u1");
  assert.equal(logsHref({}), "/logs");
});
