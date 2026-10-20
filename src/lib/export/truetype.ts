import "server-only";
import type { TrueTypeFont, TrueTypeTable } from "@/types/export";

const ARG_WORDS = 0x0001;
const HAS_SCALE = 0x0008;
const MORE_COMPONENTS = 0x0020;
const HAS_XY_SCALE = 0x0040;
const HAS_TWO_BY_TWO = 0x0080;
const OPTIONAL_TABLES = ["cvt ", "fpgm", "prep"];
const CHECKSUM_MAGIC = 0xb1b0afba;

function table(tables: ReadonlyMap<string, TrueTypeTable>, tag: string): TrueTypeTable {
  const found = tables.get(tag);
  if (!found) throw new Error("PDF_FONT_INVALID");
  return found;
}

function readFormat4(bytes: Buffer, at: number, out: Map<number, number>) {
  const segments = bytes.readUInt16BE(at + 6) / 2;
  const ends = at + 14;
  const starts = ends + segments * 2 + 2;
  const deltas = starts + segments * 2;
  const ranges = deltas + segments * 2;
  for (let segment = 0; segment < segments; segment++) {
    const start = bytes.readUInt16BE(starts + segment * 2);
    const end = bytes.readUInt16BE(ends + segment * 2);
    const delta = bytes.readUInt16BE(deltas + segment * 2);
    const rangeAt = ranges + segment * 2;
    const range = bytes.readUInt16BE(rangeAt);
    for (let code = start; code <= end && code !== 0xffff; code++) {
      const indexed = range === 0 ? code : bytes.readUInt16BE(rangeAt + range + (code - start) * 2);
      if (range !== 0 && indexed === 0) continue;
      const gid = (indexed + delta) & 0xffff;
      if (gid !== 0) out.set(code, gid);
    }
  }
}

function readFormat12(bytes: Buffer, at: number, out: Map<number, number>) {
  const groups = bytes.readUInt32BE(at + 12);
  for (let group = 0; group < groups; group++) {
    const record = at + 16 + group * 12;
    const start = bytes.readUInt32BE(record);
    const end = bytes.readUInt32BE(record + 4);
    const first = bytes.readUInt32BE(record + 8);
    for (let code = start; code <= end; code++) out.set(code, first + code - start);
  }
}

function readCmap(bytes: Buffer, cmap: TrueTypeTable): Map<number, number> {
  const count = bytes.readUInt16BE(cmap.offset + 2);
  const subtables = Array.from({ length: count }, (_, index) => {
    const record = cmap.offset + 4 + index * 8;
    const offset = cmap.offset + bytes.readUInt32BE(record + 4);
    return {
      platform: bytes.readUInt16BE(record),
      encoding: bytes.readUInt16BE(record + 2),
      format: bytes.readUInt16BE(offset),
      offset,
    };
  });
  const unicode = (subtable: (typeof subtables)[number]) =>
    subtable.platform === 0 || (subtable.platform === 3 && (subtable.encoding === 1 || subtable.encoding === 10));
  const out = new Map<number, number>();
  const full = subtables.find((subtable) => subtable.format === 12 && unicode(subtable));
  const basic = subtables.find((subtable) => subtable.format === 4 && unicode(subtable));
  if (full) readFormat12(bytes, full.offset, out);
  else if (basic) readFormat4(bytes, basic.offset, out);
  else throw new Error("PDF_FONT_INVALID");
  return out;
}

export function parseTrueType(bytes: Buffer): TrueTypeFont {
  const count = bytes.readUInt16BE(4);
  const tables = new Map<string, TrueTypeTable>();
  for (let index = 0; index < count; index++) {
    const record = 12 + index * 16;
    tables.set(bytes.toString("latin1", record, record + 4), {
      offset: bytes.readUInt32BE(record + 8),
      length: bytes.readUInt32BE(record + 12),
    });
  }
  const head = table(tables, "head").offset;
  const hhea = table(tables, "hhea").offset;
  const hmtx = table(tables, "hmtx").offset;
  const loca = table(tables, "loca").offset;
  const numGlyphs = bytes.readUInt16BE(table(tables, "maxp").offset + 4);
  const metrics = bytes.readUInt16BE(hhea + 34);
  const longLoca = bytes.readInt16BE(head + 50) === 1;
  const advances = new Uint16Array(numGlyphs);
  for (let gid = 0; gid < numGlyphs; gid++) advances[gid] = bytes.readUInt16BE(hmtx + Math.min(gid, metrics - 1) * 4);
  const offsets = new Uint32Array(numGlyphs + 1);
  for (let gid = 0; gid <= numGlyphs; gid++) {
    offsets[gid] = longLoca ? bytes.readUInt32BE(loca + gid * 4) : bytes.readUInt16BE(loca + gid * 2) * 2;
  }
  const ascent = bytes.readInt16BE(hhea + 4);
  const os2 = tables.get("OS/2");
  const os2Version = os2 ? bytes.readUInt16BE(os2.offset) : 0;
  const post = tables.get("post");
  return {
    bytes,
    tables,
    unitsPerEm: bytes.readUInt16BE(head + 18),
    numGlyphs,
    glyphs: readCmap(bytes, table(tables, "cmap")),
    advances,
    loca: offsets,
    bbox: [bytes.readInt16BE(head + 36), bytes.readInt16BE(head + 38), bytes.readInt16BE(head + 40), bytes.readInt16BE(head + 42)],
    ascent,
    descent: bytes.readInt16BE(hhea + 6),
    capHeight: os2 && os2Version >= 2 && os2.length >= 90 ? bytes.readInt16BE(os2.offset + 88) : ascent,
    italicAngle: post ? bytes.readInt16BE(post.offset + 4) + bytes.readUInt16BE(post.offset + 6) / 65536 : 0,
    weight: os2 ? bytes.readUInt16BE(os2.offset + 4) : 400,
  };
}

