import { createCipheriv, createHmac, pbkdf2Sync, randomBytes, type Cipheriv } from "node:crypto";
import { createDeflateRaw } from "node:zlib";
import { piped } from "@/lib/compliance-archive/streams";
import type { ArchiveEntry } from "@/types/archive";

const LOCAL_SIGNATURE = 0x04034b50;
const DESCRIPTOR_SIGNATURE = 0x08074b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const ZIP64_END_SIGNATURE = 0x06064b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const END_SIGNATURE = 0x06054b50;

const VERSION_MADE_BY = (3 << 8) | 63;
const VERSION_NEEDED_AES = 51;
const VERSION_NEEDED_ZIP64 = 45;
const FLAG_ENCRYPTED = 0x0001;
const FLAG_DATA_DESCRIPTOR = 0x0008;
const FLAG_UTF8 = 0x0800;
const METHOD_AES = 99;
const METHOD_DEFLATE = 8;
const UNIX_FILE_MODE = 0o100644;
const MAX_32 = 0xffffffff;

const ZIP64_EXTRA_ID = 0x0001;
const AES_EXTRA_ID = 0x9901;
const AES_VENDOR_VERSION_AE2 = 2;
const AES_STRENGTH_256 = 3;

export const AES_SALT_BYTES = 16;
export const AES_KEY_BYTES = 32;
export const AES_VERIFIER_BYTES = 2;
export const AES_AUTH_BYTES = 10;
export const AES_PBKDF2_ITERATIONS = 1000;
const BLOCK = 16;

export function dosDateTime(at: Date): { time: number; date: number } {
  const year = Math.min(2107, Math.max(1980, at.getUTCFullYear()));
  return {
    time: (at.getUTCHours() << 11) | (at.getUTCMinutes() << 5) | (at.getUTCSeconds() >> 1),
    date: ((year - 1980) << 9) | ((at.getUTCMonth() + 1) << 5) | at.getUTCDate(),
  };
}

export function deriveAesKeys(password: string, salt: Buffer): { key: Buffer; macKey: Buffer; verifier: Buffer } {
  const derived = pbkdf2Sync(Buffer.from(password, "utf8"), salt, AES_PBKDF2_ITERATIONS, AES_KEY_BYTES * 2 + AES_VERIFIER_BYTES, "sha1");
  return {
    key: derived.subarray(0, AES_KEY_BYTES),
    macKey: derived.subarray(AES_KEY_BYTES, AES_KEY_BYTES * 2),
    verifier: derived.subarray(AES_KEY_BYTES * 2),
  };
}

export class WinZipAesCtr {
  private readonly cipher: Cipheriv;
  private position = 0;

  constructor(key: Buffer) {
    this.cipher = createCipheriv("aes-256-ecb", key, null);
    this.cipher.setAutoPadding(false);
  }

  update(data: Buffer): Buffer {
    if (!data.length) return Buffer.alloc(0);
    const firstBlock = Math.floor(this.position / BLOCK);
    const lastBlock = Math.floor((this.position + data.length - 1) / BLOCK);
    const counters = Buffer.alloc((lastBlock - firstBlock + 1) * BLOCK);
    for (let block = firstBlock; block <= lastBlock; block += 1) {
      const counter = block + 1;
      const offset = (block - firstBlock) * BLOCK;
      counters.writeUInt32LE(counter % 0x100000000, offset);
      counters.writeUInt32LE(Math.floor(counter / 0x100000000), offset + 4);
    }
    const stream = this.cipher.update(counters);
    const skip = this.position % BLOCK;
    const out = Buffer.allocUnsafe(data.length);
    for (let index = 0; index < data.length; index += 1) out[index] = data[index] ^ stream[skip + index];
    this.position += data.length;
    return out;
  }
}

function aesExtra(): Buffer {
  const extra = Buffer.alloc(11);
  extra.writeUInt16LE(AES_EXTRA_ID, 0);
  extra.writeUInt16LE(7, 2);
  extra.writeUInt16LE(AES_VENDOR_VERSION_AE2, 4);
  extra.write("AE", 6, "ascii");
  extra.writeUInt8(AES_STRENGTH_256, 8);
  extra.writeUInt16LE(METHOD_DEFLATE, 9);
  return extra;
}

function zip64Extra(uncompressed: number, compressed: number): Buffer {
  const extra = Buffer.alloc(20);
  extra.writeUInt16LE(ZIP64_EXTRA_ID, 0);
  extra.writeUInt16LE(16, 2);
  extra.writeBigUInt64LE(BigInt(uncompressed), 4);
  extra.writeBigUInt64LE(BigInt(compressed), 12);
  return extra;
}

function localHeader(name: Buffer, stamp: { time: number; date: number }): Buffer {
  const extra = Buffer.concat([zip64Extra(0, 0), aesExtra()]);
  const header = Buffer.alloc(30);
  header.writeUInt32LE(LOCAL_SIGNATURE, 0);
  header.writeUInt16LE(VERSION_NEEDED_AES, 4);
  header.writeUInt16LE(FLAG_ENCRYPTED | FLAG_DATA_DESCRIPTOR | FLAG_UTF8, 6);
  header.writeUInt16LE(METHOD_AES, 8);
  header.writeUInt16LE(stamp.time, 10);
  header.writeUInt16LE(stamp.date, 12);
  header.writeUInt32LE(0, 14);
  header.writeUInt32LE(MAX_32, 18);
  header.writeUInt32LE(MAX_32, 22);
  header.writeUInt16LE(name.length, 26);
  header.writeUInt16LE(extra.length, 28);
  return Buffer.concat([header, name, extra]);
}

