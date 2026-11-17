import "server-only";

import {
  canvas,
  COLORS,
  CONTENT_W,
  drawFooter,
  drawHeader,
  drawRunningHeader,
  FOOTER_RULE,
  MARGIN,
  PAGE_W,
  pdfDocument,
} from "./pdf";
import { unicodeTypeface } from "./pdf-unicode";
import type { PdfCanvas, PdfTextStyle, UsagePdfInput, UsagePdfStats, UsagePdfTable } from "@/types/export";
import type { Formatter, Translate } from "@/types/i18n";
import type { SliceRow } from "@/types/usage";

const ROW_HEIGHT = 19;
const LABEL_TABLE_ROWS = 12;
const SECTION_GAP = 22;
const TABLE_HEADING = 24;
const TABLE_EMPTY = 36;
const TABLE_NOTE = 16;
const TABLE_LEAD_ROWS = 3;
const TABLE_TAIL_ROWS = 2;
const CONTENT_BOTTOM = FOOTER_RULE + 12;
const DAY_LABEL_GAP = 6;
const TABLE_RIGHT = PAGE_W - MARGIN;
const TABLE_COLUMNS = {
  model: MARGIN + 10,
  share: MARGIN + 182,
  spend: MARGIN + 365,
  prompt: MARGIN + 440,
  completion: TABLE_RIGHT - 10,
};
const SHARE_BAR = 64;
const HEADER_CELL = { size: 7.5, font: "bold", color: COLORS.muted } satisfies PdfTextStyle;
const BODY_CELL = { size: 9 } satisfies PdfTextStyle;
const TOTAL_CELL = { ...BODY_CELL, font: "bold" } satisfies PdfTextStyle;

type PdfFlow = { page: PdfCanvas; top: number };

function niceStep(max: number, count: number): number {
  const raw = max / count;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  return ([1, 2, 2.5, 5, 10].find((factor) => factor * magnitude >= raw) ?? 10) * magnitude;
}