function glyphData(font: TrueTypeFont, gid: number): Buffer {
  const glyf = table(font.tables, "glyf").offset;
  return font.bytes.subarray(glyf + font.loca[gid]!, glyf + font.loca[gid + 1]!);
}

function components(data: Buffer): number[] {
  if (data.length < 10 || data.readInt16BE(0) >= 0) return [];
  const out: number[] = [];
  let at = 10;
  let flags: number;
  do {
    flags = data.readUInt16BE(at);
    out.push(data.readUInt16BE(at + 2));
    at += 4 + (flags & ARG_WORDS ? 4 : 2);
    at += flags & HAS_SCALE ? 2 : flags & HAS_XY_SCALE ? 4 : flags & HAS_TWO_BY_TWO ? 8 : 0;
  } while (flags & MORE_COMPONENTS);
  return out;
}

function checksum(data: Buffer): number {
  const padded = data.length % 4 === 0 ? data : Buffer.concat([data, Buffer.alloc(4 - (data.length % 4))]);
  let sum = 0;
  for (let at = 0; at < padded.length; at += 4) sum = (sum + padded.readUInt32BE(at)) >>> 0;
  return sum;
}

const pad = (data: Buffer) => (data.length % 4 === 0 ? data : Buffer.concat([data, Buffer.alloc(4 - (data.length % 4))]));

function sfnt(entries: [string, Buffer][]): Buffer {
  const sorted = entries.sort(([a], [b]) => (a < b ? -1 : 1));
  const power = 2 ** Math.floor(Math.log2(sorted.length));
  const header = Buffer.alloc(12 + sorted.length * 16);
  header.writeUInt32BE(0x00010000, 0);
  header.writeUInt16BE(sorted.length, 4);
  header.writeUInt16BE(power * 16, 6);
  header.writeUInt16BE(Math.log2(power), 8);
  header.writeUInt16BE(sorted.length * 16 - power * 16, 10);
  let offset = header.length;
  let headAt = 0;
  sorted.forEach(([tag, data], index) => {
    const record = 12 + index * 16;
    header.write(tag, record, 4, "latin1");
    header.writeUInt32BE(checksum(data), record + 4);
    header.writeUInt32BE(offset, record + 8);
    header.writeUInt32BE(data.length, record + 12);
    if (tag === "head") headAt = offset;
    offset += pad(data).length;
  });
  const font = Buffer.concat([header, ...sorted.map(([, data]) => pad(data))]);
  font.writeUInt32BE((CHECKSUM_MAGIC - checksum(font)) >>> 0, headAt + 8);
  return font;
}

export function subsetTrueType(font: TrueTypeFont, used: Iterable<number>): Buffer {
  const keep = new Set<number>();
  const visit = (gid: number) => {
    if (keep.has(gid) || gid >= font.numGlyphs) return;
    keep.add(gid);
    components(glyphData(font, gid)).forEach(visit);
  };
  visit(0);
  for (const gid of used) visit(gid);

  const hmtx = table(font.tables, "hmtx").offset;
  const metrics = font.bytes.readUInt16BE(table(font.tables, "hhea").offset + 34);
  const glyphs: Buffer[] = [];
  const loca = Buffer.alloc((font.numGlyphs + 1) * 4);
  const widths = Buffer.alloc(font.numGlyphs * 4);
  let size = 0;
  for (let gid = 0; gid < font.numGlyphs; gid++) {
    loca.writeUInt32BE(size, gid * 4);
    if (!keep.has(gid)) continue;
    const data = pad(glyphData(font, gid));
    glyphs.push(data);
    size += data.length;
    const bearing = gid < metrics ? hmtx + gid * 4 + 2 : hmtx + metrics * 4 + (gid - metrics) * 2;
    widths.writeUInt16BE(font.advances[gid]!, gid * 4);
    widths.writeInt16BE(font.bytes.readInt16BE(bearing), gid * 4 + 2);
  }
  loca.writeUInt32BE(size, font.numGlyphs * 4);

  const copy = (tag: string) => {
    const { offset, length } = table(font.tables, tag);
    return Buffer.from(font.bytes.subarray(offset, offset + length));
  };
  const head = copy("head");
  head.writeUInt32BE(0, 8);
  head.writeInt16BE(1, 50);
  const hhea = copy("hhea");
  hhea.writeUInt16BE(font.numGlyphs, 34);

  return sfnt([
    ["head", head],
    ["hhea", hhea],
    ["maxp", copy("maxp")],
    ["hmtx", widths],
    ["loca", loca],
    ["glyf", Buffer.concat(glyphs)],
    ...OPTIONAL_TABLES.filter((tag) => font.tables.has(tag)).map((tag): [string, Buffer] => [tag, copy(tag)]),
  ]);
}
