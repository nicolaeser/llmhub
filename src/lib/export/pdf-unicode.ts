import "server-only";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { brotliDecompressSync, deflateSync } from "node:zlib";
import { parseTrueType, subsetTrueType } from "./truetype";
import type { PdfFace, PdfFont, PdfGlyph, PdfObject, PdfTypeface, TrueTypeFont } from "@/types/export";

const FONT_DIR = path.join(process.cwd(), "src", "lib", "export", "fonts");

const FACES = [
  "Geist-Regular",
  "Geist-Bold",
  "NotoSans-Regular",
  "NotoSans-Bold",
  "NotoSansSC-Regular",
  "NotoSansKR-Regular",
] as const;

const CHAINS: Partial<Record<PdfFont, readonly (typeof FACES)[number][]>> = {
  regular: ["Geist-Regular", "NotoSans-Regular", "NotoSansSC-Regular", "NotoSansKR-Regular"],
  bold: ["Geist-Bold", "NotoSans-Bold", "NotoSansSC-Regular", "NotoSansKR-Regular"],
};

const BOLD_WEIGHT = 600;
const BFCHAR_BLOCK = 100;

const loaded = new Map<string, TrueTypeFont>();

function face(name: string): TrueTypeFont {
  let font = loaded.get(name);
  if (!font) {
    font = parseTrueType(brotliDecompressSync(readFileSync(path.join(FONT_DIR, `${name}.ttf.br`))));
    loaded.set(name, font);
  }
  return font;
}

const scaled = (font: TrueTypeFont, value: number) => Math.round((value * 1000) / font.unitsPerEm);

function glyph(chain: readonly string[], font: PdfFont, char: string): PdfGlyph | undefined {
  const code = char.codePointAt(0)!;
  for (const name of chain) {
    const source = face(name);
    const gid = source.glyphs.get(code);
    if (gid === undefined) continue;
    return {
      face: name,
      code: gid,
      width: scaled(source, source.advances[gid]!),
      text: char,
      emboldened: font === "bold" && source.weight < BOLD_WEIGHT,
    };
  }
  return undefined;
}

function layout(value: string, font: PdfFont): PdfGlyph[] {
  const chain = CHAINS[font];
  if (!chain) throw new Error("PDF_FONT_UNSUPPORTED");
  return Array.from(value.normalize("NFC"), (char) => glyph(chain, font, char) ?? glyph(chain, font, "?")!);
}

const hex4 = (value: number) => value.toString(16).padStart(4, "0");

function utf16(text: string): string {
  return Array.from({ length: text.length }, (_, index) => hex4(text.charCodeAt(index))).join("");
}

function subsetTag(name: string, gids: number[]): string {
  const digest = createHash("sha256").update(`${name}:${gids.join(",")}`).digest();
  return Array.from(digest.subarray(0, 6), (byte) => String.fromCharCode(65 + (byte % 26))).join("");
}

function toUnicode(entries: [number, string][]): Buffer {
  const blocks: string[] = [];
  for (let start = 0; start < entries.length; start += BFCHAR_BLOCK) {
    const block = entries.slice(start, start + BFCHAR_BLOCK);
    blocks.push(`${block.length} beginbfchar`, ...block.map(([gid, text]) => `<${hex4(gid)}> <${utf16(text)}>`), "endbfchar");
  }
  return Buffer.from(
    [
      "/CIDInit /ProcSet findresource begin",
      "12 dict begin",
      "begincmap",
      "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def",
      "/CMapName /Adobe-Identity-UCS def",
      "/CMapType 2 def",
      "1 begincodespacerange",
      "<0000> <FFFF>",
      "endcodespacerange",
      ...blocks,
      "endcmap",
      "CMapName currentdict /CMap defineresource pop",
      "end",
      "end",
    ].join("\n"),
    "latin1",
  );
}

function fontObjects(name: string, glyphs: ReadonlyMap<number, string>, ref: number): PdfObject[] {
  const source = face(name);
  const entries = [...glyphs].sort(([a], [b]) => a - b);
  const gids = entries.map(([gid]) => gid);
  const baseFont = `/${subsetTag(name, gids)}+${name}`;
  const program = subsetTrueType(source, gids);
  const widths = gids.map((gid) => `${gid} [${scaled(source, source.advances[gid]!)}]`).join(" ");
  const stemV = Math.round(10 + 220 * ((source.weight - 50) / 900) ** 2);
  return [
    `<< /Type /Font /Subtype /Type0 /BaseFont ${baseFont} /Encoding /Identity-H /DescendantFonts [${ref + 1} 0 R] /ToUnicode ${ref + 4} 0 R >>`,
    `<< /Type /Font /Subtype /CIDFontType2 /BaseFont ${baseFont} /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor ${ref + 2} 0 R /CIDToGIDMap /Identity /W [${widths}] >>`,
    `<< /Type /FontDescriptor /FontName ${baseFont} /Flags 4 /FontBBox [${source.bbox.map((value) => scaled(source, value)).join(" ")}] /ItalicAngle ${Number(source.italicAngle.toFixed(2))} /Ascent ${scaled(source, source.ascent)} /Descent ${scaled(source, source.descent)} /CapHeight ${scaled(source, source.capHeight)} /StemV ${stemV} /FontFile2 ${ref + 3} 0 R >>`,
    { entries: `/Length1 ${program.length} /Filter /FlateDecode`, data: deflateSync(program) },
    { entries: "", data: toUnicode(entries) },
  ];
}

export const unicodeTypeface: PdfTypeface = {
  faces: Object.fromEntries(
    FACES.map((name): [string, PdfFace] => [
      name,
      { codeBytes: 2, objects: (glyphs, ref) => fontObjects(name, glyphs, ref) },
    ]),
  ),
  layout,
};
