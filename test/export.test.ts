import assert from "node:assert/strict";
import test from "node:test";
import { toCsv, toJsonl } from "@/lib/http/export";

test("toCsv writes headers and escaped values", () => {
  const csv = toCsv([
    { model: "gpt", spend: 1.5 },
    { model: 'a, "b"', spend: 2 },
  ]);
  assert.match(csv, /^model,spend\n/);
  assert.match(csv, /"a, ""b"""/);
});

test("toJsonl writes one object per line", () => {
  const out = toJsonl([{ a: 1 }, { b: 2 }]);
  const lines = out.trim().split("\n");
  assert.equal(lines.length, 2);
  assert.deepEqual(JSON.parse(lines[0]), { a: 1 });
});
