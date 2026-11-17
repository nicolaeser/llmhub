import "server-only";
import type {
  PdfCanvas,
  PdfColor,
  PdfFace,
  PdfFont,
  PdfGlyph,
  PdfHeaderBadge,
  PdfHeaderDetail,
  PdfObject,
  PdfTextStyle,
  PdfTone,
  PdfTypeface,
} from "@/types/export";

export const PAGE_W = 595.28;
export const PAGE_H = 841.89;
export const MARGIN = 40;
export const CONTENT_W = PAGE_W - MARGIN * 2;
export const FOOTER_RULE = 48;

export const COLORS = {
  accent: [82, 82, 232],
  accentRaised: [107, 118, 243],
  accentSoft: [233, 237, 255],
  onAccent: [255, 255, 255],
  onAccentMuted: [201, 210, 252],
  mast: [20, 22, 46],
  mastMuted: [198, 203, 232],
  ink: [23, 25, 40],
  muted: [99, 102, 121],
  border: [220, 221, 230],
  axis: [196, 199, 210],
  surface: [244, 245, 251],
  track: [232, 235, 245],
  warning: [161, 85, 12],
  warningSoft: [253, 240, 214],
  danger: [199, 31, 42],
  dangerSoft: [253, 228, 226],
  success: [18, 121, 70],
} satisfies Record<string, PdfColor>;

