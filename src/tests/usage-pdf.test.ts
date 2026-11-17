import assert from "node:assert/strict";
import test from "node:test";
import { createFormatter, createTranslator, type Messages } from "next-intl";
import { formats } from "@/i18n/formats";
import { loadLocaleMessages } from "@/i18n/messages";
import { usagePdf, usageStatsPdf } from "@/lib/export/usage-pdf";
import { canvas, COLORS, drawHeader, drawHubMark } from "@/lib/export/pdf";
import { summarizeUsage, usageDays } from "@/lib/usage/usage-stats";
import { readPdf } from "./support/pdf-text";
import type { PdfColor, PdfTone, UsagePdfInput, UsagePdfTable } from "@/types/export";

function input(overrides: Partial<UsagePdfInput> = {}): UsagePdfInput {
  return {
    brand: "LLM Hub",
    title: "Nutzungsbericht",
    period: "Letzte 2 Tage · 5.–6. Okt. 2026",
    generated: "Erstellt am 6. Oktober 2026",
    kpis: [
      { label: "Ausgaben", value: "1,5000 €" },
      { label: "Anfragen", value: "12" },
    ],
    daily: {
      heading: "Tägliche Ausgaben",
      days: [
        { label: "5. Okt.", value: 0.5 },
        { label: "6. Okt.", value: 1 },
      ],
      formatTick: (value) => String(value),
      empty: "Keine Ausgaben",
    },
    byModel: {
      heading: "Ausgaben nach Modell",
      continued: "Ausgaben nach Modell (Fortsetzung)",
      columns: { model: "Modell", share: "Anteil", spend: "Ausgaben", prompt: "Prompt", completion: "Completion" },
      rows: [
        { name: "gpt", share: 1, shareLabel: "100 %", spend: "1,5000 €", prompt: "10", completion: "5" },
      ],
      total: { name: "Gesamt", spend: "1,5000 €", prompt: "10", completion: "5" },
      empty: "Keine Ausgaben",
    },
    ...overrides,
  };
}

function withModel(name: string, overrides: Partial<UsagePdfInput> = {}): UsagePdfInput {
  const base = input(overrides);
  return { ...base, byModel: { ...base.byModel, rows: [{ ...base.byModel.rows[0]!, name }] } };
}

const latin1 = (bytes: Uint8Array) => Buffer.from(bytes).toString("latin1");
const texts = (bytes: Uint8Array) => readPdf(bytes).texts.map((shown) => shown.text);

test("drawHubMark paints the current hub glyph, not the old H bars", () => {
  const page = canvas();
  drawHubMark(page, 0, 0, 24, [82, 82, 232]);
  const stream = page.ops.join("\n");
  assert.match(stream, /1 J 12 18\.5 m 12 11\.25 l S/);
  assert.match(stream, /15\.25 11\.25 m/);
  assert.doesNotMatch(stream, /6\.75 .* re f/);
});

test("usagePdf writes a structurally valid PDF with correct xref offsets", () => {
  const bytes = usagePdf(input());
  const pdf = latin1(bytes);
  assert.match(pdf, /^%PDF-1\.4\n/);
  assert.match(pdf, /%%EOF$/);
  const startxref = Number(pdf.match(/startxref\n(\d+)\n%%EOF$/)?.[1]);
  assert.equal(pdf.slice(startxref, startxref + 4), "xref");
  const size = Number(pdf.match(/trailer << \/Size (\d+)/)?.[1]);
  assert.equal(readPdf(bytes).objectCount, size - 1);
  assert.match(pdf, /\/Subtype \/Type0 \/BaseFont \/[A-Z]{6}\+Geist-Bold \/Encoding \/Identity-H/);
  assert.doesNotMatch(pdf, /WinAnsiEncoding|\/Helvetica/);
  assert.ok(texts(bytes).includes("Nutzungsbericht"));
  assert.ok(texts(bytes).includes("gpt"));
});

