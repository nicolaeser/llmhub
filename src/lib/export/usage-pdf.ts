import "server-only";

import {
  canvas,
  COLORS,
  CONTENT_W,
  drawFooter,
  drawHeader,
  FOOTER_RULE,
  MARGIN,
  PAGE_H,
  PAGE_W,
  pdfDocument,
} from "./pdf";
import { unicodeTypeface } from "./pdf-unicode";
import type { PdfCanvas, PdfTextStyle, UsagePdfInput, UsagePdfStats, UsagePdfTable } from "@/types/export";
import type { Formatter, Translate } from "@/types/i18n";
import type { SliceRow } from "@/types/usage";

const ROW_HEIGHT = 19;
const LABEL_TABLE_ROWS = 12;
const TABLE_GAP = 28;

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
  page.text(daily.heading, MARGIN, top - 12, { size: 11, font: "bold" });
  const plotTop = top - 32;
  const plotHeight = 110;
  const baseline = plotTop - plotHeight;
  const right = PAGE_W - MARGIN;
  const tickStyle = { size: 7.5, color: COLORS.muted } satisfies PdfTextStyle;
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

function tableHeight(table: UsagePdfTable): number {
  return 24 + ROW_HEIGHT * (Math.max(1, table.rows.length) + 2);
}

function drawSpendTable(page: PdfCanvas, table: UsagePdfTable, top: number): number {
  page.text(table.heading, MARGIN, top - 12, { size: 11, font: "bold", maxWidth: CONTENT_W });
  const rowHeight = ROW_HEIGHT;
  const right = PAGE_W - MARGIN;
  const col = {
    model: MARGIN + 10,
    share: MARGIN + 182,
    spend: MARGIN + 365,
    prompt: MARGIN + 440,
    completion: right - 10,
  };
  const shareBar = 64;
  const header = { size: 7.5, font: "bold", color: COLORS.muted } satisfies PdfTextStyle;
  const cell = { size: 9 } satisfies PdfTextStyle;

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
    return y - 36;
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
  const total = { ...cell, font: "bold" } satisfies PdfTextStyle;
  page.text(table.total.name, col.model, baseline, total);
  page.text(table.total.spend, col.spend, baseline, { ...total, align: "right" });
  page.text(table.total.prompt, col.prompt, baseline, { ...total, align: "right" });
  page.text(table.total.completion, col.completion, baseline, { ...total, align: "right" });
  return y - rowHeight;
}

export function usagePdf(input: UsagePdfInput): Uint8Array {
  const page = canvas(unicodeTypeface);
  const headerBottom = drawHeader(page, {
    brand: input.brand,
    title: input.title,
    subtitle: input.period,
    badge: input.filter,
  });
  const kpiBottom = drawKpis(page, input.kpis, headerBottom - 24);
  const chartBottom = drawDailyChart(page, input.daily, kpiBottom - 28);
  drawSpendTable(page, input.byModel, chartBottom - 26);
  const pages = [page];
  let top = 0;
  for (const table of input.byLabel ?? []) {
    if (pages.length === 1 || top - tableHeight(table) < FOOTER_RULE + 12) {
      pages.push(canvas(unicodeTypeface));
      top = PAGE_H - MARGIN;
    }
    top = drawSpendTable(pages.at(-1)!, table, top) - TABLE_GAP;
  }
  for (const each of pages) drawFooter(each, { left: input.generated, right: input.brand });
  return pdfDocument(pages, { title: input.title, producer: input.brand });
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
  filter?: string;
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
    filter: input.filter,
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
