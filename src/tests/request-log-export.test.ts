import assert from "node:assert/strict";
import test from "node:test";
import { requestLogMarkdown } from "@/lib/export/request-log-markdown";
import { requestLogPdf } from "@/lib/export/request-log-pdf";
import { COLORS } from "@/lib/export/pdf";
import { requestStatusTone } from "@/lib/gateway/request-logs/request-status";
import { readPdf } from "./support/pdf-text";
import type { RequestLogDocument } from "@/types/logs";

function doc(overrides: Partial<RequestLogDocument["content"]> = {}): RequestLogDocument {
  return {
    brand: "LLM Hub",
    title: "Anfragedetails",
    subtitle: "gpt-4o · 6. Okt. 2026, 12:10:05 UTC",
    status: "200 · OK",
    statusTone: "success",
    generated: "Erstellt am 6. Okt. 2026, 12:11:00 UTC",
    error: null,
    fields: [
      { label: "Anfrage-ID", value: "log_123", mono: true },
      { label: "Modell", value: "gpt_4o*mini" },
    ],
    privacy: {
      heading: "Datenschutz",
      fields: [{ label: "Prompt-Filter", value: "Vor dem Modell maskiert" }],
      note: "Gespeicherte Inhalte sind maskiert.",
    },
    content: {
      heading: "Inhalt",
      notice: "",
      truncated: "",
      conversation: "Verlauf",
      empty: "Kein lesbarer Text.",
      input: [
        {
          role: "Benutzer",
          assistant: false,
          heading: "",
          kind: "text",
          text: "# Überschrift\n\nSchreib an [EMAIL_ADDRESS] und **fett** mit `code`.\n\n- eins\n- zwei\n\n| A | B |\n| --- | ---: |\n| 1 | 2 |",
        },
      ],
      output: [
        {
          role: "Assistent",
          assistant: true,
          heading: "",
          kind: "text",
          text: "```ts\nconst answer = 42;\n```",
        },
        {
          role: "Assistent",
          assistant: true,
          heading: "Tool-Aufruf lookup",
          kind: "tool_call",
          text: '{"query":"```"}',
        },
      ],
      payloads: [
        { heading: "Anfrage-JSON", json: '{\n  "model": "gpt-4o"\n}' },
        { heading: "Antwort-JSON", json: "" },
      ],
      noJson: "Nichts gespeichert.",
      ...overrides,
    },
    piiLabel: (entity) => (entity === "EMAIL_ADDRESS" ? "E-Mail" : entity),
    pageLabel: (page, total) => `Seite ${page} von ${total}`,
  };
}

const latin1 = (bytes: Uint8Array) => Buffer.from(bytes).toString("latin1");
const texts = (bytes: Uint8Array) => readPdf(bytes).texts.map((shown) => shown.text);

function assertValidPdf(pdf: string) {
  assert.match(pdf, /^%PDF-1\.4\n/);
  assert.match(pdf, /%%EOF$/);
  const startxref = Number(pdf.match(/startxref\n(\d+)\n%%EOF$/)?.[1]);
  assert.equal(pdf.slice(startxref, startxref + 4), "xref");
  const offsets = [...pdf.matchAll(/^(\d{10}) 00000 n $/gm)].map((match) => Number(match[1]));
  offsets.forEach((offset, index) => {
    assert.ok(pdf.startsWith(`${index + 1} 0 obj\n`, offset), `object ${index + 1} offset`);
  });
  assert.doesNotMatch(pdf, /NaN|Infinity/);
}

test("requestLogPdf renders markdown with fonts, PII labels, and valid offsets", () => {
  const bytes = requestLogPdf(doc());
  const pdf = latin1(bytes);
  assertValidPdf(pdf);
  assert.match(pdf, /\/Subtype \/Type0 \/BaseFont \/[A-Z]{6}\+GeistMono-Regular \/Encoding \/Identity-H/);
  assert.match(pdf, /\/Subtype \/Type0 \/BaseFont \/[A-Z]{6}\+Geist-Bold \/Encoding \/Identity-H/);
  assert.doesNotMatch(pdf, /WinAnsiEncoding|\/Helvetica|\/Courier/);
  const shown = texts(bytes);
  for (const expected of ["Überschrift", "E-Mail", "const answer = 42;", "Nichts gespeichert.", "Seite 1 von 1"]) {
    assert.ok(shown.includes(expected), expected);
  }
  assert.ok(!shown.some((text) => text.includes("[EMAIL_ADDRESS]")));
});