test("usagePdf keeps umlauts and the euro sign", () => {
  const shown = texts(usagePdf(input()));
  assert.ok(shown.includes("Tägliche Ausgaben"));
  assert.ok(shown.includes("1,5000 €"));
  assert.ok(shown.includes("Letzte 2 Tage · 5.–6. Okt. 2026"));
});

test("usagePdf renders names outside Latin-1 with real glyphs instead of question marks", () => {
  const name = "Ünïcødé 模型 Ελληνικά";
  const filter = "Модель: 한국어 日本語";
  const doc = readPdf(usagePdf(withModel(name, { details: [{ label: "Filter", value: filter }], title: "使用情况报告" })));
  for (const expected of [name, filter, "使用情况报告"]) {
    const shown = doc.texts.find((text) => text.text === expected);
    assert.ok(shown, `${expected} is extractable`);
    for (const run of shown.runs) {
      const font = doc.fonts.get(run.face)!;
      for (const glyph of run.glyphs) {
        assert.notEqual(glyph.code, 0, `${glyph.text} has a glyph`);
        assert.notEqual(glyph.text, "?");
        if (glyph.text.trim()) assert.ok(font.outlined.has(glyph.code), `${glyph.text} has an outline in ${run.face}`);
      }
    }
  }
  const faceOf = (char: string) =>
    doc.texts.flatMap((text) => text.runs).find((run) => run.glyphs.some((glyph) => glyph.text === char))?.face;
  assert.equal(faceOf("Ü"), "Geist-Regular");
  assert.equal(faceOf("ά"), "NotoSans-Regular");
  assert.equal(faceOf("模"), "NotoSansSC-Regular");
  assert.equal(faceOf("한"), "NotoSansKR-Regular");
});

test("usagePdf emboldens fallback faces that have no bold weight", () => {
  const doc = readPdf(usagePdf(input({ title: "Report 模型" })));
  const title = doc.texts.find((text) => text.text === "Report 模型")!;
  assert.deepEqual(
    title.runs.map((run) => [run.face, run.emboldened]),
    [
      ["Geist-Bold", false],
      ["NotoSansSC-Regular", true],
    ],
  );
});

test("usagePdf embeds only the glyphs it shows", () => {
  const bytes = usagePdf(withModel("模型"));
  const doc = readPdf(bytes);
  const cjk = doc.fonts.get("NotoSansSC-Regular")!;
  assert.match(cjk.baseFont, /^[A-Z]{6}\+NotoSansSC-Regular$/);
  assert.ok(cjk.glyphCount > 20_000);
  assert.ok(cjk.outlined.size <= 3);
  assert.ok(bytes.length < 60_000, `${bytes.length} bytes`);
});

test("usagePdf falls back to a question mark for characters no embedded font covers", () => {
  const shown = texts(usagePdf(withModel("model 🚀")));
  assert.ok(shown.includes("model ?"));
});

test("usagePdf truncates long model names with an ellipsis", () => {
  const name = "provider/an-exceptionally-long-model-deployment-name-that-cannot-fit";
  const shown = texts(usagePdf(withModel(name)));
  assert.ok(!shown.includes(name));
  const truncated = shown.find((text) => text.startsWith("provider/an-"));
  assert.ok(truncated?.endsWith("…"), String(truncated));
});

test("usagePdf puts the instance URL, edition, and page label on the letterhead", () => {
  const bytes = usagePdf(
    input({
      instance: "https://hub.example.com",
      edition: "v2026.11.15.abc1234",
      pageLabel: (page, total) => `Page ${page} of ${total}`,
    }),
  );
  const shown = texts(bytes);
  assert.ok(shown.includes("https://hub.example.com"));
  assert.ok(shown.includes("v2026.11.15.abc1234"));
  assert.ok(shown.includes("Page 1 of 1"));
  const pdf = latin1(bytes);
  assert.match(pdf, /\/Subtype \/Link \/Rect \[[^\]]+\] \/Border \[0 0 0\] \/A << \/Type \/Action \/S \/URI \/URI \(https:\/\/hub\.example\.com\) >>/);
  assert.match(pdf, /\/Subject <FEFF00680074007400700073/);
});