function dataDescriptor(compressed: number, uncompressed: number): Buffer {
  const descriptor = Buffer.alloc(24);
  descriptor.writeUInt32LE(DESCRIPTOR_SIGNATURE, 0);
  descriptor.writeUInt32LE(0, 4);
  descriptor.writeBigUInt64LE(BigInt(compressed), 8);
  descriptor.writeBigUInt64LE(BigInt(uncompressed), 16);
  return descriptor;
}

function centralHeader(name: Buffer, stamp: { time: number; date: number }, compressed: number, uncompressed: number): Buffer {
  const extra = Buffer.concat([zip64Extra(uncompressed, compressed), aesExtra()]);
  const header = Buffer.alloc(46);
  header.writeUInt32LE(CENTRAL_SIGNATURE, 0);
  header.writeUInt16LE(VERSION_MADE_BY, 4);
  header.writeUInt16LE(VERSION_NEEDED_AES, 6);
  header.writeUInt16LE(FLAG_ENCRYPTED | FLAG_DATA_DESCRIPTOR | FLAG_UTF8, 8);
  header.writeUInt16LE(METHOD_AES, 10);
  header.writeUInt16LE(stamp.time, 12);
  header.writeUInt16LE(stamp.date, 14);
  header.writeUInt32LE(0, 16);
  header.writeUInt32LE(MAX_32, 20);
  header.writeUInt32LE(MAX_32, 24);
  header.writeUInt16LE(name.length, 28);
  header.writeUInt16LE(extra.length, 30);
  header.writeUInt16LE(0, 32);
  header.writeUInt16LE(0, 34);
  header.writeUInt16LE(0, 36);
  header.writeUInt32LE((UNIX_FILE_MODE << 16) >>> 0, 38);
  header.writeUInt32LE(0, 42);
  return Buffer.concat([header, name, extra]);
}

function endRecords(centralOffset: number, centralSize: number): Buffer {
  const zip64End = Buffer.alloc(56);
  zip64End.writeUInt32LE(ZIP64_END_SIGNATURE, 0);
  zip64End.writeBigUInt64LE(BigInt(44), 4);
  zip64End.writeUInt16LE(VERSION_MADE_BY, 12);
  zip64End.writeUInt16LE(VERSION_NEEDED_ZIP64, 14);
  zip64End.writeUInt32LE(0, 16);
  zip64End.writeUInt32LE(0, 20);
  zip64End.writeBigUInt64LE(BigInt(1), 24);
  zip64End.writeBigUInt64LE(BigInt(1), 32);
  zip64End.writeBigUInt64LE(BigInt(centralSize), 40);
  zip64End.writeBigUInt64LE(BigInt(centralOffset), 48);
  const locator = Buffer.alloc(20);
  locator.writeUInt32LE(ZIP64_LOCATOR_SIGNATURE, 0);
  locator.writeUInt32LE(0, 4);
  locator.writeBigUInt64LE(BigInt(centralOffset + centralSize), 8);
  locator.writeUInt32LE(1, 16);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_SIGNATURE, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(Math.min(centralSize, MAX_32), 12);
  end.writeUInt32LE(Math.min(centralOffset, MAX_32), 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([zip64End, locator, end]);
}

export async function* zipAes(lines: AsyncIterable<Buffer>, entry: ArchiveEntry, password: string): AsyncGenerator<Buffer> {
  if (!password) throw new Error("PASSWORD_MISSING");
  const name = Buffer.from(entry.name, "utf8");
  const stamp = dosDateTime(entry.modified);
  const local = localHeader(name, stamp);
  yield local;
  const salt = randomBytes(AES_SALT_BYTES);
  const keys = deriveAesKeys(password, salt);
  yield salt;
  yield Buffer.from(keys.verifier);
  const ctr = new WinZipAesCtr(keys.key);
  const mac = createHmac("sha1", keys.macKey);
  let plainBytes = 0;
  let cipherBytes = 0;
  async function* counted() {
    for await (const line of lines) {
      plainBytes += line.length;
      yield line;
    }
  }
  for await (const chunk of piped(counted(), createDeflateRaw({ level: 6 }))) {
    const encrypted = ctr.update(chunk);
    mac.update(encrypted);
    cipherBytes += encrypted.length;
    yield encrypted;
  }
  yield mac.digest().subarray(0, AES_AUTH_BYTES);
  const compressed = AES_SALT_BYTES + AES_VERIFIER_BYTES + cipherBytes + AES_AUTH_BYTES;
  const descriptor = dataDescriptor(compressed, plainBytes);
  yield descriptor;
  const central = centralHeader(name, stamp, compressed, plainBytes);
  const centralOffset = local.length + compressed + descriptor.length;
  yield Buffer.concat([central, endRecords(centralOffset, central.length)]);
}
