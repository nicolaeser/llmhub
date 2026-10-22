import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createClassifier, windowsOf } from "../../scripts/redactor/classify.mjs";
import { downloadFile, revisionFacts } from "../../scripts/redactor/fetch.mjs";
import { readSafetensors, tokenHead, tokenLogits } from "../../scripts/redactor/heads.mjs";
import { DEFAULT_REVISION, fileFacts, HEAD_CONFIG_FILE, MODEL_FILES, PINNED_FILES } from "../../scripts/redactor/model-files.mjs";
import { tokenOffsets, trimSpan } from "../../scripts/redactor/offsets.mjs";
import { createServer, parseInputs, serialQueue } from "../../scripts/redactor/server.mjs";
import { createDecoder } from "../../scripts/redactor/viterbi.mjs";

const TYPES = ["private_person", "private_email"];
const LABELS = ["O", ...TYPES.flatMap((type) => ["B", "I", "E", "S"].map((tag) => `${tag}-${type}`))];
const HIDDEN = LABELS.length - 1;

function oneHot(label: string, strength = 8): number[] {
  return LABELS.map((name) => (name === label ? strength : 0));
}

function safetensors(tensors: Record<string, { shape: number[]; values: number[] }>): Buffer {
  let offset = 0;
  const header: Record<string, unknown> = {};
  const parts: Buffer[] = [];
  for (const [name, tensor] of Object.entries(tensors)) {
    const data = Buffer.alloc(tensor.values.length * 4);
    tensor.values.forEach((value, i) => data.writeFloatLE(value, i * 4));
    header[name] = { dtype: "F32", shape: tensor.shape, data_offsets: [offset, offset + data.length] };
    offset += data.length;
    parts.push(data);
  }
  const json = Buffer.from(JSON.stringify(header));
  const size = Buffer.alloc(8);
  size.writeBigUInt64LE(BigInt(json.length));
  return Buffer.concat([size, json, ...parts]);
}

function identityHead(): Buffer {
  const weight: number[] = [];
  for (let c = 0; c < LABELS.length; c++) for (let k = 0; k < HIDDEN; k++) weight.push(c === k + 1 ? 1 : 0);
  return safetensors({
    "token_cls_head.weight": { shape: [LABELS.length, HIDDEN], values: weight },
    "token_cls_head.bias": { shape: [LABELS.length], values: LABELS.map((label) => (label === "O" ? 0.5 : 0)) },
    "sensitivity_head.weight": { shape: [1, HIDDEN], values: new Array(HIDDEN).fill(0) },
    "sensitivity_head.bias": { shape: [1], values: [0] },
  });
}

function stubLlama(words: string[], tags: Record<string, string>) {
  const calls: number[][] = [];
  return {
    calls,
    async health() {
      return true;
    },
    async tokenize(text: string) {
      assert.equal(words.join(""), text);
      return words.map((piece, id) => ({ id, piece }));
    },
    async embed(ids: number[]) {
      calls.push(ids);
      return ids.map((id) => {
        const tag = tags[words[id] ?? ""] ?? "O";
        const hot = LABELS.indexOf(tag);
        return Array.from({ length: HIDDEN }, (_, k) => (k + 1 === hot ? 8 : 0));
      });
    },
  };
}

test("the constrained BIOES Viterbi decoder never emits an invalid path and scores spans like the reference", () => {
  const decoder = createDecoder(LABELS);
  const logits = [
    oneHot("O"),
    oneHot("B-private_person"),
    oneHot("E-private_person"),
    oneHot("O"),
    oneHot("I-private_email"),
    oneHot("S-private_email"),
  ].map((row) => Float64Array.from(row));
  const spans = decoder.decode(logits);
  assert.deepEqual(
    spans.map((span: { label: string; first: number; last: number }) => [span.label, span.first, span.last]),
    [
      ["private_person", 1, 2],
      ["private_email", 5, 5],
    ],
  );
  assert.ok(spans.every((span: { score: number }) => span.score > 0.99 && span.score <= 1));
  assert.deepEqual(decoder.decode([Float64Array.from(oneHot("E-private_person"))]), []);
  assert.throws(() => createDecoder(["O", "B-x", "I-x", "S-x"]), /lacks E-x/);
});

