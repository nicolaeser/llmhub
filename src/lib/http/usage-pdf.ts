import "server-only";

type Rgb = readonly [number, number, number];
type Font = "regular" | "bold";

type TextStyle = {
  size: number;
  font?: Font;
  color?: Rgb;
  align?: "left" | "right" | "center";
  maxWidth?: number;
  shrink?: boolean;
  tracking?: number;
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
  byModel: {
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
};

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MARGIN = 40;
const CONTENT_W = PAGE_W - MARGIN * 2;
const HEADER_H = 122;
const FOOTER_RULE = 44;

const COLORS = {
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
} satisfies Record<string, Rgb>;

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

function encode(value: string): number[] {
  const bytes: number[] = [];
  for (const char of value.normalize("NFC")) {
    const code = char.codePointAt(0)!;
    if ((code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff)) bytes.push(code);
    else bytes.push(WIN_ANSI[char] ?? 0x3f);
  }
  return bytes;
}

function advance(byte: number, font: Font): number {
  const widths = font === "bold" ? BOLD_WIDTHS : REGULAR_WIDTHS;
  if (byte >= 0x20 && byte <= 0x7e) return widths[byte - 0x20]!;
  const extra = EXTRA_WIDTHS[byte];
  if (extra) return extra[font === "bold" ? 1 : 0];
  const base = String.fromCharCode(byte).normalize("NFD").charCodeAt(0);
  return base >= 0x20 && base <= 0x7e ? widths[base - 0x20]! : 556;
}

function measure(bytes: number[], font: Font, size: number, tracking = 0): number {
  return (bytes.reduce((sum, byte) => sum + advance(byte, font), 0) * size) / 1000 + tracking * bytes.length;
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

function canvas() {
  const ops: string[] = [];

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

  function textWidth(value: string, style: TextStyle): number {
    return measure(encode(value), style.font ?? "regular", style.size, style.tracking);
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
    ops.push(
      `BT /${font === "bold" ? "F2" : "F1"} ${num(size)} Tf ${num(style.tracking ?? 0)} Tc ${rgb(style.color ?? COLORS.ink)} rg ${num(left)} ${num(y)} Td <${hex(bytes)}> Tj ET`,
    );
  }

  return { ops, rect, roundedRect, line, text, textWidth };
}

type Canvas = ReturnType<typeof canvas>;

function niceStep(max: number, count: number): number {
  const raw = max / count;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  return ([1, 2, 2.5, 5, 10].find((factor) => factor * magnitude >= raw) ?? 10) * magnitude;
}

function drawHeader(page: Canvas, input: UsagePdfInput): number {
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

  if (input.filter) {
    const style = { size: 8.5, font: "bold", color: COLORS.onAccent, maxWidth: 220 } satisfies TextStyle;
    const width = Math.min(page.textWidth(input.filter, style), style.maxWidth);
    page.roundedRect(PAGE_W - MARGIN - width - 20, markY + 1, width + 20, 20, 10, COLORS.accentRaised);
    page.text(input.filter, PAGE_W - MARGIN - 10, markY + 8, { ...style, align: "right" });
  }

  page.text(input.title, MARGIN, PAGE_H - 82, {
    size: 24,
    font: "bold",
    color: COLORS.onAccent,
    maxWidth: CONTENT_W,
  });
  page.text(input.period, MARGIN, PAGE_H - 100, {
    size: 10,
    color: COLORS.onAccentMuted,
    maxWidth: CONTENT_W,
  });
  return bottom;
}

function drawKpis(page: Canvas, kpis: UsagePdfInput["kpis"], top: number): number {
  const columns = 4;
  const gap = 10;
  const height = 56;
  const width = (CONTENT_W - gap * (columns - 1)) / columns;
  kpis.forEach((kpi, index) => {
    const x = MARGIN + (index % columns) * (width + gap);
    const cardTop = top - Math.floor(index / columns) * (height + gap);
    page.roundedRect(x, cardTop - height, width, height, 6, index === 0 ? COLORS.accentSoft : COLORS.surface);
    page.text(kpi.label, x + 12, cardTop - 19, { size: 8, color: COLORS.muted, maxWidth: width - 24 });
    page.text(kpi.value, x + 12, cardTop - 41, {
      size: 15,
      font: "bold",
      maxWidth: width - 24,
      shrink: true,
    });
  });
  const rows = Math.ceil(kpis.length / columns);
  return top - rows * height - Math.max(0, rows - 1) * gap;
}

function drawDailyChart(page: Canvas, daily: UsagePdfInput["daily"], top: number): number {
  page.text(daily.heading, MARGIN, top - 12, { size: 11, font: "bold" });
  const plotTop = top - 32;
  const plotHeight = 110;
  const baseline = plotTop - plotHeight;
  const right = PAGE_W - MARGIN;
  const tickStyle = { size: 7.5, color: COLORS.muted } satisfies TextStyle;
  const values = daily.days.map((day) => Math.max(0, day.value));
  const max = Math.max(0, ...values);

  let left = MARGIN;
  let scaleTop = 0;
  if (max > 0) {
    const step = niceStep(max, 4);
    const count = Math.max(1, Math.ceil(max / step - 1e-9));
    scaleTop = step * count;
    const ticks = Array.from({ length: count + 1 }, (_, index) => ({
      value: step * index,
      label: daily.formatTick(step * index),
    }));
    left = MARGIN + Math.max(...ticks.map((tick) => page.textWidth(tick.label, tickStyle))) + 8;
    for (const tick of ticks) {
      const y = baseline + (tick.value / scaleTop) * plotHeight;
      if (tick.value > 0) page.line(left, y, right, y, COLORS.border, 0.5);
      page.text(tick.label, left - 8, y - 2.5, { ...tickStyle, align: "right" });
    }
  }

  const slot = (right - left) / Math.max(1, values.length);
  const barWidth = Math.min(18, slot * 0.68);
  values.forEach((value, index) => {
    if (value <= 0 || scaleTop <= 0) return;
    const height = Math.max(0.75, (value / scaleTop) * plotHeight);
    const radius = Math.min(3, barWidth / 2);
    page.roundedRect(left + index * slot + (slot - barWidth) / 2, baseline, barWidth, height, [0, 0, radius, radius], COLORS.accent);
  });
  page.line(left, baseline, right, baseline, COLORS.axis, 0.75);

  if (max <= 0) {
    page.text(daily.empty, (left + right) / 2, baseline + plotHeight / 2, {
      ...tickStyle,
      size: 9,
      align: "center",
    });
  }

  const labelCount = Math.min(values.length, 7);
  const indexes = new Set(
    Array.from({ length: labelCount }, (_, j) =>
      labelCount > 1 ? Math.round((j * (values.length - 1)) / (labelCount - 1)) : 0,
    ),
  );
  for (const index of indexes) {
    const label = daily.days[index]?.label ?? "";
    const width = page.textWidth(label, tickStyle);
    const center = left + index * slot + slot / 2;
    const x = Math.min(right - width, Math.max(left, center - width / 2));
    page.text(label, x, baseline - 12, tickStyle);
  }
  return baseline - 12;
}

function drawModelTable(page: Canvas, table: UsagePdfInput["byModel"], top: number) {
  page.text(table.heading, MARGIN, top - 12, { size: 11, font: "bold" });
  const rowHeight = 19;
  const right = PAGE_W - MARGIN;
  const col = {
    model: MARGIN + 10,
    share: MARGIN + 182,
    spend: MARGIN + 365,
    prompt: MARGIN + 440,
    completion: right - 10,
  };
  const shareBar = 64;
  const header = { size: 7.5, font: "bold", color: COLORS.muted } satisfies TextStyle;
  const cell = { size: 9 } satisfies TextStyle;

  let y = top - 24;
  page.roundedRect(MARGIN, y - rowHeight, CONTENT_W, rowHeight, 4, COLORS.surface);
  const headerBaseline = y - 12.5;
  page.text(table.columns.model, col.model, headerBaseline, header);
  page.text(table.columns.share, col.share, headerBaseline, header);
  page.text(table.columns.spend, col.spend, headerBaseline, { ...header, align: "right" });
  page.text(table.columns.prompt, col.prompt, headerBaseline, { ...header, align: "right" });
  page.text(table.columns.completion, col.completion, headerBaseline, { ...header, align: "right" });
  y -= rowHeight;

  if (table.rows.length === 0) {
    page.text(table.empty, MARGIN + CONTENT_W / 2, y - 24, { ...cell, color: COLORS.muted, align: "center" });
    return;
  }

  const fits = Math.max(0, Math.floor((y - FOOTER_RULE - 12) / rowHeight) - 1);
  for (const row of table.rows.slice(0, fits)) {
    const baseline = y - 12.5;
    page.text(row.name || "—", col.model, baseline, { ...cell, maxWidth: col.share - col.model - 16 });
    const share = Math.min(1, Math.max(0, row.share));
    page.roundedRect(col.share, baseline + 0.5, shareBar, 5, 2.5, COLORS.track);
    if (share > 0) page.roundedRect(col.share, baseline + 0.5, Math.max(2.5, shareBar * share), 5, 2.5, COLORS.accent);
    page.text(row.shareLabel, col.share + shareBar + 6, baseline, { size: 8, color: COLORS.muted });
    page.text(row.spend, col.spend, baseline, { ...cell, align: "right" });
    page.text(row.prompt, col.prompt, baseline, { ...cell, align: "right", color: COLORS.muted });
    page.text(row.completion, col.completion, baseline, { ...cell, align: "right", color: COLORS.muted });
    y -= rowHeight;
    page.line(MARGIN, y, right, y, COLORS.border, 0.5);
  }

  page.line(MARGIN, y, right, y, COLORS.ink, 0.75);
  const baseline = y - 12.5;
  const total = { ...cell, font: "bold" } satisfies TextStyle;
  page.text(table.total.name, col.model, baseline, total);
  page.text(table.total.spend, col.spend, baseline, { ...total, align: "right" });
  page.text(table.total.prompt, col.prompt, baseline, { ...total, align: "right" });
  page.text(table.total.completion, col.completion, baseline, { ...total, align: "right" });
}

function drawFooter(page: Canvas, input: UsagePdfInput) {
  page.line(MARGIN, FOOTER_RULE, PAGE_W - MARGIN, FOOTER_RULE, COLORS.border, 0.5);
  page.text(input.generated, MARGIN, FOOTER_RULE - 14, { size: 8, color: COLORS.muted });
  page.text(input.brand, PAGE_W - MARGIN, FOOTER_RULE - 14, {
    size: 8,
    font: "bold",
    color: COLORS.muted,
    align: "right",
  });
}

function pdfString(value: string): string {
  let out = "FEFF";
  for (let i = 0; i < value.length; i++) out += value.charCodeAt(i).toString(16).padStart(4, "0");
  return `<${out}>`;
}

export function usagePdf(input: UsagePdfInput): Uint8Array {
  const page = canvas();
  const headerBottom = drawHeader(page, input);
  const kpiBottom = drawKpis(page, input.kpis, headerBottom - 24);
  const chartBottom = drawDailyChart(page, input.daily, kpiBottom - 28);
  drawModelTable(page, input.byModel, chartBottom - 26);
  drawFooter(page, input);

  const stream = page.ops.join("\n") + "\n";
  const objects: string[] = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Contents 4 0 R /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> >>`,
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
    `<< /Title ${pdfString(input.title)} /Producer ${pdfString(input.brand)} >>`,
  ];
  const chunks: Buffer[] = [Buffer.from("%PDF-1.4\n")];
  const xref = [0];
  let offset = chunks[0]!.length;
  objects.forEach((body, i) => {
    const obj = `${i + 1} 0 obj\n${body}\nendobj\n`;
    xref.push(offset);
    const buf = Buffer.from(obj);
    chunks.push(buf);
    offset += buf.length;
  });
  const xrefStart = offset;
  let table = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i < xref.length; i++) {
    table += `${String(xref[i]).padStart(10, "0")} 00000 n \n`;
  }
  table += `trailer << /Size ${objects.length + 1} /Root 1 0 R /Info ${objects.length} 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  chunks.push(Buffer.from(table));
  return Buffer.concat(chunks);
}
