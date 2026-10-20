import assert from "node:assert/strict";
import test from "node:test";
import { usagePdf } from "@/lib/export/usage-pdf";
import { readPdf } from "./support/pdf-text";
import type { UsagePdfInput } from "@/types/export";

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
  const doc = readPdf(usagePdf(withModel(name, { filter, title: "使用情况报告" })));
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
  assert.ok(truncated?.endsWith("…"), truncated);
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