test("token pieces map back to code point offsets, including bytes split inside an emoji", () => {
  const text = "Grüße 🎉 Ada";
  const pieces: (string | number[])[] = ["Gr", "ü", "ße", " ", [240, 159], [142, 137], " Ada"];
  const { offsets, points } = tokenOffsets(text, pieces);
  assert.deepEqual(offsets, [
    [0, 2],
    [2, 3],
    [3, 5],
    [5, 6],
    [6, 7],
    [6, 7],
    [7, 11],
  ]);
  assert.deepEqual(trimSpan(points, 7, 11), [8, 11]);
  assert.equal(trimSpan(points, 5, 6), null);
  assert.throws(() => tokenOffsets(text, ["Grüße"]), /do not cover/);
  assert.throws(() => tokenOffsets("ab", ["abc"]), /more bytes/);
});

test("the token head reads F32 safetensors and turns hidden states into label logits", () => {
  const tensors = readSafetensors(identityHead());
  const head = tokenHead(tensors, LABELS.length, HIDDEN);
  const [row] = tokenLogits(head, [[0, 2, ...new Array(HIDDEN - 2).fill(0)]]);
  assert.equal(row?.[0], 0.5);
  assert.equal(row?.[2], 2);
  assert.throws(() => tokenHead(tensors, LABELS.length + 1, HIDDEN), /must be/);
  assert.throws(() => tokenLogits(head, [[1, 2]]), new RegExp(`expected ${HIDDEN}`));
  assert.throws(() => readSafetensors(Buffer.from("tiny")), /truncated/);
});

test("windows cover every token once and overlap by the configured margin", () => {
  assert.deepEqual(windowsOf(3, 8, 2), [{ start: 0, end: 3, ownStart: 0, ownEnd: 3 }]);
  const windows = windowsOf(20, 8, 4);
  assert.equal(windows[0]?.start, 0);
  assert.equal(windows.at(-1)?.end, 20);
  for (let i = 1; i < windows.length; i++) {
    assert.equal(windows[i]?.ownStart, windows[i - 1]?.ownEnd);
    assert.equal((windows[i - 1]?.end ?? 0) - (windows[i]?.start ?? 0), 4);
  }
});

test("the classifier windows long inputs and reports spans once in code points", async () => {
  const words = ["Hi", " ", "Ada", " ", "Love", "lace", ",", " ", "mail", " ", "a@b.c", " ", "🎉", " ", "Bo", " ", "Ng"];
  const tags: Record<string, string> = {
    Ada: "B-private_person",
    Love: "I-private_person",
    lace: "E-private_person",
    "a@b.c": "S-private_email",
    Bo: "B-private_person",
    Ng: "E-private_person",
  };
  const llama = stubLlama(words, tags);
  const classifier = createClassifier({
    llama,
    tensors: readSafetensors(identityHead()),
    headConfig: { labels: LABELS, hidden_size: HIDDEN, viterbi_b_bias: 0, viterbi_e_bias: 0 },
    window: 8,
    overlap: 4,
  });
  const text = words.join("");
  const { spans, tokens } = await classifier.classify(text);
  assert.equal(tokens, words.length);
  assert.ok(llama.calls.length > 1);
  const points = Array.from(text);
  assert.deepEqual(
    spans.map((span: { entity_group: string; start: number; end: number }) => [span.entity_group, points.slice(span.start, span.end).join("")]),
    [
      ["private_person", "Ada Lovelace"],
      ["private_email", "a@b.c"],
      ["private_person", "Bo Ng"],
    ],
  );
  assert.deepEqual(await classifier.classify("   "), { spans: [], tokens: 0 });
});

