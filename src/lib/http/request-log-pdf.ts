import "server-only";

import type { List, PhrasingContent, RootContent, Table } from "mdast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { splitPiiPlaceholders } from "@/lib/gateway/pii";
import type { RequestLogDocument, RequestLogDocumentEntry, RequestLogDocumentField } from "@/types/logs";
import {
  canvas,
  type Canvas,
  COLORS,
  CONTENT_W,
  drawFooter,
  drawHeader,
  type Font,
  FOOTER_RULE,
  MARGIN,
  PAGE_H,
  pdfDocument,
  type Rgb,
  textWidth,
} from "./pdf";

type Style = { font: Font; size: number; color: Rgb };
type Run = Style & { text: string; fill?: Rgb; strike?: boolean };
type Segment = Run & { width: number };
type Line = { segments: Segment[]; width: number };
type Frame = { x: number; width: number; color: Rgb; bars: number[] };
type Draw = (page: Canvas, top: number) => void;

const BODY = 9.5;
const LEADING = 13.6;
const MONO = 7.6;
const MONO_LEADING = 10.2;
const HEADING_SIZES = [13, 12, 11, 10.5, 10, 10];
const INDENT = 14;
const CHIP_PAD = 3;
const CELL_PAD = 5;
const MAX_CELL_LINES = 40;
const MAX_FIELD_LINES = 4;
const FIELD_COLUMNS = 3;
const FIELD_GAP = 12;
const BOTTOM = FOOTER_RULE + 14;
const CONTINUED_TOP = PAGE_H - MARGIN - 18;
const BASELINE = 0.72;
const FIT_TOLERANCE = 0.01;

const markdown = unified().use(remarkParse).use(remarkGfm);

const italic = (font: Font): Font => (font === "bold" ? "boldItalic" : font === "regular" ? "italic" : font);
const bold = (font: Font): Font => (font === "italic" ? "boldItalic" : font === "regular" ? "bold" : font);

function clean(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, "    ")
    .replace(/[\p{Cc}\p{Cf}\uFE0E\uFE0F]/gu, (char) => (char === "\n" ? char : ""));
}

function sameStyle(a: Segment, b: Run): boolean {
  return (
    !a.fill && !b.fill && a.font === b.font && a.size === b.size && a.color === b.color && a.strike === b.strike
  );
}

function wrap(runs: Run[], width: number): Line[] {
  const lines: Line[] = [];
  let segments: Segment[] = [];
  let used = 0;
  let space: Segment | null = null;

  const flush = () => {
    lines.push({ segments, width: used });
    segments = [];
    used = 0;
    space = null;
  };
  const push = (segment: Segment) => {
    const last = segments.at(-1);
    if (last && sameStyle(last, segment)) {
      last.text += segment.text;
      last.width += segment.width;
    } else {
      segments.push({ ...segment });
    }
    used += segment.width;
  };
  const place = (segment: Segment) => {
    const gap = space?.width ?? 0;
    if (segments.length && used + gap + segment.width > width + FIT_TOLERANCE) flush();
    else if (space && segments.length) push(space);
    space = null;
    if (segment.fill || used + segment.width <= width + FIT_TOLERANCE) {
      push(segment);
      return;
    }
    let piece = "";
    let pieceWidth = 0;
    for (const char of segment.text) {
      const charWidth = textWidth(char, segment);
      if (piece && used + pieceWidth + charWidth > width + FIT_TOLERANCE) {
        push({ ...segment, text: piece, width: pieceWidth });
        flush();
        piece = "";
        pieceWidth = 0;
      }
      piece += char;
      pieceWidth += charWidth;
    }
    if (piece) push({ ...segment, text: piece, width: pieceWidth });
  };

  for (const run of runs) {
    if (run.fill) {
      place({ ...run, width: textWidth(run.text, run) + CHIP_PAD * 2 });
      continue;
    }
    for (const token of run.text.split(/(\n| +)/)) {
      if (!token) continue;
      if (token === "\n") flush();
      else if (token.startsWith(" ")) space = segments.length ? { ...run, text: " ", width: textWidth(" ", run) } : null;
      else place({ ...run, text: token, width: textWidth(token, run) });
    }
  }
  if (segments.length || lines.length === 0) flush();
  return lines;
}