const FONTS: Record<PdfFont, { resource: string; baseFont: string }> = {
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
const EMBOLDEN = 1 / 30;
const OBLIQUE = 0.21;

function winAnsi(char: string): number {
  const code = char.codePointAt(0)!;
  if ((code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff)) return code;
  return WIN_ANSI[char] ?? 0x3f;
}

const isBold = (font: PdfFont) => font === "bold" || font === "boldItalic";

function advance(byte: number, font: PdfFont): number {
  if (font === "mono") return MONO_WIDTH;
  const bold = isBold(font);
  const widths = bold ? BOLD_WIDTHS : REGULAR_WIDTHS;
  if (byte >= 0x20 && byte <= 0x7e) return widths[byte - 0x20]!;
  const extra = EXTRA_WIDTHS[byte];
  if (extra) return extra[bold ? 1 : 0];
  const base = String.fromCharCode(byte).normalize("NFD").charCodeAt(0);
  return base >= 0x20 && base <= 0x7e ? widths[base - 0x20]! : 556;
}

function standardLayout(value: string, font: PdfFont): PdfGlyph[] {
  return Array.from(value.normalize("NFC"), (char) => {
    const code = winAnsi(char);
    return { face: FONTS[font].resource, code, width: advance(code, font), text: char, emboldened: false, oblique: false };
  });
}

const standardTypeface: PdfTypeface = {
  faces: Object.fromEntries(
    Object.values(FONTS).map(({ resource, baseFont }): [string, PdfFace] => [
      resource,
      {
        codeBytes: 1,
        objects: () => [`<< /Type /Font /Subtype /Type1 /BaseFont /${baseFont} /Encoding /WinAnsiEncoding >>`],
      },
    ]),
  ),
  layout: standardLayout,
};

function measure(glyphs: PdfGlyph[], size: number, tracking = 0): number {
  return (glyphs.reduce((sum, glyph) => sum + glyph.width, 0) * size) / 1000 + tracking * glyphs.length;
}

function truncate(glyphs: PdfGlyph[], ellipsis: PdfGlyph, size: number, maxWidth: number): PdfGlyph[] {
  if (measure(glyphs, size) <= maxWidth) return glyphs;
  const out = glyphs.slice();
  while (out.length > 0 && measure([...out, ellipsis], size) > maxWidth) out.pop();
  while (out.at(-1)?.text === " ") out.pop();
  return [...out, ellipsis];
}

function runs(glyphs: PdfGlyph[]): PdfGlyph[][] {
  const out: PdfGlyph[][] = [];
  for (const glyph of glyphs) {
    const last = out.at(-1);
    const head = last?.[0];
    const joins = head?.face === glyph.face && head.emboldened === glyph.emboldened && head.oblique === glyph.oblique;
    if (last && joins) last.push(glyph);
    else out.push([glyph]);
  }
  return out;
}

const num = (value: number) => Number(value.toFixed(2)).toString();
const rgb = (color: PdfColor) => color.map((channel) => num(channel / 255)).join(" ");

export function canvas(typeface: PdfTypeface = standardTypeface) {
  const ops: string[] = [];
  const glyphs = new Map<string, Map<number, string>>();
  const links: { rect: [number, number, number, number]; url: string }[] = [];

  function rect(x: number, y: number, w: number, h: number, fill: PdfColor) {
    ops.push(`${rgb(fill)} rg ${num(x)} ${num(y)} ${num(w)} ${num(h)} re f`);
  }

  function roundedRect(
    x: number,
    y: number,
    w: number,
    h: number,
    radii: number | [number, number, number, number],
    fill: PdfColor,
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

  function line(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    stroke: PdfColor,
    width = 0.5,
    cap: "butt" | "round" = "butt",
  ) {
    ops.push(`${rgb(stroke)} RG ${num(width)} w ${cap === "round" ? 1 : 0} J ${num(x1)} ${num(y1)} m ${num(x2)} ${num(y2)} l S`);
  }

  function circle(cx: number, cy: number, r: number, fill: PdfColor) {
    if (r <= 0) return;
    const k = 0.5523;
    const curve = (x1: number, y1: number, x2: number, y2: number, x3: number, y3: number) =>
      `${num(x1)} ${num(y1)} ${num(x2)} ${num(y2)} ${num(x3)} ${num(y3)} c`;
    ops.push(
      `${rgb(fill)} rg ${num(cx + r)} ${num(cy)} m ${[
        curve(cx + r, cy + k * r, cx + k * r, cy + r, cx, cy + r),
        curve(cx - k * r, cy + r, cx - r, cy + k * r, cx - r, cy),
        curve(cx - r, cy - k * r, cx - k * r, cy - r, cx, cy - r),
        curve(cx + k * r, cy - r, cx + r, cy - k * r, cx + r, cy),
      ].join(" ")} h f`,
    );
  }

  function link(x: number, y: number, w: number, h: number, url: string) {
    if (w <= 0 || h <= 0) return;
    links.push({ rect: [x, y, x + w, y + h], url });
  }

  function show(run: PdfGlyph[], size: number, color: string): string {
    const face = run[0]!.face;
    const digits = typeface.faces[face]!.codeBytes * 2;
    const codes = run.map((glyph) => glyph.code.toString(16).padStart(digits, "0")).join("");
    const shown = `/${face} ${num(size)} Tf <${codes}> Tj`;
    return run[0]!.emboldened ? `2 Tr ${num(size * EMBOLDEN)} w ${color} RG ${shown} 0 Tr` : shown;
  }

  function text(value: string, x: number, y: number, style: PdfTextStyle) {
    const font = style.font ?? "regular";
    let size = style.size;
    let laid = typeface.layout(value, font);
    if (style.maxWidth !== undefined) {
      const natural = measure(laid, size);
      if (style.shrink && natural > style.maxWidth) size = Math.max(7, (size * style.maxWidth) / natural);
      laid = truncate(laid, typeface.layout("…", font)[0]!, size, style.maxWidth);
    }
    if (laid.length === 0) return;
    const width = measure(laid, size, style.tracking);
    const left = style.align === "right" ? x - width : style.align === "center" ? x - width / 2 : x;
    for (const glyph of laid) {
      const used = glyphs.get(glyph.face) ?? new Map<number, string>();
      if (!used.has(glyph.code)) used.set(glyph.code, glyph.text);
      glyphs.set(glyph.face, used);
    }
    const color = rgb(style.color ?? COLORS.ink);
    const split = runs(laid);
    let shown: string[];
    if (laid.some((glyph) => glyph.oblique)) {
      let cursor = left;
      shown = split.map((run) => {
        const placed = `1 0 ${run[0]!.oblique ? OBLIQUE : 0} 1 ${num(cursor)} ${num(y)} Tm ${show(run, size, color)}`;
        cursor += measure(run, size, style.tracking);
        return placed;
      });
    } else {
      shown = [`${num(left)} ${num(y)} Td`, ...split.map((run) => show(run, size, color))];
    }
    const op = `BT ${num(style.tracking ?? 0)} Tc ${color} rg ${shown.join(" ")} ET`;
    ops.push(laid.some((glyph) => glyph.emboldened) ? `q ${op} Q` : op);
  }

  function pageTextWidth(value: string, style: PdfTextStyle): number {
    return measure(typeface.layout(value, style.font ?? "regular"), style.size, style.tracking);
  }

  return { typeface, ops, glyphs, links, rect, roundedRect, line, circle, link, text, textWidth: pageTextWidth };
}

const HUB_LINKS = [
  [12, 5.5, 12, 12.75],
  [12, 12.75, 18.28, 16.38],
  [12, 12.75, 5.72, 16.38],
] as const;
const HUB_NODES = [
  [12, 12.75, 3.25],
  [12, 5.5, 2.25],
  [18.28, 16.38, 2.25],
  [5.72, 16.38, 2.25],
] as const;

export function drawHubMark(page: PdfCanvas, x: number, y: number, size: number, color: PdfColor) {
  const scale = size / 24;
  const px = (vx: number) => x + vx * scale;
  const py = (vy: number) => y + (24 - vy) * scale;
  for (const [x1, y1, x2, y2] of HUB_LINKS) page.line(px(x1), py(y1), px(x2), py(y2), color, 2 * scale, "round");
  for (const [cx, cy, r] of HUB_NODES) page.circle(px(cx), py(cy), r * scale, color);
}

function drawLogo(page: PdfCanvas, x: number, y: number, tile: number) {
  page.roundedRect(x, y, tile, tile, tile * 0.28, COLORS.accent);
  const inset = tile * 0.18;
  drawHubMark(page, x + inset, y + inset, tile - inset * 2, COLORS.onAccent);
}

function documentUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) return null;
    return value;
  } catch {
    return null;
  }
}