test("the adapter speaks the token classification protocol and never echoes input text", async () => {
  assert.deepEqual(parseInputs({ inputs: "a" }), { texts: ["a"], single: true });
  assert.deepEqual(parseInputs({ inputs: ["a", "b"] }), { texts: ["a", "b"], single: false });
  assert.equal(parseInputs({ inputs: [1] }), null);
  assert.equal(parseInputs({ text: "a" }), null);

  const queue = serialQueue(1);
  const first = queue.run(() => new Promise((resolve) => setTimeout(() => resolve("done"), 10)));
  assert.equal(queue.run(async () => "late"), null);
  assert.equal(await first, "done");

  const classifier = {
    async classify(text: string) {
      if (text === "boom") throw Object.assign(new Error(`failed on ${text}`), { code: "LLAMA_MALFORMED" });
      const start = text.indexOf("Ada");
      return { spans: start < 0 ? [] : [{ entity_group: "private_person", score: 0.99, start, end: start + 3 }], tokens: 3 };
    },
  };
  let healthy = true;
  const llama = { health: async () => healthy };
  const server = createServer({ classifier, llama });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (route: string, body: unknown) =>
    fetch(`${base}${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    const single = await post("/v1/token-classification", { model: "pii-tracer", inputs: "I am Ada" });
    assert.deepEqual(await single.json(), [{ entity_group: "private_person", score: 0.99, start: 5, end: 8 }]);
    const batch = await post("/", { inputs: ["Ada", "nobody"] });
    assert.deepEqual(await batch.json(), [[{ entity_group: "private_person", score: 0.99, start: 0, end: 3 }], []]);
    const failed = await post("/v1/token-classification", { inputs: ["boom"] });
    assert.equal(failed.status, 502);
    assert.doesNotMatch(await failed.text(), /boom/);
    assert.equal((await post("/v1/token-classification", { inputs: 7 })).status, 400);
    assert.equal((await fetch(`${base}/v1/models`).then((res) => res.json())).data[0].id, "pii-tracer");
    assert.equal((await fetch(`${base}/health`)).status, 200);
    healthy = false;
    assert.equal((await fetch(`${base}/health`)).status, 503);
    assert.equal((await fetch(`${base}/elsewhere`)).status, 404);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("model files are pinned by revision and downloads are verified before they are kept", async () => {
  assert.deepEqual(Object.keys(PINNED_FILES[DEFAULT_REVISION] ?? {}).sort(), [...MODEL_FILES].sort());
  assert.equal(await revisionFacts("http://unused.invalid", DEFAULT_REVISION), PINNED_FILES[DEFAULT_REVISION]);
  const facts = fileFacts([
    { path: "pplx-pii-masking-backbone-f16.gguf", size: 10, oid: "x", lfs: { oid: "a".repeat(64), size: 10 } },
    { path: "heads.safetensors", size: 4, oid: "y", lfs: { oid: "b".repeat(64), size: 4 } },
    { path: HEAD_CONFIG_FILE, size: 2, oid: "c".repeat(40) },
    { path: "README.md", size: 1, oid: "d".repeat(40) },
  ]) as Record<string, unknown>;
  assert.deepEqual(facts[HEAD_CONFIG_FILE], { size: 2, gitSha1: "c".repeat(40) });
  assert.throws(() => fileFacts([]), /revision lacks/);

  const payload = Buffer.from('{"labels":[]}');
  const gitSha1 = createHash("sha1").update(`blob ${payload.length}\0`).update(payload).digest("hex");
  const server = http.createServer((req, res) => {
    if (req.url === "/moved") {
      res.writeHead(302, { location: "/file" });
      res.end();
      return;
    }
    res.writeHead(200, { "content-length": payload.length });
    res.end(payload);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const dir = await mkdtemp(path.join(tmpdir(), "llmhub-redactor-"));
  try {
    const file = path.join(dir, HEAD_CONFIG_FILE);
    await downloadFile({ url: `${base}/moved`, file, facts: { size: payload.length, gitSha1 }, name: HEAD_CONFIG_FILE });
    assert.equal(await readFile(file, "utf8"), payload.toString());
    assert.equal((await readFile(`${file}.verified`, "utf8")).trim(), `git-sha1:${gitSha1}`);
    const bad = path.join(dir, "heads.safetensors");
    await assert.rejects(
      downloadFile({ url: `${base}/file`, file: bad, facts: { size: payload.length, sha256: "0".repeat(64) }, name: "heads.safetensors" }),
      /does not match/,
    );
    await assert.rejects(stat(bad));
    await assert.rejects(stat(`${bad}.part`));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