function drawLine(page: Canvas, line: Line, x: number, baseline: number) {
  let cursor = x;
  for (const segment of line.segments) {
    const style = { size: segment.size, font: segment.font, color: segment.color };
    if (segment.fill) {
      page.roundedRect(cursor, baseline - segment.size * 0.32, segment.width, segment.size * 1.3, 2.5, segment.fill);
      page.text(segment.text, cursor + CHIP_PAD, baseline, style);
    } else {
      page.text(segment.text, cursor, baseline, style);
    }
    if (segment.strike) {
      const middle = baseline + segment.size * 0.3;
      page.line(cursor, middle, cursor + segment.width, middle, segment.color, 0.6);
    }
    cursor += segment.width;
  }
}

function codeLines(value: string, perLine: number): string[] {
  const out: string[] = [];
  for (const line of clean(value).replace(/\n+$/, "").split("\n")) {
    const chars = Array.from(line);
    if (chars.length === 0) out.push("");
    for (let i = 0; i < chars.length; i += perLine) out.push(chars.slice(i, i + perLine).join(""));
  }
  return out;
}

function columnWidths(natural: number[], total: number): number[] {
  const share = total / natural.length;
  const base = natural.map((width) => Math.min(width, share));
  const deficit = natural.map((width, index) => width - base[index]!);
  const missing = deficit.reduce((sum, value) => sum + value, 0);
  const rest = total - base.reduce((sum, value) => sum + value, 0);
  if (missing <= 0) return base;
  return base.map((width, index) => width + Math.min(deficit[index]!, (rest * deficit[index]!) / missing));
}