function drawLinkedText(page: PdfCanvas, value: string, x: number, y: number, style: PdfTextStyle) {
  const natural = page.textWidth(value, style);
  const width = style.maxWidth === undefined ? natural : Math.min(natural, style.maxWidth);
  const left = style.align === "right" ? x - width : style.align === "center" ? x - width / 2 : x;
  page.text(value, x, y, style);
  const href = documentUrl(value);
  if (!href || width <= 0) return;
  page.link(left, y - 2, width, style.size + 4, href);
  page.line(left, y - 1.4, left + width, y - 1.4, style.color ?? COLORS.accent, 0.45);
}

const MASTHEAD = 58;
const LOGO = 28;
const BADGE_HEIGHT = 18;
const BADGE_FILL: Record<PdfTone, PdfColor> = {
  neutral: COLORS.accent,
  success: COLORS.success,
  warning: COLORS.warning,
  danger: COLORS.danger,
};
const DETAIL_LABEL = { size: 7.5, font: "bold", color: COLORS.muted, tracking: 0.3 } satisfies PdfTextStyle;
const DETAIL_VALUE = { size: 9, color: COLORS.ink } satisfies PdfTextStyle;
const DETAIL_LABEL_GAP = 6;
const DETAIL_ITEM_GAP = 22;
const DETAIL_LEADING = 13;
const DETAIL_ITEM_LEADING = 15;
const DETAIL_MAX_LINES = 2;

function detailLines(page: PdfCanvas, value: string, width: number): string[] {
  const lines: string[] = [];
  const words = value.split(/\s+/).filter(Boolean);
  let start = 0;
  for (let end = 1; end < words.length; end++) {
    if (page.textWidth(words.slice(start, end + 1).join(" "), DETAIL_VALUE) <= width) continue;
    if (lines.length === DETAIL_MAX_LINES - 1) break;
    lines.push(words.slice(start, end).join(" "));
    start = end;
  }
  return [...lines, words.slice(start).join(" ")];
}

function drawHeaderDetails(page: PdfCanvas, details: PdfHeaderDetail[], baseline: number): number {
  const items = details.map((detail) => ({
    ...detail,
    labelWidth: page.textWidth(detail.label, DETAIL_LABEL),
    valueWidth: page.textWidth(detail.value, DETAIL_VALUE),
  }));
  const inline =
    items.reduce((sum, item) => sum + item.labelWidth + DETAIL_LABEL_GAP + item.valueWidth, 0) +
      DETAIL_ITEM_GAP * (items.length - 1) <=
    CONTENT_W;
  if (inline) {
    let x = MARGIN;
    items.forEach((item, index) => {
      if (index > 0) {
        page.line(x - DETAIL_ITEM_GAP / 2, baseline - 1.5, x - DETAIL_ITEM_GAP / 2, baseline + 7.5, COLORS.border, 0.75);
      }
      page.text(item.label, x, baseline, DETAIL_LABEL);
      x += item.labelWidth + DETAIL_LABEL_GAP;
      page.text(item.value, x, baseline, DETAIL_VALUE);
      x += item.valueWidth + DETAIL_ITEM_GAP;
    });
    return baseline;
  }
  const valueX = MARGIN + Math.max(...items.map((item) => item.labelWidth)) + DETAIL_LABEL_GAP + 4;
  const valueW = PAGE_W - MARGIN - valueX;
  let y = baseline + DETAIL_ITEM_LEADING;
  for (const item of items) {
    y -= DETAIL_ITEM_LEADING;
    page.text(item.label, MARGIN, y, DETAIL_LABEL);
    detailLines(page, item.value, valueW).forEach((line, index) => {
      if (index > 0) y -= DETAIL_LEADING;
      page.text(line, valueX, y, { ...DETAIL_VALUE, maxWidth: valueW });
    });
  }
  return y;
}