test("requestLogPdf renders any script, italics, and code with real glyphs", () => {
  const cjk = "你好世界";
  const cyrillic = "Привет мир";
  const bytes = requestLogPdf(
    doc({
      input: [
        {
          role: "Benutzer",
          assistant: false,
          heading: "",
          kind: "text",
          text: `${cjk} ${cyrillic} Ελληνικά 안녕하세요 → ok\n\n*kursiv 斜体 Курсив* und ***fett 粗体***\n\n\`\`\`\nconst 名前 = "Привет";\n\`\`\``,
        },
      ],
      output: [],
    }),
  );
  const pdf = readPdf(bytes);
  const plain = `${cjk} ${cyrillic} Ελληνικά 안녕하세요 → ok`;
  const code = 'const 名前 = "Привет";';
  const shownText = (expected: string) => {
    const shown = pdf.texts.find((text) => text.text === expected);
    assert.ok(shown, `${expected} is extractable`);
    return shown;
  };
  for (const expected of [plain, "kursiv 斜体 Курсив", "fett 粗体", code]) {
    for (const run of shownText(expected).runs) {
      const font = pdf.fonts.get(run.face)!;
      for (const glyph of run.glyphs) {
        assert.notEqual(glyph.code, 0, `${glyph.text} has a glyph`);
        assert.notEqual(glyph.text, "?");
        if (glyph.text.trim()) assert.ok(font.outlined.has(glyph.code), `${glyph.text} has an outline in ${run.face}`);
      }
    }
  }
  const runsOf = (expected: string) =>
    shownText(expected).runs.map((run) => [
      run.glyphs.map((glyph) => glyph.text).join(""),
      run.face,
      run.oblique,
      run.emboldened,
    ]);
  const faceOf = (expected: string, char: string) =>
    shownText(expected).runs.find((run) => run.glyphs.some((glyph) => glyph.text === char))?.face;
  assert.deepEqual(
    ["你", "П", "η", "안", "→"].map((char) => faceOf(plain, char)),
    ["NotoSansSC-Regular", "Geist-Regular", "NotoSans-Regular", "NotoSansKR-Regular", "Geist-Regular"],
  );
  assert.deepEqual(runsOf("kursiv 斜体 Курсив"), [
    ["kursiv ", "Geist-Italic", false, false],
    ["斜体", "NotoSansSC-Regular", true, false],
    [" Курсив", "Geist-Italic", false, false],
  ]);
  assert.deepEqual(runsOf("fett 粗体"), [
    ["fett ", "Geist-BoldItalic", false, false],
    ["粗体", "NotoSansSC-Regular", true, true],
  ]);
  assert.deepEqual(runsOf(code).map(([, face]) => face), [
    "GeistMono-Regular",
    "NotoSansSC-Regular",
    "GeistMono-Regular",
  ]);
  assert.ok(bytes.length < 80_000, `${bytes.length} bytes`);
});

test("requestLogPdf flows long transcripts onto numbered pages", () => {
  const paragraph = "Ein langer Absatz mit vielen Wörtern, der umbrechen muss. ".repeat(40);
  const longWord = "x".repeat(4000);
  const base = doc();
  const bytes = requestLogPdf({
    ...base,
    content: {
      ...base.content,
      input: Array.from({ length: 12 }, () => ({
        role: "Benutzer",
        assistant: false,
        heading: "",
        kind: "text" as const,
        text: `${paragraph}\n\n${longWord}`,
      })),
    },
  });
  const pdf = latin1(bytes);
  assertValidPdf(pdf);
  const count = Number(pdf.match(/\/Type \/Pages \/Kids \[[^\]]*\] \/Count (\d+)/)?.[1]);
  assert.ok(count > 2, `expected several pages, got ${count}`);
  assert.equal([...pdf.matchAll(/\/Type \/Page \/Parent/g)].length, count);
  assert.ok(texts(bytes).includes(`Seite ${count} von ${count}`));
});