export function requestLogPdf(doc: RequestLogDocument): Uint8Array {
  const pages: Canvas[] = [];
  let page = canvas();
  pages.push(page);
  let y = drawHeader(page, { brand: doc.brand, title: doc.title, subtitle: doc.subtitle, badge: doc.status }) - 22;
  let pageTop = y;
  let marker: Draw | null = null;
  const root: Frame = { x: MARGIN, width: CONTENT_W, color: COLORS.ink, bars: [] };

  function newPage() {
    page = canvas();
    pages.push(page);
    page.text(`${doc.title} · ${doc.subtitle}`, MARGIN, PAGE_H - MARGIN + 4, {
      size: 8,
      color: COLORS.muted,
      maxWidth: CONTENT_W,
    });
    page.line(MARGIN, PAGE_H - MARGIN - 4, MARGIN + CONTENT_W, PAGE_H - MARGIN - 4, COLORS.border, 0.5);
    y = CONTINUED_TOP;
    pageTop = y;
  }

  function need(height: number) {
    if (y - height < BOTTOM && y < pageTop) newPage();
  }

  function row(height: number, draw: Draw, frame: Frame = root) {
    need(height);
    const top = y;
    for (const x of frame.bars) page.rect(x, top - height, 2, height, COLORS.border);
    draw(page, top);
    if (marker) {
      marker(page, top);
      marker = null;
    }
    y -= height;
  }

  function gap(height: number) {
    if (y < pageTop) y -= height;
  }

  function textRuns(value: string, style: Style): Run[] {
    return splitPiiPlaceholders(clean(value)).map((part) =>
      part.entity
        ? {
            text: doc.piiLabel(part.entity),
            font: "bold",
            size: style.size * 0.85,
            color: COLORS.warning,
            fill: COLORS.warningSoft,
          }
        : { ...style, text: part.text },
    );
  }

  function inline(nodes: PhrasingContent[], style: Style): Run[] {
    const out: Run[] = [];
    for (const node of nodes) {
      switch (node.type) {
        case "text":
          out.push(...textRuns(node.value.replace(/\n/g, " "), style));
          break;
        case "emphasis":
          out.push(...inline(node.children, { ...style, font: italic(style.font) }));
          break;
        case "strong":
          out.push(...inline(node.children, { ...style, font: bold(style.font) }));
          break;
        case "delete":
          out.push(...inline(node.children, { ...style, color: COLORS.muted }).map((run) => ({ ...run, strike: true })));
          break;
        case "inlineCode":
          out.push({ ...style, font: "mono", size: style.size * 0.92, text: clean(node.value).replace(/\n/g, " ") });
          break;
        case "link": {
          const label = inline(node.children, { ...style, color: COLORS.accent });
          out.push(...label);
          if (/^https?:\/\//i.test(node.url) && label.map((run) => run.text).join("") !== node.url) {
            out.push({ ...style, color: COLORS.muted, text: ` (${node.url})` });
          }
          break;
        }
        case "linkReference":
          out.push(...inline(node.children, { ...style, color: COLORS.accent }));
          break;
        case "image":
          out.push({ ...style, font: italic(style.font), color: COLORS.muted, text: `[${node.alt || node.url}]` });
          break;
        case "imageReference":
          out.push({ ...style, font: italic(style.font), color: COLORS.muted, text: `[${node.alt || node.label || ""}]` });
          break;
        case "break":
          out.push({ ...style, text: "\n" });
          break;
        case "html":
          out.push(...textRuns(node.value, style));
          break;
        case "footnoteReference":
          out.push({ ...style, size: style.size * 0.8, text: `[^${node.label ?? node.identifier}]` });
          break;
      }
    }
    return out;
  }

  function paragraph(runs: Run[], frame: Frame, leading = LEADING) {
    for (const line of wrap(runs, frame.width)) {
      row(leading, (target, top) => drawLine(target, line, frame.x, top - leading * BASELINE), frame);
    }
  }

  function boxed(runs: Run[], fill: Rgb, frame: Frame = root) {
    const pad = 7;
    const lines = wrap(runs, frame.width - pad * 2);
    lines.forEach((line, index) => {
      const first = index === 0;
      const last = index === lines.length - 1;
      const height = LEADING + (first ? pad : 0) + (last ? pad : 0);
      row(
        height,
        (target, top) => {
          target.rect(frame.x, top - height, frame.width, height + (first ? 0 : 0.5), fill);
          drawLine(target, line, frame.x + pad, top - (first ? pad : 0) - LEADING * BASELINE);
        },
        frame,
      );
    });
  }

  function codeBlock(value: string, frame: Frame) {
    const pad = 6;
    const perLine = Math.max(8, Math.floor((frame.width - pad * 2) / (MONO * 0.6)));
    const lines = codeLines(value, perLine);
    lines.forEach((text, index) => {
      const first = index === 0;
      const last = index === lines.length - 1;
      const height = MONO_LEADING + (first ? pad : 0) + (last ? pad : 0);
      row(
        height,
        (target, top) => {
          target.rect(frame.x, top - height, frame.width, height + (first ? 0 : 0.5), COLORS.surface);
          if (text) {
            target.text(text, frame.x + pad, top - (first ? pad : 0) - MONO_LEADING * 0.75, {
              size: MONO,
              font: "mono",
              color: COLORS.ink,
            });
          }
        },
        frame,
      );
    });
  }

  function list(node: List, frame: Frame) {
    const start = node.start ?? 1;
    const style = { size: BODY, font: "regular", color: frame.color } satisfies Style;
    const widest = node.ordered ? textWidth(`${start + node.children.length - 1}.`, style) + 6 : 0;
    const indent = Math.max(INDENT, widest);
    node.children.forEach((item, index) => {
      if (index) gap(node.spread ? 5 : 2);
      const label =
        item.checked === true ? "[x]" : item.checked === false ? "[ ]" : node.ordered ? `${start + index}.` : "•";
      const inner = { ...frame, x: frame.x + indent, width: frame.width - indent };
      marker = (target, top) => target.text(label, frame.x, top - LEADING * BASELINE, style);
      if (item.children.length) blocks(item.children, inner);
      else row(LEADING, () => undefined, frame);
      marker = null;
    });
  }

  function table(node: Table, frame: Frame) {
    const columns = Math.max(1, ...node.children.map((tableRow) => tableRow.children.length));
    const size = BODY - 1;
    const leading = LEADING - 1.5;
    const cells = node.children.map((tableRow, rowIndex) =>
      Array.from({ length: columns }, (_, column) =>
        inline(tableRow.children[column]?.children ?? [], {
          size,
          font: rowIndex === 0 ? "bold" : "regular",
          color: frame.color,
        }),
      ),
    );
    const natural = Array.from({ length: columns }, (_, column) =>
      Math.max(
        24,
        ...cells.map((runs) => runs[column]!.reduce((sum, run) => sum + textWidth(run.text, run), 0)),
      ) + CELL_PAD * 2,
    );
    const widths = columnWidths(natural, frame.width);
    cells.forEach((tableRow, rowIndex) => {
      const wrapped = tableRow.map((runs, column) =>
        wrap(runs, widths[column]! - CELL_PAD * 2).slice(0, MAX_CELL_LINES),
      );
      const height = Math.max(...wrapped.map((lines) => lines.length)) * leading + CELL_PAD;
      row(
        height,
        (target, top) => {
          if (rowIndex === 0) target.rect(frame.x, top - height, frame.width, height, COLORS.surface);
          let x = frame.x;
          wrapped.forEach((lines, column) => {
            const width = widths[column]!;
            const align = node.align?.[column];
            lines.forEach((line, index) => {
              const free = width - CELL_PAD * 2 - line.width;
              const offset = align === "right" ? free : align === "center" ? free / 2 : 0;
              drawLine(target, line, x + CELL_PAD + offset, top - CELL_PAD / 2 - index * leading - leading * BASELINE);
            });
            x += width;
          });
          target.line(frame.x, top - height, frame.x + frame.width, top - height, COLORS.border, 0.5);
        },
        frame,
      );
    });
  }

  function block(node: RootContent, frame: Frame) {
    const style = { size: BODY, font: "regular", color: frame.color } satisfies Style;
    switch (node.type) {
      case "paragraph":
        paragraph(inline(node.children, style), frame);
        return;
      case "heading": {
        const size = HEADING_SIZES[node.depth - 1] ?? BODY;
        need(size * 1.45 + LEADING);
        paragraph(inline(node.children, { ...style, size, font: "bold" }), frame, size * 1.45);
        return;
      }
      case "code":
        codeBlock(node.value, frame);
        return;
      case "blockquote":
        blocks(node.children, {
          x: frame.x + 10,
          width: frame.width - 10,
          color: COLORS.muted,
          bars: [...frame.bars, frame.x],
        });
        return;
      case "list":
        list(node, frame);
        return;
      case "table":
        table(node, frame);
        return;
      case "thematicBreak":
        row(10, (target, top) => target.line(frame.x, top - 5, frame.x + frame.width, top - 5, COLORS.border), frame);
        return;
      case "html":
        paragraph(textRuns(node.value, { ...style, color: COLORS.muted }), frame);
        return;
      case "footnoteDefinition":
        marker = (target, top) => target.text(`[^${node.label ?? node.identifier}]`, frame.x, top - LEADING * BASELINE, {
          ...style,
          size: BODY - 2,
          color: COLORS.muted,
        });
        blocks(node.children, { ...frame, x: frame.x + INDENT * 2, width: frame.width - INDENT * 2 });
        marker = null;
        return;
      case "definition":
        return;
      default:
        if ("children" in node) blocks(node.children as RootContent[], frame);
        else if ("value" in node) paragraph(textRuns(String(node.value), style), frame);
    }
  }

  function blocks(nodes: RootContent[], frame: Frame) {
    nodes.forEach((node, index) => {
      if (index) gap(6);
      block(node, frame);
    });
  }

  function heading(text: string, size: number) {
    gap(size > 11 ? 18 : 12);
    need(size * 1.6 + LEADING * 2);
    row(size * 1.6, (target, top) => {
      target.text(text, MARGIN, top - size * 1.6 * BASELINE, { size, font: "bold", maxWidth: CONTENT_W });
      if (size > 11) target.line(MARGIN, top - size * 1.6 - 2, MARGIN + CONTENT_W, top - size * 1.6 - 2, COLORS.border, 0.5);
    });
    gap(size > 11 ? 8 : 4);
  }

  function fieldGrid(fields: RequestLogDocumentField[]) {
    const width = (CONTENT_W - FIELD_GAP * (FIELD_COLUMNS - 1)) / FIELD_COLUMNS;
    const valueLeading = 11.5;
    for (let start = 0; start < fields.length; start += FIELD_COLUMNS) {
      const cells = fields.slice(start, start + FIELD_COLUMNS).map((field) => ({
        label: field.label,
        lines: wrap(
          textRuns(field.value, field.mono ? { size: 7.8, font: "mono", color: COLORS.ink } : { size: 9, font: "regular", color: COLORS.ink }),
          width,
        ).slice(0, MAX_FIELD_LINES),
      }));
      const height = 12 + Math.max(...cells.map((cell) => cell.lines.length)) * valueLeading + 8;
      row(height, (target, top) => {
        cells.forEach((cell, index) => {
          const x = MARGIN + index * (width + FIELD_GAP);
          target.text(cell.label, x, top - 8, { size: 7.5, color: COLORS.muted, maxWidth: width });
          cell.lines.forEach((line, lineIndex) => drawLine(target, line, x, top - 21 - lineIndex * valueLeading));
        });
      });
    }
  }

  function entry(item: RequestLogDocumentEntry, frame: Frame) {
    need(18 + LEADING * 2);
    row(18, (target, top) => {
      const chip = { size: 7.5, font: "bold", color: COLORS.ink } satisfies Style;
      const width = target.textWidth(item.role, chip) + 12;
      target.roundedRect(MARGIN, top - 14, width, 13, 6.5, item.assistant ? COLORS.accentSoft : COLORS.surface);
      target.text(item.role, MARGIN + 6, top - 10, chip);
      if (item.heading) {
        target.text(item.heading, MARGIN + width + 6, top - 10, {
          size: 8,
          color: COLORS.muted,
          maxWidth: CONTENT_W - width - 6,
        });
      }
    });
    gap(3);
    const muted = { ...frame, color: COLORS.muted };
    if (item.kind === "media") paragraph(textRuns(item.text, { size: BODY, font: "italic", color: COLORS.muted }), frame);
    else if (item.kind === "tool_call" || item.kind === "tool_result") codeBlock(item.text, frame);
    else blocks(markdown.parse(clean(item.text)).children, item.kind === "reasoning" ? muted : frame);
  }

  if (doc.error) {
    boxed(
      [
        { size: BODY, font: "bold", color: COLORS.danger, text: `${doc.error.label}: ` },
        ...textRuns(doc.error.text, { size: BODY, font: "regular", color: COLORS.danger }),
      ],
      COLORS.dangerSoft,
    );
    gap(14);
  }
  fieldGrid(doc.fields);

  heading(doc.privacy.heading, 12);
  fieldGrid(doc.privacy.fields);
  if (doc.privacy.note) paragraph(textRuns(doc.privacy.note, { size: 8.5, font: "regular", color: COLORS.muted }), root);

  heading(doc.content.heading, 12);
  if (doc.content.truncated) {
    boxed(textRuns(doc.content.truncated, { size: BODY, font: "regular", color: COLORS.warning }), COLORS.warningSoft);
    gap(10);
  }
  if (doc.content.notice) {
    boxed(textRuns(doc.content.notice, { size: BODY, font: "regular", color: COLORS.ink }), COLORS.surface);
  } else {
    heading(doc.content.conversation, 10.5);
    const { input, output } = doc.content;
    if (!input.length && !output.length) {
      paragraph(textRuns(doc.content.empty, { size: BODY, font: "regular", color: COLORS.muted }), root);
    }
    input.forEach((item, index) => {
      if (index) gap(12);
      entry(item, root);
    });
    if (input.length && output.length) {
      gap(8);
      row(10, (target, top) => target.line(MARGIN, top - 5, MARGIN + CONTENT_W, top - 5, COLORS.border, 0.75));
      gap(8);
    }
    output.forEach((item, index) => {
      if (index) gap(12);
      entry(item, root);
    });
    for (const payload of doc.content.payloads) {
      heading(payload.heading, 10.5);
      if (payload.json) codeBlock(payload.json, root);
      else paragraph(textRuns(doc.content.noJson, { size: BODY, font: "regular", color: COLORS.muted }), root);
    }
  }

  pages.forEach((target, index) => {
    drawFooter(target, { left: doc.generated, center: doc.pageLabel(index + 1, pages.length), right: doc.brand });
  });
  return pdfDocument(pages, { title: `${doc.title} · ${doc.subtitle}`, producer: doc.brand });
}