test("usagePdf renders empty periods without invalid numbers", () => {
  const base = input();
  const bytes = usagePdf({
    ...base,
    daily: { ...base.daily, days: base.daily.days.map((day) => ({ ...day, value: 0 })) },
    byModel: { ...base.byModel, rows: [] },
  });
  assert.doesNotMatch(latin1(bytes), /NaN|Infinity/);
  assert.ok(texts(bytes).includes("Keine Ausgaben"));
});

function rows(prefix: string, count: number): UsagePdfTable["rows"] {
  return Array.from({ length: count }, (_, index) => ({
    name: `${prefix}-${index + 1}`,
    share: 1 / count,
    shareLabel: "1 %",
    spend: "1,0000 €",
    prompt: "10",
    completion: "5",
  }));
}

function labelTable(count: number): UsagePdfTable {
  return {
    heading: "Ausgaben nach Label env",
    continued: "Ausgaben nach Label env (Fortsetzung)",
    columns: { model: "Wert", share: "Anteil", spend: "Ausgaben", prompt: "Prompt", completion: "Completion" },
    rows: rows("env", count),
    total: { name: "Summe Label", spend: "1,0000 €", prompt: "10", completion: "5" },
    empty: "Keine Ausgaben",
  };
}

const pageCount = (bytes: Uint8Array) =>
  Number(latin1(bytes).match(/\/Type \/Pages \/Kids \[[^\]]*\] \/Count (\d+)/)?.[1]);
const pageLabel = (page: number, total: number) => `Seite ${page} von ${total}`;

test("usagePdf keeps a small label table on the first page instead of a near-empty second page", () => {
  const bytes = usagePdf(input({ byLabel: [labelTable(2)], pageLabel }));
  assert.equal(pageCount(bytes), 1);
  const shown = texts(bytes);
  assert.ok(shown.includes("Ausgaben nach Label env"));
  assert.ok(shown.includes("env-2"));
  assert.ok(shown.includes("Seite 1 von 1"));
  assert.ok(!shown.includes("Ausgaben nach Label env (Fortsetzung)"));
});

test("usagePdf continues long tables across pages with repeated column headers and one total", () => {
  const base = input();
  const bytes = usagePdf({
    ...base,
    pageLabel,
    byModel: { ...base.byModel, rows: rows("model", 90) },
    byLabel: [labelTable(30)],
  });
  const pages = pageCount(bytes);
  assert.ok(pages >= 3, `${pages} pages`);
  const shown = texts(bytes);
  for (let index = 1; index <= 90; index++) assert.ok(shown.includes(`model-${index}`), `model-${index}`);
  for (let index = 1; index <= 30; index++) assert.ok(shown.includes(`env-${index}`), `env-${index}`);
  assert.equal(shown.filter((text) => text === "Gesamt").length, 1);
  assert.equal(shown.filter((text) => text === "Summe Label").length, 1);
  assert.ok(shown.indexOf("model-90") < shown.indexOf("Gesamt"));
  assert.ok(shown.includes("Ausgaben nach Modell (Fortsetzung)"));
  const headers = shown.filter((text) => text === "Modell").length + shown.filter((text) => text === "Wert").length;
  assert.ok(headers >= pages, `${headers} column headers on ${pages} pages`);
  assert.ok(shown.includes(`Seite ${pages} von ${pages}`));
  assert.ok(!shown.includes(`Seite ${pages + 1} von ${pages}`));
});