export function drawHeader(
  page: PdfCanvas,
  input: {
    brand: string;
    title: string;
    subtitle: string;
    badge?: PdfHeaderBadge;
    details?: PdfHeaderDetail[];
    instance?: string;
  },
): number {
  const mastheadBottom = PAGE_H - MASTHEAD;
  page.rect(0, mastheadBottom, PAGE_W, MASTHEAD, COLORS.mast);
  page.rect(0, PAGE_H - 3.5, PAGE_W, 3.5, COLORS.accent);

  const tileY = PAGE_H - 15 - LOGO;
  drawLogo(page, MARGIN, tileY, LOGO);
  const textX = MARGIN + LOGO + 10;

  const badgeStyle = { size: 8, font: "bold", color: COLORS.onAccent, maxWidth: 200 } satisfies PdfTextStyle;
  const badgeW = input.badge?.label
    ? Math.min(page.textWidth(input.badge.label, badgeStyle), badgeStyle.maxWidth) + 18
    : 0;
  const textMax = PAGE_W - MARGIN - textX - (badgeW ? badgeW + 14 : 0);
  page.text(input.brand, textX, input.instance ? tileY + 15 : tileY + 9, {
    size: 12,
    font: "bold",
    color: COLORS.onAccent,
    tracking: 0.2,
    maxWidth: textMax,
  });
  if (input.instance) {
    drawLinkedText(page, input.instance, textX, tileY + 3, {
      size: 8,
      color: COLORS.mastMuted,
      maxWidth: textMax,
    });
  }
  if (input.badge && badgeW) {
    const badgeY = tileY + (LOGO - BADGE_HEIGHT) / 2;
    page.roundedRect(
      PAGE_W - MARGIN - badgeW,
      badgeY,
      badgeW,
      BADGE_HEIGHT,
      BADGE_HEIGHT / 2,
      BADGE_FILL[input.badge.tone ?? "neutral"],
    );
    page.text(input.badge.label, PAGE_W - MARGIN - 9, badgeY + 5.5, { ...badgeStyle, align: "right" });
  }

  const titleY = mastheadBottom - 40;
  page.text(input.title, MARGIN, titleY, { size: 22, font: "bold", color: COLORS.ink, maxWidth: CONTENT_W });
  const subtitleY = titleY - 18;
  page.text(input.subtitle, MARGIN, subtitleY, { size: 10, color: COLORS.muted, maxWidth: CONTENT_W });
  const details = (input.details ?? []).filter((detail) => detail.value);
  const lastY = details.length ? drawHeaderDetails(page, details, subtitleY - 16) : subtitleY;
  const ruleY = lastY - 13;
  page.rect(MARGIN, ruleY, 28, 2.25, COLORS.accent);
  return ruleY - 20;
}

export function drawRunningHeader(page: PdfCanvas, input: { brand: string; detail: string }): number {
  page.rect(0, PAGE_H - 3, PAGE_W, 3, COLORS.accent);
  const tile = 14;
  const tileY = PAGE_H - 14 - tile;
  drawLogo(page, MARGIN, tileY, tile);
  page.text(input.brand, MARGIN + tile + 6, tileY + 3.5, { size: 8, font: "bold", maxWidth: 120 });
  page.text(input.detail, PAGE_W - MARGIN, tileY + 3.5, {
    size: 8,
    color: COLORS.muted,
    align: "right",
    maxWidth: CONTENT_W - 150,
  });
  const rule = tileY - 8;
  page.line(MARGIN, rule, PAGE_W - MARGIN, rule, COLORS.border, 0.6);
  return rule - 16;
}

