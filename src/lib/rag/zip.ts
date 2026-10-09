import { inflateRawSync } from "node:zlib";
import type { ZipEntry } from "@/types/rag";

const END_OF_DIRECTORY = 0x06054b50;
const DIRECTORY_ENTRY = 0x02014b50;
const LOCAL_HEADER = 0x04034b50;
const STORED = 0;
const DEFLATED = 8;
const MAX_ENTRY_BYTES = 200 * 1024 * 1024;

function endOfDirectory(buf: Buffer): number {
  const floor = Math.max(0, buf.length - 22 - 0xffff);
  for (let at = buf.length - 22; at >= floor; at--) {
    if (buf.readUInt32LE(at) === END_OF_DIRECTORY) return at;
  }
  return -1;
}

export function isZip(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

export function zipEntries(bytes: Uint8Array): ZipEntry[] {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buf.length < 22) return [];
  const end = endOfDirectory(buf);
  if (end < 0) return [];
  const count = buf.readUInt16LE(end + 10);
  let at = buf.readUInt32LE(end + 16);
  const entries: ZipEntry[] = [];
  for (let i = 0; i < count && at + 46 <= buf.length; i++) {
    if (buf.readUInt32LE(at) !== DIRECTORY_ENTRY) break;
    const nameLength = buf.readUInt16LE(at + 28);
    const extraLength = buf.readUInt16LE(at + 30);
    const commentLength = buf.readUInt16LE(at + 32);
    entries.push({
      name: buf.toString("utf8", at + 46, at + 46 + nameLength),
      method: buf.readUInt16LE(at + 10),
      compressedSize: buf.readUInt32LE(at + 20),
      uncompressedSize: buf.readUInt32LE(at + 24),
      localOffset: buf.readUInt32LE(at + 42),
    });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

export function readZipEntry(bytes: Uint8Array, entry: ZipEntry): Buffer | null {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const at = entry.localOffset;
  if (at + 30 > buf.length || buf.readUInt32LE(at) !== LOCAL_HEADER) return null;
  if (entry.uncompressedSize > MAX_ENTRY_BYTES) return null;
  const start = at + 30 + buf.readUInt16LE(at + 26) + buf.readUInt16LE(at + 28);
  const data = buf.subarray(start, start + entry.compressedSize);
  if (entry.method === STORED) return Buffer.from(data);
  if (entry.method !== DEFLATED) return null;
  try {
    return inflateRawSync(data, { maxOutputLength: MAX_ENTRY_BYTES });
  } catch {
    return null;
  }
}

export function readZipText(bytes: Uint8Array, entries: ZipEntry[], name: string): string | null {
  const entry = entries.find((item) => item.name === name);
  const data = entry ? readZipEntry(bytes, entry) : null;
  return data ? data.toString("utf8") : null;
}
