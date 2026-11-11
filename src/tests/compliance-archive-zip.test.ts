import assert from "node:assert/strict";
import { createCipheriv, createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import test from "node:test";
import { gunzipSync, inflateRawSync } from "node:zlib";
import { archiveEncoding } from "@/lib/compliance-archive/encoders";
import { jsonLines, piped } from "@/lib/compliance-archive/streams";
import { WinZipAesCtr, dosDateTime, zipAes } from "@/lib/compliance-archive/zip-aes";
import { createGzip } from "node:zlib";

const PASSWORD = "correct horse battery staple";
const MODIFIED = new Date("2026-11-11T00:15:42Z");

async function collect(source: AsyncIterable<Buffer>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of source) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function* from(chunks: Buffer[]): AsyncGenerator<Buffer> {
  for (const chunk of chunks) yield chunk;
}

function sampleLines(count: number): Buffer[] {
  return Array.from({ length: count }, (_, index) =>
    Buffer.from(`${JSON.stringify({ index, text: `zeile ${index} äöü ${"x".repeat(index % 97)}` })}\n`),
  );
}

function referenceKeystream(key: Buffer, length: number): Buffer {
  const blocks = Math.ceil(length / 16);
  const counters = Buffer.alloc(blocks * 16);
  for (let block = 0; block < blocks; block += 1) counters.writeBigUInt64LE(BigInt(block + 1), block * 16);
  const cipher = createCipheriv("aes-256-ecb", key, null);
  cipher.setAutoPadding(false);
  return cipher.update(counters).subarray(0, length);
}

type ParsedZip = {
  name: string;
  method: number;
  flags: number;
  versionNeeded: number;
  aesExtra: Buffer;
  compressed: number;
  uncompressed: number;
  payload: Buffer;
  descriptor: { compressed: number; uncompressed: number };
};

function parseZip(zip: Buffer): ParsedZip {
  const end = zip.length - 22;
  assert.equal(zip.readUInt32LE(end), 0x06054b50);
  const locator = end - 20;
  assert.equal(zip.readUInt32LE(locator), 0x07064b50);
  const zip64End = Number(zip.readBigUInt64LE(locator + 8));
  assert.equal(zip.readUInt32LE(zip64End), 0x06064b50);
  assert.equal(zip.readBigUInt64LE(zip64End + 32), BigInt(1));
  const centralOffset = Number(zip.readBigUInt64LE(zip64End + 48));
  assert.equal(zip.readUInt32LE(centralOffset), 0x02014b50);
  const nameLength = zip.readUInt16LE(centralOffset + 28);
  const extraLength = zip.readUInt16LE(centralOffset + 30);
  const name = zip.subarray(centralOffset + 46, centralOffset + 46 + nameLength).toString("utf8");
  const extra = zip.subarray(centralOffset + 46 + nameLength, centralOffset + 46 + nameLength + extraLength);
  let uncompressed = 0;
  let compressed = 0;
  let aesExtra: Buffer = Buffer.alloc(0);
  for (let offset = 0; offset < extra.length; ) {
    const id = extra.readUInt16LE(offset);
    const size = extra.readUInt16LE(offset + 2);
    const body = extra.subarray(offset + 4, offset + 4 + size);
    if (id === 0x0001) {
      uncompressed = Number(body.readBigUInt64LE(0));
      compressed = Number(body.readBigUInt64LE(8));
    }
    if (id === 0x9901) aesExtra = body;
    offset += 4 + size;
  }
  assert.equal(zip.readUInt32LE(0), 0x04034b50);
  const localName = zip.readUInt16LE(26);
  const localExtra = zip.readUInt16LE(28);
  const dataStart = 30 + localName + localExtra;
  const payload = zip.subarray(dataStart, dataStart + compressed);
  const descriptorAt = dataStart + compressed;
  assert.equal(zip.readUInt32LE(descriptorAt), 0x08074b50);
  return {
    name,
    method: zip.readUInt16LE(centralOffset + 10),
    flags: zip.readUInt16LE(centralOffset + 8),
    versionNeeded: zip.readUInt16LE(centralOffset + 6),
    aesExtra,
    compressed,
    uncompressed,
    payload,
    descriptor: {
      compressed: Number(zip.readBigUInt64LE(descriptorAt + 8)),
      uncompressed: Number(zip.readBigUInt64LE(descriptorAt + 16)),
    },
  };
}

function decrypt(payload: Buffer, password: string): Buffer {
  const salt = payload.subarray(0, 16);
  const verifier = payload.subarray(16, 18);
  const cipherText = payload.subarray(18, payload.length - 10);
  const auth = payload.subarray(payload.length - 10);
  const derived = pbkdf2Sync(password, salt, 1000, 66, "sha1");
  if (!derived.subarray(64).equals(verifier)) throw new Error("wrong password");
  const mac = createHmac("sha1", derived.subarray(32, 64)).update(cipherText).digest().subarray(0, 10);
  assert.deepEqual(mac, auth, "authentication code");
  const stream = referenceKeystream(derived.subarray(0, 32), cipherText.length);
  const plain = Buffer.alloc(cipherText.length);
  for (let index = 0; index < cipherText.length; index += 1) plain[index] = cipherText[index] ^ stream[index];
  return inflateRawSync(plain);
}

test("zipAes writes a single-entry WinZip AES-256 zip64 archive that decrypts to the input", async () => {
  const lines = sampleLines(3_000);
  const expected = Buffer.concat(lines);
  const zip = await collect(zipAes(from(lines), { name: "requests-2026-11-10.jsonl", modified: MODIFIED }, PASSWORD));
  const parsed = parseZip(zip);
  assert.equal(parsed.name, "requests-2026-11-10.jsonl");
  assert.equal(parsed.method, 99);
  assert.equal(parsed.versionNeeded, 51);
  assert.equal(parsed.flags & 0x0001, 0x0001);
  assert.equal(parsed.flags & 0x0008, 0x0008);
  assert.deepEqual([...parsed.aesExtra], [0x02, 0x00, 0x41, 0x45, 0x03, 0x08, 0x00]);
  assert.equal(parsed.uncompressed, expected.length);
  assert.deepEqual(parsed.descriptor, { compressed: parsed.compressed, uncompressed: expected.length });
  assert.ok(parsed.compressed < expected.length);
  assert.deepEqual(decrypt(parsed.payload, PASSWORD), expected);
});

test("zipAes uses a fresh salt per archive and rejects a wrong password through the verifier", async () => {
  const lines = sampleLines(10);
  const entry = { name: "audit-2026-11-10.jsonl", modified: MODIFIED };
  const first = parseZip(await collect(zipAes(from(lines), entry, PASSWORD)));
  const second = parseZip(await collect(zipAes(from(lines), entry, PASSWORD)));
  assert.notDeepEqual(first.payload.subarray(0, 16), second.payload.subarray(0, 16));
  assert.throws(() => decrypt(first.payload, "not the password"), /wrong password|authentication code/);
});

test("zipAes refuses to write without a password", async () => {
  await assert.rejects(collect(zipAes(from(sampleLines(1)), { name: "x.jsonl", modified: MODIFIED }, "")), /PASSWORD_MISSING/);
});

test("zipAes handles an empty day", async () => {
  const parsed = parseZip(await collect(zipAes(from([]), { name: "security-2026-11-10.jsonl", modified: MODIFIED }, PASSWORD)));
  assert.equal(parsed.uncompressed, 0);
  assert.deepEqual(decrypt(parsed.payload, PASSWORD), Buffer.alloc(0));
});

test("the WinZip counter keystream is identical however the data is split", () => {
  const key = randomBytes(32);
  const data = randomBytes(10_000);
  const whole = new WinZipAesCtr(key).update(data);
  const split = new WinZipAesCtr(key);
  const pieces: Buffer[] = [];
  for (let offset = 0, size = 1; offset < data.length; offset += size, size = (size * 7) % 61 + 1) {
    pieces.push(split.update(data.subarray(offset, offset + size)));
  }
  assert.deepEqual(Buffer.concat(pieces), whole);
  const stream = referenceKeystream(key, data.length);
  assert.deepEqual(Buffer.from(whole.map((byte, index) => byte ^ stream[index])), data);
});

test("dosDateTime encodes UTC time with two-second resolution", () => {
  const { time, date } = dosDateTime(MODIFIED);
  assert.equal(time >> 11, 0);
  assert.equal((time >> 5) & 0x3f, 15);
  assert.equal((time & 0x1f) * 2, 42);
  assert.equal((date >> 9) + 1980, 2026);
  assert.equal((date >> 5) & 0x0f, 11);
  assert.equal(date & 0x1f, 11);
});

test("jsonl and gzip encodings round-trip and count the records", async () => {
  const records = [{ id: "a", n: 1 }, { id: "b", text: "ü" }];
  const expected = Buffer.from(records.map((record) => `${JSON.stringify(record)}\n`).join(""));
  async function* source() {
    yield* records;
  }
  const tally = { rows: 0, bytes: 0, hash: createHash("sha256") };
  const plain = archiveEncoding("jsonl", "");
  assert.deepEqual(await collect(plain.encode(jsonLines(source(), tally), { name: "x", modified: MODIFIED })), expected);
  assert.equal(tally.rows, 2);
  assert.equal(tally.bytes, expected.length);
  assert.equal(tally.hash.digest("hex"), createHash("sha256").update(expected).digest("hex"));
  const gzip = archiveEncoding("jsonl_gzip", "");
  assert.equal(gzip.extension, ".jsonl.gz");
  const compressed = await collect(gzip.encode(jsonLines(source(), { rows: 0, bytes: 0, hash: createHash("sha256") }), { name: "x", modified: MODIFIED }));
  assert.deepEqual(gunzipSync(compressed), expected);
  assert.deepEqual(
    [archiveEncoding("zip_aes", PASSWORD).extension, archiveEncoding("zip_aes", PASSWORD).encryption],
    [".zip", "winzip-aes-256"],
  );
});

test("a failing record source fails the compressed stream instead of ending it early", async () => {
  async function* broken() {
    yield Buffer.from("first\n");
    throw new Error("database went away");
  }
  await assert.rejects(collect(piped(broken(), createGzip())), /database went away/);
  await assert.rejects(collect(zipAes(broken(), { name: "x.jsonl", modified: MODIFIED }, PASSWORD)), /database went away/);
});