export function drawFooter(
  page: PdfCanvas,
  input: { left: string; center?: string; right: string; instance?: string; edition?: string },
) {
  page.rect(0, 0, PAGE_W, 5, COLORS.accent);
  page.line(MARGIN, FOOTER_RULE, PAGE_W - MARGIN, FOOTER_RULE, COLORS.border, 0.6);
  const lineY = 30;
  const centerW = input.center ? 128 : 0;
  const side = (CONTENT_W - centerW) / 2 - 6;
  page.text(input.left, MARGIN, lineY, { size: 8, color: COLORS.muted, maxWidth: side });
  if (input.center) {
    page.text(input.center, PAGE_W / 2, lineY, { size: 8, color: COLORS.muted, align: "center", maxWidth: centerW - 8 });
  }
  page.text(input.right, PAGE_W - MARGIN, lineY, {
    size: 8,
    font: "bold",
    color: COLORS.ink,
    align: "right",
    maxWidth: side,
  });
  if (input.instance) {
    drawLinkedText(page, input.instance, MARGIN, 15, { size: 7.5, color: COLORS.accent, maxWidth: CONTENT_W * 0.62 });
  }
  if (input.edition) {
    page.text(input.edition, PAGE_W - MARGIN, 15, {
      size: 7.5,
      color: COLORS.muted,
      align: "right",
      maxWidth: CONTENT_W * 0.32,
      shrink: true,
    });
  }
}

function pdfString(value: string): string {
  let out = "FEFF";
  for (let i = 0; i < value.length; i++) out += value.charCodeAt(i).toString(16).padStart(4, "0");
  return `<${out}>`;
}

function pdfLiteral(value: string): string {
  return `(${value.replace(/[\\()]/g, (char) => `\\${char}`)})`;
}

function infoDict(info: { title: string; producer: string; subject?: string }): string {
  return `<< /Title ${pdfString(info.title)} /Author ${pdfString(info.producer)} /Subject ${pdfString(info.subject || info.title)} /Creator ${pdfString(info.producer)} /Producer ${pdfString(info.producer)} >>`;
}

export function pdfDocument(
  pages: PdfCanvas[],
  info: { title: string; producer: string; subject?: string },
): Uint8Array {
  const used = new Map<string, { face: PdfFace; glyphs: Map<number, string> }>();
  for (const page of pages) {
    for (const [name, face] of Object.entries(page.typeface.faces)) {
      const glyphs = page.glyphs.get(name);
      if (!glyphs) continue;
      const entry = used.get(name) ?? { face, glyphs: new Map<number, string>() };
      for (const [code, text] of glyphs) if (!entry.glyphs.has(code)) entry.glyphs.set(code, text);
      used.set(name, entry);
    }
  }

  const fontObjects: PdfObject[] = [];
  const fontRefs = new Map<string, number>();
  for (const [name, { face, glyphs }] of used) {
    const ref = 3 + fontObjects.length;
    fontRefs.set(name, ref);
    fontObjects.push(...face.objects(glyphs, ref));
  }
  const resources = [...fontRefs].map(([name, ref]) => `/${name} ${ref} 0 R`).join(" ");

  const objects: PdfObject[] = ["<< /Type /Catalog /Pages 2 0 R >>", "", ...fontObjects];
  const kids: number[] = [];
  for (const page of pages) {
    const pageRef = objects.length + 1;
    kids.push(pageRef);
    const annots = page.links;
    const annotRefs = annots.map((_, index) => `${pageRef + 2 + index} 0 R`).join(" ");
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Contents ${pageRef + 1} 0 R${annotRefs ? ` /Annots [${annotRefs}]` : ""} /Resources << /Font << ${resources} >> >> >>`,
      { entries: "", data: Buffer.from(page.ops.join("\n"), "latin1") },
      ...annots.map(
        (item) =>
          `<< /Type /Annot /Subtype /Link /Rect [${item.rect.map((value) => num(value)).join(" ")}] /Border [0 0 0] /A << /Type /Action /S /URI /URI ${pdfLiteral(item.url)} >> >>`,
      ),
    );
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.map((ref) => `${ref} 0 R`).join(" ")}] /Count ${pages.length} >>`;
  objects.push(infoDict(info));

  const chunks: Buffer[] = [Buffer.from("%PDF-1.4\n", "latin1")];
  const xref = [0];
  let offset = chunks[0]!.length;
  objects.forEach((body, i) => {
    const buf =
      typeof body === "string"
        ? Buffer.from(`${i + 1} 0 obj\n${body}\nendobj\n`, "latin1")
        : Buffer.concat([
            Buffer.from(`${i + 1} 0 obj\n<< /Length ${body.data.length}${body.entries ? ` ${body.entries}` : ""} >>\nstream\n`, "latin1"),
            body.data,
            Buffer.from("\nendstream\nendobj\n", "latin1"),
          ]);
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
