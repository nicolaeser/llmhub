import assert from "node:assert/strict";
import test from "node:test";
import { columnSort, compareSortValues, sortByColumn } from "@/components/console/table-sort";

test("the first click on a column sorts descending and the next click follows the header", () => {
  assert.deepEqual(columnSort({ column: "lastUsed", direction: "ascending" }, null), {
    column: "lastUsed",
    direction: "descending",
  });
  const current = { column: "lastUsed", direction: "descending" as const };
  assert.deepEqual(columnSort({ column: "lastUsed", direction: "ascending" }, current), {
    column: "lastUsed",
    direction: "ascending",
  });
  assert.deepEqual(columnSort({ column: "name", direction: "ascending" }, current), {
    column: "name",
    direction: "descending",
  });
});

test("column sorting keeps the original order until a header is chosen", () => {
  const rows = [{ name: "b" }, { name: "a" }];
  assert.equal(sortByColumn(rows, null, (row) => row.name), rows);
});

test("dates and numbers put the latest or largest first, and missing values at the opposite end", () => {
  const rows = [
    { name: "never", used: null, spend: 0 },
    { name: "older", used: 10, spend: 2 },
    { name: "newer", used: 20, spend: 2 },
    { name: "item-10", used: 15, spend: 1 },
    { name: "item-2", used: 15, spend: 3 },
  ];
  const value = (row: (typeof rows)[number], column: string) => {
    if (column === "used") return row.used;
    if (column === "spend") return row.spend;
    return row.name;
  };
  assert.deepEqual(
    sortByColumn(rows, { column: "used", direction: "descending" }, value).map((row) => row.name),
    ["newer", "item-10", "item-2", "older", "never"],
  );
  assert.deepEqual(
    sortByColumn(rows, { column: "used", direction: "ascending" }, value).map((row) => row.name),
    ["never", "older", "item-10", "item-2", "newer"],
  );
  assert.deepEqual(
    sortByColumn(rows, { column: "name", direction: "ascending" }, value).map((row) => row.name),
    ["item-2", "item-10", "never", "newer", "older"],
  );
  assert.equal(compareSortValues(false, true), -1);
});