test("usagePdf never leaves a table total alone on a continuation page", () => {
  const counts = [...Array.from({ length: 22 }, (_, index) => index + 1), ...Array.from({ length: 10 }, (_, index) => index + 50)];
  for (const count of counts) {
    const base = input();
    const shown = texts(usagePdf({ ...base, byModel: { ...base.byModel, rows: rows("model", count) } }));
    const lastHeader = shown.lastIndexOf("Modell");
    const total = shown.indexOf("Gesamt");
    const rowsWithTotal = shown.slice(lastHeader, total).filter((text) => text.startsWith("model-")).length;
    assert.ok(rowsWithTotal >= Math.min(count, 2), `${count} rows leave ${rowsWithTotal} next to the total`);
  }
});

function chartInput(days: number): UsagePdfInput {
  const base = input();
  return {
    ...base,
    daily: {
      ...base.daily,
      days: Array.from({ length: days }, (_, index) => ({ label: `${index + 1}. Tag`, value: 1 + (index % 5) })),
    },
  };
}

test("usagePdf labels every bar of the daily chart when the dates fit", () => {
  for (const days of [1, 7, 14]) {
    const shown = texts(usagePdf(chartInput(days)));
    for (let index = 1; index <= days; index++) assert.ok(shown.includes(`${index}. Tag`), `${days} days: day ${index}`);
  }
});

test("usagePdf thins daily chart labels evenly and always labels the last day", () => {
  for (const days of [28, 30, 31, 60, 90, 120]) {
    const shown = texts(usagePdf(chartInput(days)));
    const labeled = Array.from({ length: days }, (_, index) => index + 1).filter((day) => shown.includes(`${day}. Tag`));
    assert.ok(labeled.includes(days), `${days} days: last day labeled`);
    assert.ok(labeled.length > 2 && labeled.length < days, `${days} days: ${labeled.length} labels`);
    const gaps = new Set(labeled.slice(1).map((day, index) => day - labeled[index]!));
    assert.equal(gaps.size, 1, `${days} days: even steps ${[...gaps].join(", ")}`);
  }
});

test("usageStatsPdf notes how many label values the capped label table shows", async () => {
  const messages = (await loadLocaleMessages("en")) as Messages;
  const now = new Date("2026-10-07T12:00:00Z");
  const t = createTranslator({ locale: "en", messages, formats, timeZone: "UTC", now, namespace: "Usage" });
  const format = createFormatter({ locale: "en", formats, timeZone: "UTC", now });
  const slice = (name: string, spend: number) => ({ name, spend, prompt: 10, completion: 5 });
  const values = Array.from({ length: 40 }, (_, index) => slice(`value-${index + 1}`, 40 - index));
  const bytes = usageStatsPdf({
    stats: {
      ...summarizeUsage([], usageDays(new Date("2026-10-01T00:00:00Z"), 7)),
      p95Latency: 0,
      byModel: [slice("gpt", 820)],
      chargeback: [],
      byLabel: [{ key: "env", rows: values }],
    },
    t,
    format,
    brand: "LLM Hub",
    period: "Last 7 days",
    generatedAt: now,
    dayDate: (day) => new Date(`${day}T00:00:00Z`),
  });
  const shown = texts(bytes);
  assert.ok(shown.includes("value-12"));
  assert.ok(!shown.includes("value-13"));
  assert.ok(shown.includes("Top 12 of 40 values by spend. The total includes all values."));
  assert.ok(shown.includes("$820.00"), shown.filter((text) => text.startsWith("$")).join(" | "));
});

const fillOf = (color: PdfColor) => `${color.map((channel) => Number((channel / 255).toFixed(2)).toString()).join(" ")} rg`;

test("drawHeader fills the badge pill with the tone color and keeps the accent for neutral badges", () => {
  const expected: Record<PdfTone, PdfColor> = {
    neutral: COLORS.accent,
    success: COLORS.success,
    warning: COLORS.warning,
    danger: COLORS.danger,
  };
  for (const [tone, color] of Object.entries(expected) as [PdfTone, PdfColor][]) {
    const page = canvas();
    drawHeader(page, { brand: "LLM Hub", title: "Request", subtitle: "gpt-5", badge: { label: "200 · OK", tone } });
    const pill = page.ops.filter((op) => / c .* h f$/.test(op)).at(-1);
    assert.ok(pill?.startsWith(fillOf(color)), `${tone}: ${pill}`);
  }
  const plain = canvas();
  drawHeader(plain, { brand: "LLM Hub", title: "Request", subtitle: "gpt-5", badge: { label: "Draft" } });
  assert.ok(plain.ops.filter((op) => / c .* h f$/.test(op)).at(-1)?.startsWith(fillOf(COLORS.accent)));
});

