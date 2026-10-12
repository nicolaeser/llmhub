import "server-only";

export type Rgb = readonly [number, number, number];
export type Font = "regular" | "bold" | "italic" | "boldItalic" | "mono";

export type TextStyle = {
  size: number;
  font?: Font;
  color?: Rgb;
  align?: "left" | "right" | "center";
  maxWidth?: number;
  shrink?: boolean;
  tracking?: number;
};

export const PAGE_W = 595.28;
export const PAGE_H = 841.89;
export const MARGIN = 40;
export const CONTENT_W = PAGE_W - MARGIN * 2;
export const HEADER_H = 122;
export const FOOTER_RULE = 44;

export const COLORS = {
  accent: [99, 103, 239],
  accentRaised: [126, 130, 242],
  accentSoft: [236, 238, 254],
  onAccent: [255, 255, 255],
  onAccentMuted: [207, 213, 249],
  ink: [30, 31, 37],
  muted: [110, 113, 126],
  border: [220, 222, 227],
  axis: [196, 198, 206],
  surface: [244, 245, 249],
  track: [232, 233, 240],
  warning: [146, 94, 0],
  warningSoft: [253, 240, 214],
  danger: [196, 32, 38],
  dangerSoft: [253, 228, 226],
} satisfies Record<string, Rgb>;

const FONTS: Record<Font, { resource: string; baseFont: string }> = {
  regular: { resource: "F1", baseFont: "Helvetica" },
  bold: { resource: "F2", baseFont: "Helvetica-Bold" },
  italic: { resource: "F3", baseFont: "Helvetica-Oblique" },
  boldItalic: { resource: "F4", baseFont: "Helvetica-BoldOblique" },
  mono: { resource: "F5", baseFont: "Courier" },
};

const MONO_WIDTH = 600;

const REGULAR_WIDTHS = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556,
  556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778,
  722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278,
  278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];
const BOLD_WIDTHS = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556,
  556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778,
  722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333,
  278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611,
  611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
];
const EXTRA_WIDTHS: Record<number, readonly [number, number]> = {
  0x80: [556, 556],
  0x82: [222, 278],
  0x84: [333, 500],
  0x85: [1000, 1000],
  0x91: [222, 278],
  0x92: [222, 278],
  0x93: [333, 500],
  0x94: [333, 500],
  0x95: [350, 350],
  0x96: [556, 556],
  0x97: [1000, 1000],
  0x99: [1000, 1000],
  0xa0: [278, 278],
  0xb0: [400, 400],
  0xb7: [278, 278],
  0xd7: [584, 584],
  0xdf: [611, 611],
};
const WIN_ANSI: Record<string, number> = {
  "€": 0x80,
  "‚": 0x82,
  "„": 0x84,
  "…": 0x85,
  "‘": 0x91,
  "’": 0x92,
  "“": 0x93,
  "”": 0x94,
  "•": 0x95,
  "–": 0x96,
  "—": 0x97,
  "™": 0x99,
  " ": 0x20,
  " ": 0xa0,
};
const ELLIPSIS = 0x85;

export function encode(value: string): number[] {
  const bytes: number[] = [];
  for (const char of value.normalize("NFC")) {
    const code = char.codePointAt(0)!;
    if ((code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff)) bytes.push(code);
    else bytes.push(WIN_ANSI[char] ?? 0x3f);
  }
  return bytes;
}

const isBold = (font: Font) => font === "bold" || font === "boldItalic";

function advance(byte: number, font: Font): number {
  if (font === "mono") return MONO_WIDTH;
  const bold = isBold(font);
  const widths = bold ? BOLD_WIDTHS : REGULAR_WIDTHS;
  if (byte >= 0x20 && byte <= 0x7e) return widths[byte - 0x20]!;
  const extra = EXTRA_WIDTHS[byte];
  if (extra) return extra[bold ? 1 : 0];
  const base = String.fromCharCode(byte).normalize("NFD").charCodeAt(0);
  return base >= 0x20 && base <= 0x7e ? widths[base - 0x20]! : 556;
}

export function measure(bytes: number[], font: Font, size: number, tracking = 0): number {
  return (bytes.reduce((sum, byte) => sum + advance(byte, font), 0) * size) / 1000 + tracking * bytes.length;
}

export function textWidth(value: string, style: TextStyle): number {
  return measure(encode(value), style.font ?? "regular", style.size, style.tracking);
}

