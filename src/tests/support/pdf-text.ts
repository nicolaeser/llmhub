import { inflateSync } from "node:zlib";

export type ShownGlyph = { code: number; text: string };
export type ShownRun = { face: string; glyphs: ShownGlyph[]; emboldened: boolean };
export type ShownText = { text: string; runs: ShownRun[] };
export type EmbeddedFont = { baseFont: string; outlined: Set<number>; glyphCount: number };
export type ReadPdf = { objectCount: number; texts: ShownText[]; fonts: Map<string, EmbeddedFont> };

type RawObject = { dict: string; stream?: Buffer };

function rawObjects(pdf: Buffer): RawObject[] {
  const raw = pdf.toString("latin1");
  const offsets = [...raw.matchAll(/^(\d{10}) 00000 n $/gm)].map((match) => Number(match[1]));
  return offsets.map((offset, index) => {
    const header = `${index + 1} 0 obj\n`;
    if (!raw.startsWith(header, offset)) throw new Error(`object ${index + 1} is not at its xref offset`);
    const start = offset + header.length;
    const rest = raw.slice(start);
    const streamAt = rest.indexOf(">>\nstream\n");
    const endAt = rest.indexOf("\nendobj\n");
    if (streamAt < 0 || streamAt > endAt) return { dict: rest.slice(0, endAt) };
    const dict = rest.slice(0, streamAt + 2);
    const length = Number(dict.match(/\/Length (\d+)/)?.[1]);
    const dataAt = start + streamAt + ">>\nstream\n".length;
    return { dict, stream: pdf.subarray(dataAt, dataAt + length) };
  });
}

const ref = (dict: string, key: string) => Number(dict.match(new RegExp(`/${key} \\[?(\\d+) 0 R`))?.[1]);

function toUnicode(cmap: string): Map<number, string> {
  const out = new Map<number, string>();
  for (const [, code, utf16] of cmap.matchAll(/<([0-9a-f]{4})> <([0-9a-f]+)>/g)) {
    const units = utf16!.match(/.{4}/g)!.map((unit) => parseInt(unit, 16));
    out.set(parseInt(code!, 16), String.fromCharCode(...units));
  }
  return out;
}

function outlinedGlyphs(program: Buffer): { outlined: Set<number>; glyphCount: number } {
  const tables = new Map<string, number>();
  for (let index = 0; index < program.readUInt16BE(4); index++) {
    const record = 12 + index * 16;
    tables.set(program.toString("latin1", record, record + 4), program.readUInt32BE(record + 8));
  }
  const glyphCount = program.readUInt16BE(tables.get("maxp")! + 4);
  const longLoca = program.readInt16BE(tables.get("head")! + 50) === 1;
  const loca = tables.get("loca")!;
  const offset = (gid: number) => (longLoca ? program.readUInt32BE(loca + gid * 4) : program.readUInt16BE(loca + gid * 2) * 2);
  const outlined = new Set<number>();
  for (let gid = 0; gid < glyphCount; gid++) if (offset(gid + 1) > offset(gid)) outlined.add(gid);
  return { outlined, glyphCount };
}

export function readPdf(bytes: Uint8Array): ReadPdf {
  const objects = rawObjects(Buffer.from(bytes));
  const at = (id: number) => objects[id - 1]!;
  const fonts = new Map<string, EmbeddedFont>();
  const maps = new Map<string, Map<number, string>>();
  const texts: ShownText[] = [];
  for (const page of objects.filter((object) => object.dict.includes("/Type /Page /Parent"))) {
    const resources = page.dict.match(/\/Font << ([^>]*) >>/)?.[1] ?? "";
    for (const [, name, id] of resources.matchAll(/\/(\S+) (\d+) 0 R/g)) {
      const font = at(Number(id)).dict;
      if (!font.includes("/Subtype /Type0")) throw new Error(`${name} is not a Type0 font`);
      const descendant = at(ref(font, "DescendantFonts")).dict;
      const program = inflateSync(at(ref(at(ref(descendant, "FontDescriptor")).dict, "FontFile2")).stream!);
      fonts.set(name!, { baseFont: font.match(/\/BaseFont \/(\S+)/)![1]!, ...outlinedGlyphs(program) });
      maps.set(name!, toUnicode(at(ref(font, "ToUnicode")).stream!.toString("latin1")));
    }
    const content = at(ref(page.dict, "Contents")).stream!.toString("latin1");
    for (const [block] of content.matchAll(/BT [\s\S]*? ET/g)) {
      const runs = [...block.matchAll(/(2 Tr [^/]*)?\/(\S+) [\d.]+ Tf <([0-9a-f]*)> Tj/g)].map(
        ([, emboldened, face, hex]): ShownRun => ({
          face: face!,
          emboldened: Boolean(emboldened),
          glyphs: (hex!.match(/.{4}/g) ?? []).map((unit) => {
            const code = parseInt(unit, 16);
            return { code, text: maps.get(face!)?.get(code) ?? "�" };
          }),
        }),
      );
      texts.push({ text: runs.flatMap((run) => run.glyphs.map((glyph) => glyph.text)).join(""), runs });
    }
  }
  return { objectCount: objects.length, texts, fonts };
}