function drawKpis(page: PdfCanvas, kpis: UsagePdfInput["kpis"], top: number): number {
  const columns = 4;
  const gap = 10;
  const height = 56;
  const width = (CONTENT_W - gap * (columns - 1)) / columns;
  kpis.forEach((kpi, index) => {
    const x = MARGIN + (index % columns) * (width + gap);
    const cardTop = top - Math.floor(index / columns) * (height + gap);
    page.roundedRect(x, cardTop - height, width, height, 6, index === 0 ? COLORS.accentSoft : COLORS.surface);
    page.rect(x, cardTop - height + 10, 3, height - 20, index === 0 ? COLORS.accent : COLORS.accentRaised);
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

function drawDailyChart(page: PdfCanvas, daily: UsagePdfInput["daily"], top: number): number {
  const padX = 12;
  const plotHeight = 110;
  const plotTop = top - 36;
  const baseline = plotTop - plotHeight;
  const panelBottom = baseline - 20;
  page.roundedRect(MARGIN, panelBottom, CONTENT_W, top - panelBottom, 8, COLORS.surface);
  page.text(daily.heading, MARGIN + padX, top - 18, { size: 11, font: "bold" });
  const right = PAGE_W - MARGIN - padX;
  const tickStyle = { size: 7.5, color: COLORS.muted } satisfies PdfTextStyle;
  const values = daily.days.map((day) => Math.max(0, day.value));
  const max = Math.max(0, ...values);

  let left = MARGIN + padX;
  let scaleTop = 0;
  if (max > 0) {
    const step = niceStep(max, 4);
    const count = Math.max(1, Math.ceil(max / step - 1e-9));
    scaleTop = step * count;
    const ticks = Array.from({ length: count + 1 }, (_, index) => ({
      value: step * index,
      label: daily.formatTick(step * index),
    }));
    left = MARGIN + padX + Math.max(...ticks.map((tick) => page.textWidth(tick.label, tickStyle))) + 8;
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

  const labels = daily.days.map((day, index) => {
    const width = page.textWidth(day.label, tickStyle);
    const center = left + index * slot + slot / 2;
    return { text: day.label, x: Math.min(right - width, Math.max(left, center - width / 2)), width };
  });
  for (const index of dayLabelIndexes(labels)) {
    const label = labels[index]!;
    page.text(label.text, label.x, baseline - 12, tickStyle);
  }
  return panelBottom;
}

function nextDayLabelStep(step: number): number {
  if (step < 3) return step + 1;
  return step < 7 ? 7 : step + 7;
}

function dayLabelIndexes(labels: { x: number; width: number }[]): number[] {
  const last = labels.length - 1;
  if (last < 0) return [];
  for (let step = 1; step <= last; step = nextDayLabelStep(step)) {
    const indexes: number[] = [];
    for (let index = last; index >= 0; index -= step) indexes.unshift(index);
    const apart = indexes.every((index, at) => {
      if (at === 0) return true;
      const previous = labels[indexes[at - 1]!]!;
      return previous.x + previous.width + DAY_LABEL_GAP <= labels[index]!.x;
    });
    if (apart) return indexes;
  }
  return [last];
}

function drawTableHead(page: PdfCanvas, table: UsagePdfTable, heading: string, top: number): number {
  page.text(heading, MARGIN, top - 12, { size: 11, font: "bold", maxWidth: CONTENT_W });
  const y = top - TABLE_HEADING;
  page.roundedRect(MARGIN, y - ROW_HEIGHT, CONTENT_W, ROW_HEIGHT, 4, COLORS.surface);
  const baseline = y - 12.5;
  page.text(table.columns.model, TABLE_COLUMNS.model, baseline, HEADER_CELL);
  page.text(table.columns.share, TABLE_COLUMNS.share, baseline, HEADER_CELL);
  page.text(table.columns.spend, TABLE_COLUMNS.spend, baseline, { ...HEADER_CELL, align: "right" });
  page.text(table.columns.prompt, TABLE_COLUMNS.prompt, baseline, { ...HEADER_CELL, align: "right" });
  page.text(table.columns.completion, TABLE_COLUMNS.completion, baseline, { ...HEADER_CELL, align: "right" });
  page.rect(MARGIN + 8, y - ROW_HEIGHT + 0.6, CONTENT_W - 16, 1.5, COLORS.accent);
  return y - ROW_HEIGHT;
}

function drawTableRow(page: PdfCanvas, row: UsagePdfTable["rows"][number], y: number): number {
  const col = TABLE_COLUMNS;
  const baseline = y - 12.5;
  page.text(row.name || "—", col.model, baseline, { ...BODY_CELL, maxWidth: col.share - col.model - 16 });
  const share = Math.min(1, Math.max(0, row.share));
  page.roundedRect(col.share, baseline + 0.5, SHARE_BAR, 5, 2.5, COLORS.track);
  if (share > 0) page.roundedRect(col.share, baseline + 0.5, Math.max(2.5, SHARE_BAR * share), 5, 2.5, COLORS.accent);
  page.text(row.shareLabel, col.share + SHARE_BAR + 6, baseline, { size: 8, color: COLORS.muted });
  page.text(row.spend, col.spend, baseline, { ...BODY_CELL, align: "right" });
  page.text(row.prompt, col.prompt, baseline, { ...BODY_CELL, align: "right", color: COLORS.muted });
  page.text(row.completion, col.completion, baseline, { ...BODY_CELL, align: "right", color: COLORS.muted });
  page.line(MARGIN, y - ROW_HEIGHT, TABLE_RIGHT, y - ROW_HEIGHT, COLORS.border, 0.5);
  return y - ROW_HEIGHT;
}

function drawTableTotal(page: PdfCanvas, table: UsagePdfTable, y: number): number {
  const col = TABLE_COLUMNS;
  page.line(MARGIN, y, TABLE_RIGHT, y, COLORS.ink, 0.75);
  const baseline = y - 12.5;
  page.text(table.total.name, col.model, baseline, TOTAL_CELL);
  page.text(table.total.spend, col.spend, baseline, { ...TOTAL_CELL, align: "right" });
  page.text(table.total.prompt, col.prompt, baseline, { ...TOTAL_CELL, align: "right" });
  page.text(table.total.completion, col.completion, baseline, { ...TOTAL_CELL, align: "right" });
  const bottom = y - ROW_HEIGHT;
  if (!table.note) return bottom;
  page.text(table.note, col.model, bottom - 12, { size: 8, color: COLORS.muted, maxWidth: CONTENT_W - 20 });
  return bottom - TABLE_NOTE;
}

function drawSpendTable(flow: PdfFlow, table: UsagePdfTable, nextPage: () => PdfFlow): PdfFlow {
  let { page, top } = flow;
  if (table.rows.length === 0) {
    if (top - TABLE_HEADING - ROW_HEIGHT - TABLE_EMPTY < CONTENT_BOTTOM) ({ page, top } = nextPage());
    const y = drawTableHead(page, table, table.heading, top);
    page.text(table.empty, MARGIN + CONTENT_W / 2, y - 24, { ...BODY_CELL, color: COLORS.muted, align: "center" });
    return { page, top: y - TABLE_EMPTY };
  }

  const tail = ROW_HEIGHT + (table.note ? TABLE_NOTE : 0);
  let heading = table.heading;
  let drawn = 0;
  let fresh = false;
  for (;;) {
    const room = top - TABLE_HEADING - ROW_HEIGHT - CONTENT_BOTTOM;
    const remaining = table.rows.length - drawn;
    const finishes = remaining * ROW_HEIGHT + tail <= room;
    const fitting = Math.min(Math.floor(room / ROW_HEIGHT), remaining - TABLE_TAIL_ROWS);
    if (!finishes && !fresh && fitting < TABLE_LEAD_ROWS) {
      ({ page, top } = nextPage());
      fresh = true;
      continue;
    }
    const take = finishes ? remaining : Math.max(1, fitting);
    let y = drawTableHead(page, table, heading, top);
    for (const row of table.rows.slice(drawn, drawn + take)) y = drawTableRow(page, row, y);
    drawn += take;
    if (finishes) return { page, top: drawTableTotal(page, table, y) };
    ({ page, top } = nextPage());
    fresh = true;
    heading = table.continued;
  }
}

export function usagePdf(input: UsagePdfInput): Uint8Array {
  const page = canvas(unicodeTypeface);
  const headerBottom = drawHeader(page, {
    brand: input.brand,
    title: input.title,
    subtitle: input.period,
    details: input.details,
    instance: input.instance,
  });
  const kpiBottom = drawKpis(page, input.kpis, headerBottom);
  const chartBottom = drawDailyChart(page, input.daily, kpiBottom - SECTION_GAP);
  const pages = [page];
  const nextPage = (): PdfFlow => {
    const next = canvas(unicodeTypeface);
    pages.push(next);
    return { page: next, top: drawRunningHeader(next, { brand: input.brand, detail: `${input.title} · ${input.period}` }) };
  };
  let flow = drawSpendTable({ page, top: chartBottom - SECTION_GAP }, input.byModel, nextPage);
  for (const table of input.byLabel ?? []) {
    flow = drawSpendTable({ page: flow.page, top: flow.top - SECTION_GAP }, table, nextPage);
  }
  pages.forEach((each, index) =>
    drawFooter(each, {
      left: input.generated,
      center: input.pageLabel?.(index + 1, pages.length),
      right: input.brand,
      instance: input.instance,
      edition: input.edition,
    }),
  );
  return pdfDocument(pages, { title: input.title, producer: input.brand, subject: input.instance });
}

function spendTable(
  input: { heading: string; first: string; rows: SliceRow[]; shown: number; name: (row: SliceRow) => string },
  stats: UsagePdfStats,
  t: Translate,
  format: Formatter,
): UsagePdfTable {
  const totals = input.rows.reduce(
    (sum, row) => ({
      spend: sum.spend + row.spend,
      prompt: sum.prompt + row.prompt,
      completion: sum.completion + row.completion,
    }),
    { spend: 0, prompt: 0, completion: 0 },
  );
  return {
    heading: input.heading,
    continued: t("pdf.continued", { heading: input.heading }),
    ...(input.rows.length > input.shown
      ? { note: t("pdf.topValues", { shown: input.shown, total: input.rows.length }) }
      : {}),
    columns: {
      model: input.first,
      share: t("pdf.colShare"),
      spend: t("pdf.colSpend"),
      prompt: t("pdf.colPrompt"),
      completion: t("pdf.colCompletion"),
    },
    rows: input.rows.slice(0, input.shown).map((row) => {
      const share = stats.spend > 0 ? row.spend / stats.spend : 0;
      return {
        name: input.name(row),
        share,
        shareLabel: format.number(share, "percent"),
        spend: format.number(row.spend, "money"),
        prompt: format.number(row.prompt, "integer"),
        completion: format.number(row.completion, "integer"),
      };
    }),
    total: {
      name: t("pdf.total"),
      spend: format.number(totals.spend, "money"),
      prompt: format.number(totals.prompt, "integer"),
      completion: format.number(totals.completion, "integer"),
    },
    empty: t("pdf.noSpend"),
  };
}

export function usageStatsPdf(input: {
  stats: UsagePdfStats;
  t: Translate;
  format: Formatter;
  brand: string;
  period: string;
  scope?: string;
  filter?: string;
  instance?: string;
  edition?: string;
  generatedAt: Date;
  dayDate: (day: string) => Date;
}): Uint8Array {
  const { stats, t, format } = input;
  const totals = stats.chargeback.reduce(
    (sum, row) => ({ prompt: sum.prompt + row.prompt, completion: sum.completion + row.completion }),
    { prompt: 0, completion: 0 },
  );
  return usagePdf({
    brand: input.brand,
    title: t("pdf.title"),
    period: input.period,
    details: [
      { label: t("pdf.scopeLabel"), value: input.scope ?? "" },
      { label: t("pdf.filterLabel"), value: input.filter ?? "" },
    ],
    instance: input.instance,
    edition: input.edition,
    pageLabel: (page, total) => t("pdf.page", { page, total }),
    generated: t("pdf.generated", { at: input.generatedAt }),
    kpis: [
      { label: t("metrics.spend"), value: format.number(stats.spend, "money") },
      { label: t("metrics.requests"), value: format.number(stats.count, "integer") },
      { label: t("metrics.tokens"), value: format.number(stats.tokens, "integer") },
      {
        label: t("successRate"),
        value: format.number(stats.count > 0 ? (stats.count - stats.errors) / stats.count : 0, "percent"),
      },
      { label: t("metrics.errors"), value: format.number(stats.errors, "integer") },
      { label: t("metrics.rate429"), value: format.number(stats.rate429, "integer") },
      { label: t("metrics.latency"), value: t("latencyValue", { ms: Math.round(stats.latency) }) },
      { label: t("metrics.p95"), value: t("latencyValue", { ms: Math.round(stats.p95Latency) }) },
    ],
    daily: {
      heading: t("charts.dailySpend"),
      days: stats.daily.map((day) => ({
        label: format.dateTime(input.dayDate(day.day), "utcDay"),
        value: day.spend,
      })),
      formatTick: (value) => format.number(value, "axis"),
      empty: t("pdf.noSpend"),
    },
    byModel: {
      ...spendTable(
        {
          heading: t("pdf.byModel"),
          first: t("pdf.colModel"),
          rows: stats.byModel,
          shown: stats.byModel.length,
          name: (row) => row.name,
        },
        stats,
        t,
        format,
      ),
      total: {
        name: t("pdf.total"),
        spend: format.number(stats.spend, "money"),
        prompt: format.number(totals.prompt, "integer"),
        completion: format.number(totals.completion, "integer"),
      },
    },
    byLabel: (stats.byLabel ?? []).map((group) =>
      spendTable(
        {
          heading: t("pdf.byLabel", { key: group.key }),
          first: t("pdf.colLabelValue"),
          rows: group.rows,
          shown: LABEL_TABLE_ROWS,
          name: (row) => row.name || t("labels.none"),
        },
        stats,
        t,
        format,
      ),
    ),
  });
}