function truncate(bytes: number[], font: Font, size: number, maxWidth: number): number[] {
  if (measure(bytes, font, size) <= maxWidth) return bytes;
  const out = bytes.slice();
  while (out.length > 0 && measure([...out, ELLIPSIS], font, size) > maxWidth) out.pop();
  while (out.at(-1) === 0x20) out.pop();
  return [...out, ELLIPSIS];
}

const num = (value: number) => Number(value.toFixed(2)).toString();
const rgb = (color: Rgb) => color.map((channel) => num(channel / 255)).join(" ");
const hex = (bytes: number[]) => bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("");

export function canvas() {
  const ops: string[] = [];
  const fonts = new Set<Font>();

  function rect(x: number, y: number, w: number, h: number, fill: Rgb) {
    ops.push(`${rgb(fill)} rg ${num(x)} ${num(y)} ${num(w)} ${num(h)} re f`);
  }

  function roundedRect(
    x: number,
    y: number,
    w: number,
    h: number,
    radii: number | [number, number, number, number],
    fill: Rgb,
  ) {
    const k = 0.5523;
    const [bl, br, tr, tl] = (typeof radii === "number" ? [radii, radii, radii, radii] : radii).map(
      (r) => Math.max(0, Math.min(r, w / 2, h / 2)),
    ) as [number, number, number, number];
    const path = [`${num(x + bl)} ${num(y)} m`, `${num(x + w - br)} ${num(y)} l`];
    if (br) path.push(`${num(x + w - br + k * br)} ${num(y)} ${num(x + w)} ${num(y + br - k * br)} ${num(x + w)} ${num(y + br)} c`);
    path.push(`${num(x + w)} ${num(y + h - tr)} l`);
    if (tr) path.push(`${num(x + w)} ${num(y + h - tr + k * tr)} ${num(x + w - tr + k * tr)} ${num(y + h)} ${num(x + w - tr)} ${num(y + h)} c`);
    path.push(`${num(x + tl)} ${num(y + h)} l`);
    if (tl) path.push(`${num(x + tl - k * tl)} ${num(y + h)} ${num(x)} ${num(y + h - tl + k * tl)} ${num(x)} ${num(y + h - tl)} c`);
    path.push(`${num(x)} ${num(y + bl)} l`);
    if (bl) path.push(`${num(x)} ${num(y + bl - k * bl)} ${num(x + bl - k * bl)} ${num(y)} ${num(x + bl)} ${num(y)} c`);
    ops.push(`${rgb(fill)} rg ${path.join(" ")} h f`);
  }

  function line(x1: number, y1: number, x2: number, y2: number, stroke: Rgb, width = 0.5) {
    ops.push(`${rgb(stroke)} RG ${num(width)} w ${num(x1)} ${num(y1)} m ${num(x2)} ${num(y2)} l S`);
  }

  function text(value: string, x: number, y: number, style: TextStyle) {
    const font = style.font ?? "regular";
    let size = style.size;
    let bytes = encode(value);
    if (style.maxWidth !== undefined) {
      const natural = measure(bytes, font, size);
      if (style.shrink && natural > style.maxWidth) size = Math.max(7, (size * style.maxWidth) / natural);
      bytes = truncate(bytes, font, size, style.maxWidth);
    }
    const width = measure(bytes, font, size, style.tracking);
    const left = style.align === "right" ? x - width : style.align === "center" ? x - width / 2 : x;
    fonts.add(font);
    ops.push(
      `BT /${FONTS[font].resource} ${num(size)} Tf ${num(style.tracking ?? 0)} Tc ${rgb(style.color ?? COLORS.ink)} rg ${num(left)} ${num(y)} Td <${hex(bytes)}> Tj ET`,
    );
  }

  return { ops, fonts, rect, roundedRect, line, text, textWidth };
}

export type Canvas = ReturnType<typeof canvas>;