test("drawHeader moves content up when a header has no metadata line", () => {
  const header = { brand: "LLM Hub", title: "Usage report", subtitle: "Last 14 days" };
  const bare = drawHeader(canvas(), header);
  const detailed = drawHeader(canvas(), { ...header, details: [{ label: "Scope", value: "Acme" }] });
  const empty = drawHeader(canvas(), { ...header, details: [{ label: "Scope", value: "" }] });
  assert.ok(detailed < bare);
  assert.equal(empty, bare);
});

test("usageStatsPdf lists the scope and filters under the subtitle", async () => {
  const messages = (await loadLocaleMessages("en")) as Messages;
  const now = new Date("2026-10-07T12:00:00Z");
  const t = createTranslator({ locale: "en", messages, formats, timeZone: "UTC", now, namespace: "Usage" });
  const format = createFormatter({ locale: "en", formats, timeZone: "UTC", now });
  const scope = t("pdf.scope", { hasCompany: "yes", company: "Acme", own: "yes", user: "alice" });
  const bytes = usageStatsPdf({
    stats: {
      ...summarizeUsage([], usageDays(new Date("2026-10-01T00:00:00Z"), 7)),
      p95Latency: 0,
      byModel: [],
      chargeback: [],
      byLabel: [],
    },
    t,
    format,
    brand: "LLM Hub",
    period: "Last 7 days",
    scope,
    filter: "Model: gpt-5",
    generatedAt: now,
    dayDate: (day) => new Date(`${day}T00:00:00Z`),
  });
  const shown = texts(bytes);
  assert.equal(scope, "Acme · Console user alice");
  for (const expected of ["Scope", scope, "Filter", "Model: gpt-5"]) assert.ok(shown.includes(expected), expected);
  assert.ok(shown.indexOf("Last 7 days") < shown.indexOf("Scope"));
  assert.ok(shown.indexOf("Scope") < shown.indexOf("Filter"));
  assert.equal(t("pdf.scope", { hasCompany: "no", company: "", own: "no", user: "root" }), "All companies");
  assert.equal(t("pdf.scope", { hasCompany: "yes", company: "Acme", own: "no", user: "bob" }), "Acme");
  assert.equal(t("pdf.scope", { hasCompany: "no", company: "", own: "yes", user: "carol" }), "Console user carol");
});

test("usagePdf wraps a long scope onto a second line and truncates only beyond that", () => {
  const scope = "Acme Beteiligungsgesellschaft für Forschung und Entwicklung mbH · Konsolen-Benutzer maximiliane.mustermann-schmidt";
  const wrapped = texts(usagePdf(input({ details: [{ label: "Bereich", value: scope }, { label: "Filter", value: "Modell: gpt-5" }] })));
  const at = wrapped.indexOf("Bereich");
  assert.equal(`${wrapped[at + 1]} ${wrapped[at + 2]}`, scope);
  assert.equal(wrapped[at + 3], "Filter");

  const endless = Array.from({ length: 30 }, (_, index) => `Abteilung-${index + 1}`).join(" · ");
  const capped = texts(usagePdf(input({ details: [{ label: "Bereich", value: endless }] })));
  const from = capped.indexOf("Bereich");
  assert.ok(endless.startsWith(capped[from + 1]!));
  assert.ok(capped[from + 2]!.endsWith("…"), capped[from + 2]);
  assert.ok(!capped.some((text) => text.includes("Abteilung-30")));
});
