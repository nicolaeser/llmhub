import assert from "node:assert/strict";
import test from "node:test";
import { type UsagePdfInput, usagePdf } from "@/lib/http/usage-pdf";

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

const latin1 = (bytes: Uint8Array) => Buffer.from(bytes).toString("latin1");
const winAnsiHex = (value: string) => Buffer.from(value, "latin1").toString("hex");

test("usagePdf writes a structurally valid PDF with correct xref offsets", () => {
  const pdf = latin1(usagePdf(input()));
  assert.match(pdf, /^%PDF-1\.4\n/);
  assert.match(pdf, /%%EOF$/);
  const startxref = Number(pdf.match(/startxref\n(\d+)\n%%EOF$/)?.[1]);
  assert.equal(pdf.slice(startxref, startxref + 4), "xref");
  const offsets = [...pdf.matchAll(/^(\d{10}) 00000 n $/gm)].map((match) => Number(match[1]));
  assert.equal(offsets.length, 7);
  offsets.forEach((offset, index) => {
    assert.ok(pdf.startsWith(`${index + 1} 0 obj\n`, offset), `object ${index + 1} offset`);
  });
  assert.match(pdf, /\/BaseFont \/Helvetica-Bold \/Encoding \/WinAnsiEncoding/);
  assert.ok(pdf.includes(`<${winAnsiHex("Nutzungsbericht")}>`));
  assert.ok(pdf.includes(`<${winAnsiHex("gpt")}>`));
});

test("usagePdf encodes umlauts and the euro sign as WinAnsi", () => {
  const pdf = latin1(usagePdf(input()));
  assert.ok(pdf.includes(`<${winAnsiHex("Tägliche Ausgaben")}>`));
  assert.ok(pdf.includes(`<${winAnsiHex("1,5000 ")}80>`));
});

test("usagePdf truncates long model names with an ellipsis", () => {
  const name = "provider/an-exceptionally-long-model-deployment-name-that-cannot-fit";
  const base = input();
  const pdf = latin1(
    usagePdf({ ...base, byModel: { ...base.byModel, rows: [{ ...base.byModel.rows[0]!, name }] } }),
  );
  assert.ok(!pdf.includes(winAnsiHex(name)));
  assert.match(pdf, new RegExp(`<${winAnsiHex("provider/an-")}[0-9a-f]*85>`));
});

test("usagePdf renders empty periods without invalid numbers", () => {
  const base = input();
  const pdf = latin1(
    usagePdf({
      ...base,
      daily: { ...base.daily, days: base.daily.days.map((day) => ({ ...day, value: 0 })) },
      byModel: { ...base.byModel, rows: [] },
    }),
  );
  assert.doesNotMatch(pdf, /NaN|Infinity/);
  assert.ok(pdf.includes(`<${winAnsiHex("Keine Ausgaben")}>`));
});