export function drawHeader(
  page: Canvas,
  input: { brand: string; title: string; subtitle: string; badge?: string },
): number {
  const bottom = PAGE_H - HEADER_H;
  page.rect(0, bottom, PAGE_W, HEADER_H, COLORS.accent);

  const mark = 22;
  const markY = PAGE_H - 28 - mark;
  page.roundedRect(MARGIN, markY, mark, mark, 5, COLORS.onAccent);
  const glyph = mark * 0.64;
  const scale = glyph / 24;
  const origin = { x: MARGIN + (mark - glyph) / 2, y: markY + (mark - glyph) / 2 };
  for (const [gx, gy, gw, gh] of [
    [6.75, 4.5, 3, 15],
    [14.25, 4.5, 3, 15],
    [6.75, 10.5, 10.5, 3],
  ] as const) {
    page.rect(origin.x + gx * scale, origin.y + glyph - (gy + gh) * scale, gw * scale, gh * scale, COLORS.accent);
  }
  page.text(input.brand, MARGIN + mark + 9, markY + 7, {
    size: 11,
    font: "bold",
    color: COLORS.onAccent,
    tracking: 0.2,
  });

  if (input.badge) {
    const style = { size: 8.5, font: "bold", color: COLORS.onAccent, maxWidth: 220 } satisfies TextStyle;
    const width = Math.min(page.textWidth(input.badge, style), style.maxWidth);
    page.roundedRect(PAGE_W - MARGIN - width - 20, markY + 1, width + 20, 20, 10, COLORS.accentRaised);
    page.text(input.badge, PAGE_W - MARGIN - 10, markY + 8, { ...style, align: "right" });
  }

  page.text(input.title, MARGIN, PAGE_H - 82, {
    size: 24,
    font: "bold",
    color: COLORS.onAccent,
    maxWidth: CONTENT_W,
  });
  page.text(input.subtitle, MARGIN, PAGE_H - 100, {
    size: 10,
    color: COLORS.onAccentMuted,
    maxWidth: CONTENT_W,
  });
  return bottom;
}

export function drawFooter(page: Canvas, input: { left: string; center?: string; right: string }) {
  page.line(MARGIN, FOOTER_RULE, PAGE_W - MARGIN, FOOTER_RULE, COLORS.border, 0.5);
  const third = CONTENT_W / 3 - 8;
  page.text(input.left, MARGIN, FOOTER_RULE - 14, { size: 8, color: COLORS.muted, maxWidth: input.center ? third : CONTENT_W / 2 });
  if (input.center) {
    page.text(input.center, PAGE_W / 2, FOOTER_RULE - 14, { size: 8, color: COLORS.muted, align: "center", maxWidth: third });
  }
  page.text(input.right, PAGE_W - MARGIN, FOOTER_RULE - 14, {
    size: 8,
    font: "bold",
    color: COLORS.muted,
    align: "right",
    maxWidth: third,
  });
}

function pdfString(value: string): string {
  let out = "FEFF";
  for (let i = 0; i < value.length; i++) out += value.charCodeAt(i).toString(16).padStart(4, "0");
  return `<${out}>`;
}

export function pdfDocument(pages: Canvas[], info: { title: string; producer: string }): Uint8Array {
  const used = (Object.keys(FONTS) as Font[]).filter((font) => pages.some((page) => page.fonts.has(font)));
  const fontRefs = new Map(used.map((font, index) => [font, index + 3]));
  const firstPage = 3 + used.length;
  const pageRef = (index: number) => firstPage + index * 2;
  const resources = used.map((font) => `/${FONTS[font].resource} ${fontRefs.get(font)} 0 R`).join(" ");

  const objects: string[] = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pages.map((_, index) => `${pageRef(index)} 0 R`).join(" ")}] /Count ${pages.length} >>`,
    ...used.map(
      (font) => `<< /Type /Font /Subtype /Type1 /BaseFont /${FONTS[font].baseFont} /Encoding /WinAnsiEncoding >>`,
    ),
  ];
  pages.forEach((page, index) => {
    const stream = page.ops.join("\n") + "\n";
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Contents ${pageRef(index) + 1} 0 R /Resources << /Font << ${resources} >> >> >>`,
      `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}endstream`,
    );
  });
  objects.push(`<< /Title ${pdfString(info.title)} /Producer ${pdfString(info.producer)} >>`);

  const chunks: Buffer[] = [Buffer.from("%PDF-1.4\n", "latin1")];
  const xref = [0];
  let offset = chunks[0]!.length;
  objects.forEach((body, i) => {
    const buf = Buffer.from(`${i + 1} 0 obj\n${body}\nendobj\n`, "latin1");
    xref.push(offset);
    chunks.push(buf);
    offset += buf.length;
  });
  const xrefStart = offset;
  let table = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i < xref.length; i++) {
    table += `${String(xref[i]).padStart(10, "0")} 00000 n \n`;
  }
  table += `trailer << /Size ${objects.length + 1} /Root 1 0 R /Info ${objects.length} 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  chunks.push(Buffer.from(table, "latin1"));
  return Buffer.concat(chunks);
}
