import assert from "node:assert/strict";
import test from "node:test";
import { SizedLru } from "@/lib/utils/sized-lru";

test("evicts the least recently used entries once the size budget is exceeded", () => {
  const lru = new SizedLru<string>(10);
  lru.set("a", "A", 4);
  lru.set("b", "B", 4);
  assert.equal(lru.get("a"), "A");
  lru.set("c", "C", 4);
  assert.equal(lru.get("b"), undefined);
  assert.equal(lru.get("a"), "A");
  assert.equal(lru.get("c"), "C");
  assert.equal(lru.size, 8);
  assert.equal(lru.count, 2);
});

test("replacing a key adjusts the used size", () => {
  const lru = new SizedLru<number>(10);
  lru.set("a", 1, 6);
  lru.set("a", 2, 3);
  assert.equal(lru.size, 3);
  assert.equal(lru.get("a"), 2);
});

test("entries larger than the budget are not kept and drop an older value", () => {
  const lru = new SizedLru<number>(10);
  lru.set("a", 1, 5);
  lru.set("a", 2, 11);
  assert.equal(lru.get("a"), undefined);
  assert.equal(lru.size, 0);
  lru.set("b", 3, 10);
  assert.equal(lru.get("b"), 3);
  lru.clear();
  assert.equal(lru.count, 0);
  assert.equal(lru.size, 0);
});
