import type { canvas } from "@/lib/export/pdf";
import type { SliceRow, UsageSummary } from "@/types/usage";

export type PdfColor = readonly [number, number, number];

export type PdfFont = "regular" | "bold" | "italic" | "boldItalic" | "mono";

export type PdfTextStyle = {
  size: number;
  font?: PdfFont;
  color?: PdfColor;
  align?: "left" | "right" | "center";
  maxWidth?: number;
  shrink?: boolean;
  tracking?: number;
};

export type PdfCanvas = ReturnType<typeof canvas>;

export type PdfGlyph = {
  face: string;
  code: number;
  width: number;
  text: string;
  emboldened: boolean;
};

export type PdfStream = { entries: string; data: Uint8Array };

export type PdfObject = string | PdfStream;

export type PdfFace = {
  codeBytes: 1 | 2;
  objects: (glyphs: ReadonlyMap<number, string>, ref: number) => PdfObject[];
};

export type PdfTypeface = {
  faces: Readonly<Record<string, PdfFace>>;
  layout: (value: string, font: PdfFont) => PdfGlyph[];
};

export type TrueTypeTable = { offset: number; length: number };

export type TrueTypeFont = {
  bytes: Buffer;
  tables: ReadonlyMap<string, TrueTypeTable>;
  unitsPerEm: number;
  numGlyphs: number;
  glyphs: ReadonlyMap<number, number>;
  advances: Uint16Array;
  loca: Uint32Array;
  bbox: readonly [number, number, number, number];
  ascent: number;
  descent: number;
  capHeight: number;
  italicAngle: number;
  weight: number;
};

export type UsagePdfLabelGroup = { key: string; rows: SliceRow[] };

export type UsagePdfStats = UsageSummary & {
  p95Latency: number;
  byModel: SliceRow[];
  chargeback: SliceRow[];
  byLabel?: UsagePdfLabelGroup[];
};

export type UsagePdfTable = {
  heading: string;
  columns: { model: string; share: string; spend: string; prompt: string; completion: string };
  rows: {
    name: string;
    share: number;
    shareLabel: string;
    spend: string;
    prompt: string;
    completion: string;
  }[];
  total: { name: string; spend: string; prompt: string; completion: string };
  empty: string;
};

export type UsagePdfInput = {
  brand: string;
  title: string;
  period: string;
  filter?: string;
  generated: string;
  kpis: { label: string; value: string }[];
  daily: {
    heading: string;
    days: { label: string; value: number }[];
    formatTick: (value: number) => string;
    empty: string;
  };
  byModel: UsagePdfTable;
  byLabel?: UsagePdfTable[];
};