test("requestLogPdf shows the notice instead of the conversation when content is missing", () => {
  const bytes = requestLogPdf(doc({ notice: "Keine Inhalte gespeichert.", input: [], output: [] }));
  assertValidPdf(latin1(bytes));
  assert.ok(texts(bytes).includes("Keine Inhalte gespeichert."));
  assert.ok(!texts(bytes).includes("Verlauf"));
});

test("request exports name the instance and link it from the PDF", () => {
  const source = doc();
  const sourced = { ...source, instance: "https://hub.example.com", edition: "v2026.11.15.abc1234" };
  const bytes = requestLogPdf(sourced);
  const pdf = latin1(bytes);
  assertValidPdf(pdf);
  assert.ok(texts(bytes).includes("https://hub.example.com"));
  assert.ok(texts(bytes).includes("v2026.11.15.abc1234"));
  assert.match(pdf, /\/URI \(https:\/\/hub\.example\.com\)/);
  const md = requestLogMarkdown(sourced);
  assert.ok(md.includes("https://hub.example.com\n"));
  assert.ok(md.endsWith("_Erstellt am 6. Okt. 2026, 12:11:00 UTC · https://hub.example.com · v2026.11.15.abc1234 · LLM Hub_\n"));
});

test("requestLogMarkdown keeps content, escapes fields, and fences code safely", () => {
  const md = requestLogMarkdown(doc());
  assert.match(md, /^# Anfragedetails\n/);
  assert.ok(md.includes("- **Anfrage-ID:** `log_123`"));
  assert.ok(md.includes("- **Modell:** gpt\\_4o\\*mini"));
  assert.ok(md.includes("Schreib an [EMAIL_ADDRESS] und **fett**"));
  assert.ok(md.includes('#### Assistent · Tool-Aufruf lookup\n\n````json\n{"query":"```"}\n````'));
  assert.ok(md.includes("### Antwort-JSON\n\n_Nichts gespeichert._"));
  assert.ok(md.endsWith("_Erstellt am 6. Okt. 2026, 12:11:00 UTC · LLM Hub_\n"));
});

test("requestLogMarkdown quotes reasoning and replaces the conversation with the notice", () => {
  const base = doc();
  const withReasoning = requestLogMarkdown({
    ...base,
    content: {
      ...base.content,
      output: [{ role: "Assistent", assistant: true, heading: "Denkprozess", kind: "reasoning", text: "erst A\n\ndann B" }],
    },
  });
  assert.ok(withReasoning.includes("#### Assistent · Denkprozess\n\n> erst A\n>\n> dann B"));

  const missing = requestLogMarkdown(doc({ notice: "Keine Inhalte gespeichert.", input: [], output: [] }));
  assert.ok(missing.includes("## Inhalt\n\nKeine Inhalte gespeichert."));
  assert.ok(!missing.includes("### Verlauf"));
});

test("requestStatusTone marks server errors as danger, client errors as warning, and the rest as success", () => {
  assert.deepEqual(
    [200, 201, 304, 399, 400, 404, 429, 499, 500, 503].map(requestStatusTone),
    ["success", "success", "success", "success", "warning", "warning", "warning", "warning", "danger", "danger"],
  );
});

test("requestLogPdf colors the status pill by its tone", () => {
  const fill = (color: readonly number[]) => `${color.map((channel) => Number((channel / 255).toFixed(2)).toString()).join(" ")} rg`;
  const pills = (statusTone: RequestLogDocument["statusTone"]) =>
    latin1(requestLogPdf({ ...doc(), status: "status", statusTone }))
      .split("\n")
      .filter((op) => / c .* h f$/.test(op));
  for (const [tone, color, others] of [
    ["success", COLORS.success, [COLORS.warning, COLORS.danger]],
    ["warning", COLORS.warning, [COLORS.success, COLORS.danger]],
    ["danger", COLORS.danger, [COLORS.success, COLORS.warning]],
  ] as const) {
    const filled = pills(tone);
    assert.ok(filled.some((op) => op.startsWith(fill(color))), tone);
    for (const other of others) assert.ok(!filled.some((op) => op.startsWith(fill(other))), `${tone} without ${fill(other)}`);
  }
});
